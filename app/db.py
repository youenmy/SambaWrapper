"""SQLite storage for admin password and known mount associations."""
import sqlite3
from contextlib import contextmanager
from .config import DB_PATH, DATA_DIR

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mount_prefs (
    uuid       TEXT PRIMARY KEY,
    label      TEXT,
    mount_name TEXT NOT NULL,
    auto_mount INTEGER NOT NULL DEFAULT 0
);
"""

def init() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with connect() as cx:
        cx.executescript(SCHEMA)

@contextmanager
def connect():
    cx = sqlite3.connect(DB_PATH)
    cx.row_factory = sqlite3.Row
    try:
        yield cx
        cx.commit()
    finally:
        cx.close()

def get_setting(key: str) -> str | None:
    with connect() as cx:
        row = cx.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return row["value"] if row else None

def set_setting(key: str, value: str) -> None:
    with connect() as cx:
        cx.execute(
            "INSERT INTO settings(key,value) VALUES(?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )

def get_mount_pref(uuid: str) -> dict | None:
    with connect() as cx:
        row = cx.execute("SELECT * FROM mount_prefs WHERE uuid=?", (uuid,)).fetchone()
        return dict(row) if row else None

def upsert_mount_pref(uuid: str, label: str | None, mount_name: str, auto_mount: bool) -> None:
    with connect() as cx:
        cx.execute(
            "INSERT INTO mount_prefs(uuid,label,mount_name,auto_mount) VALUES(?,?,?,?) "
            "ON CONFLICT(uuid) DO UPDATE SET label=excluded.label,"
            " mount_name=excluded.mount_name, auto_mount=excluded.auto_mount",
            (uuid, label, mount_name, 1 if auto_mount else 0),
        )
