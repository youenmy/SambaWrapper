"""Samba share & user management.

Each share is its own file in SAMBA_CONF_DIR (/etc/samba/smb.conf.d/sambawrapper-<name>.conf).
On the host smb.conf we expect a single line: `include = /etc/samba/smb.conf.d/sambawrapper-all.conf`
which itself includes every sambawrapper-*.conf (rebuilt on changes).
"""
import re
import os
import pwd
from pathlib import Path
from .config import SAMBA_CONF_DIR, MOUNT_ROOT
from .shell import sudo, run

SAFE_SHARE_NAME = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
AGGREGATE_NAME = "sambawrapper-all.conf"
# Disks are mounted owned by this (service) user, so Samba writes go through it too.
SERVICE_USER = pwd.getpwuid(os.getuid()).pw_name

def list_shares() -> list[dict]:
    out = []
    if not SAMBA_CONF_DIR.exists():
        return out
    for p in sorted(SAMBA_CONF_DIR.glob("sambawrapper-*.conf")):
        if p.name == AGGREGATE_NAME:
            continue
        share = _parse_share(p)
        if share:
            out.append(share)
    return out

def _parse_share(p: Path) -> dict | None:
    try:
        text = p.read_text()
    except OSError:
        return None
    m = re.search(r"^\[([^\]]+)\]", text, re.MULTILINE)
    if not m:
        return None
    name = m.group(1)
    fields = {}
    for line in text.splitlines():
        if "=" in line and not line.strip().startswith("["):
            k, _, v = line.partition("=")
            fields[k.strip().lower()] = v.strip()
    valid_users = fields.get("valid users", "").split()
    write_list = fields.get("write list", "").split()
    return {
        "name": name,
        "path": fields.get("path", ""),
        "guest_ok": fields.get("guest ok", "no").lower() == "yes",
        "read_only": fields.get("read only", "yes").lower() == "yes",
        "valid_users": valid_users,
        "write_list": write_list,
        "force_user": fields.get("force user", ""),
        "file": str(p),
    }

def get_share(name: str) -> dict | None:
    if not SAFE_SHARE_NAME.match(name):
        return None
    p = SAMBA_CONF_DIR / f"sambawrapper-{name}.conf"
    if not p.exists():
        return None
    return _parse_share(p)

def share_user_perms(share: dict, all_users: list[str]) -> dict[str, str]:
    """Map username -> 'none' | 'read' | 'write' for the share-edit form."""
    valid = set(share.get("valid_users") or [])
    writers = set(share.get("write_list") or [])
    perms = {}
    for u in all_users:
        if u in writers:
            perms[u] = "write"
        elif u in valid:
            perms[u] = "read"
        else:
            perms[u] = "none"
    return perms

def create_share(name: str, abs_path: str, mode: str, guest_write: bool,
                 access_users: list[str], write_users: list[str]) -> tuple[bool, str]:
    """mode: 'guest' (no auth) or 'users' (per-user access/write)."""
    if not SAFE_SHARE_NAME.match(name):
        return False, "Имя шары: A-Z a-z 0-9 _ - (1..32 символов)"
    target = Path(abs_path).resolve()
    base = MOUNT_ROOT.resolve()
    try:
        target.relative_to(base)
    except ValueError:
        return False, f"Шарить можно только пути внутри {MOUNT_ROOT}"
    if not target.is_dir():
        return False, "Папка не существует или не директория"
    # guest-writable shares need the shared folder world-writable (see _build_share_conf)
    if mode == "guest" and guest_write:
        try:
            os.chmod(target, 0o777)
        except OSError:
            pass
    # writers always implicitly have access
    writers = [u for u in write_users if SAFE_USERNAME.match(u)]
    access = [u for u in (list(access_users) + writers) if SAFE_USERNAME.match(u)]
    access = sorted(set(access))
    writers = sorted(set(writers))
    if mode == "users" and not access:
        return False, "Выбери хотя бы одного пользователя (или сделай шару гостевой)"
    conf = _build_share_conf(name, str(target), mode, guest_write, access, writers)
    fname = SAMBA_CONF_DIR / f"sambawrapper-{name}.conf"
    r = sudo(["tee", str(fname)], input_text=conf)
    if not r.ok:
        return False, r.stderr.strip() or "не удалось записать конфиг"
    err = _rebuild_aggregate()
    if err:
        return False, err
    return _reload_samba()

def delete_share(name: str) -> tuple[bool, str]:
    if not SAFE_SHARE_NAME.match(name):
        return False, "Невалидное имя шары"
    fname = SAMBA_CONF_DIR / f"sambawrapper-{name}.conf"
    if not fname.exists():
        return False, "Шара не найдена"
    r = sudo(["rm", "-f", str(fname)])
    if not r.ok:
        return False, r.stderr.strip()
    err = _rebuild_aggregate()
    if err:
        return False, err
    return _reload_samba()

def _build_share_conf(name: str, path: str, mode: str, guest_write: bool,
                      access_users: list[str], write_users: list[str]) -> str:
    """Build a share definition.

    On NTFS/exFAT/vfat the whole mount is owned by root, so actual writes must run
    as root — we add `force user = root` whenever someone is allowed to write.
    Who *may* write is still gated by Samba via `write list`, independently of
    `force user`, so per-user read-only/read-write control keeps working.
    """
    lines = [
        f"[{name}]",
        f"   path = {path}",
        f"   browseable = yes",
    ]
    if mode == "guest":
        lines.append("   guest ok = yes")
        if guest_write:
            lines.append("   read only = no")
            lines.append(f"   force user = {SERVICE_USER}")
        else:
            lines.append("   read only = yes")
            lines.append("   force user = nobody")
    else:  # users
        lines.append("   guest ok = no")
        lines.append("   read only = yes")
        if access_users:
            lines.append("   valid users = " + " ".join(access_users))
        if write_users:
            lines.append("   write list = " + " ".join(write_users))
            lines.append(f"   force user = {SERVICE_USER}")
    # A guest-writable share needs world-writable dirs: for guest sessions Samba
    # checks directory access as the guest account (nobody); `force user` only
    # changes the resulting ownership, not that pre-write access check. So created
    # dirs must be 0777 for nested writes to keep working.
    if mode == "guest" and guest_write:
        lines += ["   create mask = 0666", "   directory mask = 0777"]
    else:
        lines += ["   create mask = 0664", "   directory mask = 0775"]
    return "\n".join(lines) + "\n"

def _rebuild_aggregate() -> str | None:
    files = sorted(p.name for p in SAMBA_CONF_DIR.glob("sambawrapper-*.conf") if p.name != AGGREGATE_NAME)
    body = "\n".join(f"include = {SAMBA_CONF_DIR}/{n}" for n in files) + "\n"
    r = sudo(["tee", str(SAMBA_CONF_DIR / AGGREGATE_NAME)], input_text=body)
    return None if r.ok else (r.stderr.strip() or "не удалось обновить aggregate")

def _reload_samba() -> tuple[bool, str]:
    r = sudo(["systemctl", "reload-or-restart", "smbd"])
    if not r.ok:
        return False, r.stderr.strip() or "не удалось перезагрузить smbd"
    return True, ""

# --- Samba users ---

def list_smb_users() -> list[str]:
    r = sudo(["pdbedit", "-L"])
    if not r.ok:
        return []
    users = []
    for line in r.stdout.splitlines():
        name = line.split(":", 1)[0].strip()
        if name:
            users.append(name)
    return users

SAFE_USERNAME = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")

def add_smb_user(username: str, password: str) -> tuple[bool, str]:
    if not SAFE_USERNAME.match(username):
        return False, "Имя пользователя: маленькие латинские буквы, цифры, _ -"
    if len(password) < 4:
        return False, "Пароль слишком короткий"
    # Make sure system user exists (nologin, no home) — Samba needs a backing user.
    check = run(["id", username])
    if not check.ok:
        r = sudo(["useradd", "--system", "--no-create-home", "--shell", "/usr/sbin/nologin", username])
        if not r.ok and "already exists" not in r.stderr:
            return False, r.stderr.strip() or "useradd failed"
    # Set samba password (smbpasswd reads two lines: password and confirmation).
    r = sudo(["smbpasswd", "-s", "-a", username], input_text=f"{password}\n{password}\n")
    if not r.ok:
        return False, r.stderr.strip() or "smbpasswd failed"
    return True, ""

def set_smb_password(username: str, password: str) -> tuple[bool, str]:
    if not SAFE_USERNAME.match(username):
        return False, "Невалидное имя"
    if len(password) < 4:
        return False, "Пароль слишком короткий"
    r = sudo(["smbpasswd", "-s", username], input_text=f"{password}\n{password}\n")
    if not r.ok:
        return False, r.stderr.strip() or "smbpasswd failed"
    return True, ""

def delete_smb_user(username: str) -> tuple[bool, str]:
    if not SAFE_USERNAME.match(username):
        return False, "Невалидное имя"
    r = sudo(["smbpasswd", "-x", username])
    if not r.ok:
        return False, r.stderr.strip() or "smbpasswd failed"
    sudo(["userdel", username])  # best-effort
    return True, ""
