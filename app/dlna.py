"""DLNA media server (minidlna) control.

minidlna serves MOUNT_ROOT to the LAN so TVs/players discover a "SambaWrapper"
media source. It runs as its own 'minidlna' user; mounted disks are world-readable
(umask 0022) so it can read them.
"""
from pathlib import Path
from . import db
from .shell import sudo, run
from .config import MOUNT_ROOT

CONF = "/etc/minidlna.conf"
SETTING_MEDIA_DIR = "dlna_media_dir"

def media_dir() -> str:
    """Транслируемая папка: настройка из БД, если она всё ещё валидна, иначе весь корень."""
    d = db.get_setting(SETTING_MEDIA_DIR)
    if d:
        try:
            p = Path(d).resolve()
            p.relative_to(MOUNT_ROOT.resolve())
            if p.is_dir():
                return str(p)
        except (ValueError, OSError):
            pass
    return str(MOUNT_ROOT)

def set_media_dir(path: str) -> tuple[bool, str]:
    try:
        p = Path(path).resolve()
        p.relative_to(MOUNT_ROOT.resolve())
    except (ValueError, OSError):
        return False, "Папка вне зоны хранилища"
    if not p.is_dir():
        return False, "Папка не существует"
    db.set_setting(SETTING_MEDIA_DIR, str(p))
    if status()["active"]:  # применяем на лету: новый конфиг + пересканирование
        return rescan()
    return True, "Папка трансляции сохранена"

def _conf_text() -> str:
    return (
        f"media_dir={media_dir()}\n"
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
