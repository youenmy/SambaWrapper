"""DLNA media server (minidlna) control.

minidlna serves MOUNT_ROOT to the LAN so TVs/players discover a "SambaWrapper"
media source. It runs as its own 'minidlna' user; mounted disks are world-readable
(umask 0022) so it can read them.
"""
from .shell import sudo, run
from .config import MOUNT_ROOT

CONF = "/etc/minidlna.conf"

def _conf_text() -> str:
    return (
        f"media_dir={MOUNT_ROOT}\n"
        "friendly_name=SambaWrapper\n"
        "db_dir=/var/cache/minidlna\n"
        "log_dir=/var/cache/minidlna\n"
        "inotify=yes\n"
        "notify_interval=895\n"
        "root_container=B\n"
    )

def status() -> dict:
    installed = run(["test", "-x", "/usr/sbin/minidlnad"]).ok
    active = run(["systemctl", "is-active", "minidlna"]).stdout.strip() == "active"
    enabled = run(["systemctl", "is-enabled", "minidlna"]).stdout.strip() == "enabled"
    return {"installed": installed, "active": active, "enabled": enabled}

def _write_conf() -> str | None:
    r = sudo(["tee", CONF], input_text=_conf_text())
    return None if r.ok else (r.stderr.strip() or "не удалось записать конфиг minidlna")

def enable() -> tuple[bool, str]:
    err = _write_conf()
    if err:
        return False, err
    r = sudo(["systemctl", "enable", "--now", "minidlna"])
    if not r.ok:
        return False, r.stderr.strip() or "не удалось включить minidlna"
    sudo(["systemctl", "restart", "minidlna"])  # apply our fresh config
    return True, "DLNA-сервер включён"

def disable() -> tuple[bool, str]:
    r = sudo(["systemctl", "disable", "--now", "minidlna"])
    if not r.ok:
        return False, r.stderr.strip() or "не удалось выключить minidlna"
    return True, "DLNA-сервер выключен"

def rescan() -> tuple[bool, str]:
    _write_conf()
    r = sudo(["systemctl", "restart", "minidlna"])
    if not r.ok:
        return False, r.stderr.strip() or "не удалось пересканировать"
    return True, "Пересканирование медиатеки запущено"
