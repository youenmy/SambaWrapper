"""Web UI port management.

The port lives in an EnvironmentFile (service.env) that the systemd unit reads as
${SW_PORT}. Changing it writes the file and schedules a restart via systemd-run so
the restart runs in its own transient unit (survives stopping our own cgroup).
"""
from .shell import sudo
from .config import DATA_DIR

ENV_FILE = DATA_DIR / "service.env"
DEFAULT_PORT = 8080

def current_port() -> int:
    try:
        for line in ENV_FILE.read_text().splitlines():
            if line.startswith("SW_PORT="):
                return int(line.split("=", 1)[1].strip())
    except Exception:
        pass
    return DEFAULT_PORT

def set_port(port: int) -> tuple[bool, str]:
    if not (1024 <= port <= 65535):
        return False, "Порт должен быть в диапазоне 1024–65535"
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    ENV_FILE.write_text(f"SW_HOST=0.0.0.0\nSW_PORT={port}\n")
    # Schedule the restart in a transient unit so it isn't killed with our cgroup.
    r = sudo(["systemd-run", "--on-active=2", "systemctl", "restart", "sambawrapper"])
    if not r.ok:
        return False, "Не удалось запланировать перезапуск: " + (r.stderr or r.stdout).strip()[:150]
    return True, f"Порт меняется на {port}. Через пару секунд переподключись на новый порт."
