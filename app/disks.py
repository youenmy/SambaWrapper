"""Disk discovery and mount/unmount via lsblk + mount/umount."""
import json
import os
import re
from pathlib import Path
from .config import MOUNT_ROOT
from .shell import run, sudo
from . import db

SAFE_MOUNT_NAME = re.compile(r"^[A-Za-z0-9_.-]{1,32}$")
MOUNTABLE_FS = {"ntfs", "ntfs3", "exfat", "vfat", "ext2", "ext3", "ext4", "xfs", "btrfs"}
FOREIGN_FS = {"ntfs", "ntfs3", "exfat", "vfat"}  # ownership synthesised from mount opts
NATIVE_FS = {"ext2", "ext3", "ext4", "xfs", "btrfs"}  # ownership stored on-disk

# The service runs as its own unprivileged user; we mount foreign disks owned by it
# so plain file operations (create/delete/rename) work without sudo.
SERVICE_UID = os.getuid()
SERVICE_GID = os.getgid()

def _lsblk() -> list[dict]:
    r = run([
        "lsblk", "-J", "-b", "-o",
        "NAME,KNAME,PATH,SIZE,TYPE,FSTYPE,LABEL,UUID,MOUNTPOINT,TRAN,MODEL,VENDOR,RO,HOTPLUG",
    ])
    if not r.ok:
        return []
    return json.loads(r.stdout).get("blockdevices", [])

def _flatten(node: dict, parent_tran: str | None = None) -> list[dict]:
    out = [{**node, "tran": node.get("tran") or parent_tran}]
    for child in node.get("children") or []:
        out.extend(_flatten(child, parent_tran=node.get("tran") or parent_tran))
    return out

def list_partitions() -> list[dict]:
    """Return partitions (and disks without partition table) suitable for mounting."""
    result = []
    for top in _lsblk():
        flat = _flatten(top)
        for n in flat:
            ntype = n.get("type")
            fstype = n.get("fstype")
            if ntype not in ("part", "disk"):
                continue
            # Skip whole-disks that have child partitions
            if ntype == "disk" and any(c.get("type") == "part" for c in (n.get("children") or [])):
                continue
            if not fstype:
                continue
            size = int(n.get("size") or 0)
            result.append({
                "path": n["path"],
                "kname": n["kname"],
                "size_bytes": size,
                "size_human": _human(size),
                "fstype": fstype,
                "label": n.get("label"),
                "uuid": n.get("uuid"),
                "mountpoint": n.get("mountpoint"),
                "tran": n.get("tran"),
                "model": (n.get("model") or "").strip() or None,
                "vendor": (n.get("vendor") or "").strip() or None,
                "ro": bool(n.get("ro")),
                "hotplug": bool(n.get("hotplug")),
                "mountable": fstype in MOUNTABLE_FS,
            })
    # enrich with stored auto-mount preference (by partition UUID)
    for part in result:
        pref = db.get_mount_pref(part["uuid"]) if part.get("uuid") else None
        part["auto_mount"] = bool(pref and pref["auto_mount"])
        part["saved_mount_name"] = pref["mount_name"] if pref else None
    return result

def _human(n: int) -> str:
    units = ["B", "KB", "MB", "GB", "TB", "PB"]
    f = float(n); i = 0
    while f >= 1024 and i < len(units) - 1:
        f /= 1024; i += 1
    return f"{f:.1f} {units[i]}" if i else f"{int(f)} {units[i]}"

def suggest_mount_name(part: dict) -> str:
    base = part.get("label") or part.get("model") or part["kname"]
    base = re.sub(r"[^A-Za-z0-9_.-]+", "_", base).strip("_")
    return base[:32] or part["kname"]

def mount_partition(path: str, mount_name: str, fstype: str) -> tuple[bool, str]:
    if not SAFE_MOUNT_NAME.match(mount_name):
        return False, "Имя точки монтирования: только A-Z a-z 0-9 _ . - (до 32 символов)"
    target = MOUNT_ROOT / mount_name
    target_str = str(target)
    if not target_str.startswith(str(MOUNT_ROOT) + "/") and target_str != str(MOUNT_ROOT):
        return False, "Подозрительный путь"
    sudo(["mkdir", "-p", target_str])
    opts = _mount_options(fstype)
    argv = ["mount"]
    if opts:
        argv += ["-o", opts]
    # let kernel detect fstype, except for NTFS where we want ntfs3 explicitly
    if fstype in ("ntfs", "ntfs3"):
        argv += ["-t", "ntfs3"]
    argv += [path, target_str]
    r = sudo(argv)
    if not r.ok:
        # Fallback: ntfs-3g (FUSE) if kernel ntfs3 refused (dirty journal, etc.)
        if fstype in ("ntfs", "ntfs3"):
            r2 = sudo(["mount", "-t", "ntfs-3g", "-o",
                       f"uid={SERVICE_UID},gid={SERVICE_GID},umask=0022,big_writes", path, target_str])
            if r2.ok:
                return True, target_str
            return False, (r.stderr.strip() + " / ntfs-3g: " + r2.stderr.strip())
        return False, r.stderr.strip() or f"mount failed (rc={r.rc})"
    # Native filesystems store ownership on disk — hand the mount root to the
    # service user so it can manage files without root.
    if fstype in NATIVE_FS:
        sudo(["chown", f"{SERVICE_UID}:{SERVICE_GID}", target_str])
    return True, target_str

def _mount_options(fstype: str) -> str:
    if fstype in FOREIGN_FS:
        return f"uid={SERVICE_UID},gid={SERVICE_GID},umask=0022"
    return ""

def unmount(mount_point: str) -> tuple[bool, str]:
    target_str = str(Path(mount_point).resolve())
    if not target_str.startswith(str(MOUNT_ROOT) + "/"):
        return False, "Можно отмонтировать только то, что в /mnt/sambawrapper"
    r = sudo(["umount", target_str])
    if not r.ok:
        return False, r.stderr.strip() or f"umount failed (rc={r.rc})"
    # cleanup empty mount dir
    sudo(["rmdir", target_str])
    return True, ""

def remember_mount(part: dict, mount_name: str, auto_mount: bool) -> None:
    if part.get("uuid"):
        db.upsert_mount_pref(part["uuid"], part.get("label"), mount_name, auto_mount)

def _mounts_under_root() -> list[tuple[str, str]]:
    """(device, mountpoint) for everything mounted under MOUNT_ROOT, from /proc/mounts."""
    out, root = [], str(MOUNT_ROOT)
    try:
        with open("/proc/mounts") as f:
            for line in f:
                cols = line.split()
                if len(cols) >= 2 and cols[1].startswith(root + "/"):
                    out.append((cols[0], cols[1]))
    except OSError:
        pass
    return out

def list_stale_mounts() -> list[dict]:
    """Mountpoints under MOUNT_ROOT whose backing device is gone (I/O error)."""
    live = {p["mountpoint"] for p in list_partitions() if p.get("mountpoint")}
    stale = []
    root = str(MOUNT_ROOT)
    for dev, mp in _mounts_under_root():
        if mp in live:
            continue
        stale.append({"device": dev, "mountpoint": mp, "name": mp[len(root) + 1:]})
    return stale

def clean_stale(mountpoint: str) -> tuple[bool, str]:
    mp = str(Path(mountpoint))
    if not mp.startswith(str(MOUNT_ROOT) + "/"):
        return False, "Путь вне разрешённой зоны"
    if mp in {p["mountpoint"] for p in list_partitions() if p.get("mountpoint")}:
        return False, "Это рабочий маунт, а не зависший"
    r = sudo(["umount", "-l", mp])  # lazy — backing device may be gone
    if not r.ok and "not mounted" not in (r.stderr or "").lower():
        return False, r.stderr.strip() or "не удалось отмонтировать"
    sudo(["rmdir", mp])
    return True, ""

def clean_all_stale() -> tuple[int, list[str]]:
    cleaned, errors = 0, []
    for s in list_stale_mounts():
        ok, msg = clean_stale(s["mountpoint"])
        if ok:
            cleaned += 1
        else:
            errors.append(f"{s['name']}: {msg}")
    return cleaned, errors

SAFE_LABEL = re.compile(r"[^A-Za-z0-9 _-]")

def _safe_label(label: str) -> str:
    return SAFE_LABEL.sub("", (label or "").strip())[:11]

def format_partition(device: str, fstype: str, label: str, confirm: str) -> tuple[bool, str]:
    """Reformat a *removable* partition. Destroys all data on it.

    Safety: only USB / hot-plug disks may be formatted (the system disk is on a
    non-removable bus, so it can never be a target). The caller must echo the
    partition's kname as confirmation.
    """
    if fstype not in ("ext4", "exfat", "ntfs"):
        return False, "Неподдерживаемая файловая система"
    part = {p["path"]: p for p in list_partitions()}.get(device)
    if not part:
        return False, "Раздел не найден (форматирование поддерживается для существующих разделов)"
    if confirm.strip() != part["kname"]:
        return False, f"Подтверждение не совпало — введите «{part['kname']}»"
    if not (part.get("tran") == "usb" or part.get("hotplug")):
        return False, "Форматировать можно только съёмные/USB-накопители — системные диски защищены"
    # if it's mounted by us, unmount first; refuse if mounted system-side
    if part.get("mountpoint"):
        if part["mountpoint"].startswith(str(MOUNT_ROOT) + "/"):
            ok, msg = unmount(part["mountpoint"])
            if not ok:
                return False, f"Не удалось отмонтировать перед форматированием: {msg}"
        else:
            return False, "Раздел смонтирован системно — форматирование запрещено"
    label = _safe_label(label)
    sudo(["wipefs", "-a", device])  # clear old fs signatures
    if fstype == "ext4":
        argv = ["mkfs.ext4", "-F"]
    elif fstype == "ntfs":
        argv = ["mkfs.ntfs", "-Q", "-F"]
    else:  # exfat
        argv = ["mkfs.exfat"]
    if label:
        argv += ["-L", label]
    argv += [device]
    r = sudo(argv, timeout=600)
    if not r.ok:
        return False, ((r.stderr or r.stdout).strip()[:300] or f"mkfs завершился с ошибкой (rc={r.rc})")
    # old UUID is gone; drop any stale auto-mount preference
    if part.get("uuid"):
        try:
            with db.connect() as cx:
                cx.execute("DELETE FROM mount_prefs WHERE uuid=?", (part["uuid"],))
        except Exception:
            pass
    return True, f"{device} отформатирован в {fstype}"

def set_auto_mount(uuid: str, label: str | None, mount_name: str, enabled: bool) -> tuple[bool, str]:
    """Enable/disable auto-mount for a partition, keyed by its UUID."""
    if not uuid:
        return False, "У раздела нет UUID — автомонтирование недоступно"
    if not SAFE_MOUNT_NAME.match(mount_name or ""):
        return False, "Некорректное имя точки монтирования"
    db.upsert_mount_pref(uuid, label, mount_name, enabled)
    return True, ""

def auto_mount_known() -> list[str]:
    """Mount any remembered auto-mount partitions that are present but not mounted.

    Called on service startup (covers reboots) and periodically (covers hot-plug).
    A foreign disk that was never marked is ignored; the same disk returns to its
    saved mount point because the pref is keyed by the stable partition UUID.
    """
    msgs: list[str] = []
    for part in list_partitions():
        if not part.get("uuid") or part.get("mountpoint") or not part.get("auto_mount"):
            continue
        name = part.get("saved_mount_name") or suggest_mount_name(part)
        ok, res = mount_partition(part["path"], name, part["fstype"])
        msgs.append(f"automount {part['path']} -> {res}" if ok
                    else f"automount {part['path']} FAILED: {res}")
    return msgs
