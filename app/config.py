"""Runtime configuration paths."""
import os
from pathlib import Path

DATA_DIR = Path(os.environ.get("SAMBAWRAPPER_DATA_DIR", "/var/lib/sambawrapper"))
MOUNT_ROOT = Path(os.environ.get("SAMBAWRAPPER_MOUNT_ROOT", "/mnt/sambawrapper"))
SAMBA_CONF_DIR = Path(os.environ.get("SAMBAWRAPPER_SAMBA_CONF_DIR", "/etc/samba/smb.conf.d"))
SAMBA_INCLUDE_MARKER = "# sambawrapper-managed"
DB_PATH = DATA_DIR / "sambawrapper.db"
INITIAL_PASSWORD_FILE = DATA_DIR / "initial-password.txt"
SESSION_SECRET_FILE = DATA_DIR / "session-secret"
BIND_HOST = os.environ.get("SAMBAWRAPPER_HOST", "0.0.0.0")
BIND_PORT = int(os.environ.get("SAMBAWRAPPER_PORT", "8080"))
