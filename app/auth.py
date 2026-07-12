"""Single-admin auth: password hashed in SQLite, session cookies."""
import secrets
import bcrypt
from fastapi import Request, HTTPException
from . import db
from .config import INITIAL_PASSWORD_FILE, SESSION_SECRET_FILE, DATA_DIR

ADMIN_USERNAME = "admin"          # дефолт до первой смены
SETTING_PWHASH = "admin_password_hash"
SETTING_USERNAME = "admin_username"

import re as _re
SAFE_LOGIN = _re.compile(r"^[A-Za-z0-9_.-]{2,32}$")

def get_username() -> str:
    return db.get_setting(SETTING_USERNAME) or ADMIN_USERNAME

def set_username(new: str) -> tuple[bool, str]:
    new = (new or "").strip()
    if not SAFE_LOGIN.match(new):
        return False, "Логин: 2–32 символа, буквы/цифры/._-"
    db.set_setting(SETTING_USERNAME, new)
    return True, ""

def _hash(pw: str) -> str:
    return bcrypt.hashpw(pw.encode("utf-8")[:72], bcrypt.gensalt()).decode("utf-8")

def _check(pw: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(pw.encode("utf-8")[:72], hashed.encode("utf-8"))
    except (ValueError, TypeError):
        return False

def ensure_initial_password() -> str | None:
    """Create admin password on first run, return the plaintext (and write it to file)."""
    db.init()
    if db.get_setting(SETTING_PWHASH):
        return None
    pw = secrets.token_urlsafe(12)
    db.set_setting(SETTING_PWHASH, _hash(pw))
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    INITIAL_PASSWORD_FILE.write_text(
        f"SambaWrapper initial credentials\n"
        f"username: {ADMIN_USERNAME}\n"
        f"password: {pw}\n"
        f"(change in Settings tab; this file is for first-time access only)\n"
    )
    try:
        INITIAL_PASSWORD_FILE.chmod(0o600)
    except OSError:
        pass
    return pw

def ensure_session_secret() -> str:
    if SESSION_SECRET_FILE.exists():
        return SESSION_SECRET_FILE.read_text().strip()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    secret = secrets.token_urlsafe(32)
    SESSION_SECRET_FILE.write_text(secret)
    try:
        SESSION_SECRET_FILE.chmod(0o600)
    except OSError:
        pass
    return secret

def verify_password(username: str, password: str) -> bool:
    if (username or "").strip() != get_username():
        return False
    hashed = db.get_setting(SETTING_PWHASH)
    if not hashed:
        return False
    return _check(password, hashed)


# --- дополнительные учётки веб-интерфейса (роль admin/user) ---

ROLE_ADMIN = "admin"
ROLE_USER = "user"

def authenticate(username: str, password: str) -> str | None:
    """Вернуть роль, если логин/пароль верные, иначе None.
    Сначала главный админ (в settings), затем таблица web_users."""
    if verify_password(username, password):
        return ROLE_ADMIN
    username = (username or "").strip()
    with db.connect() as cx:
        row = cx.execute("SELECT pwhash, role FROM web_users WHERE username=?",
                         (username,)).fetchone()
    if row and _check(password, row["pwhash"]):
        return row["role"] if row["role"] in (ROLE_ADMIN, ROLE_USER) else ROLE_USER
    return None

def list_web_users() -> list[dict]:
    with db.connect() as cx:
        rows = cx.execute("SELECT username, role FROM web_users ORDER BY username").fetchall()
    return [dict(r) for r in rows]

def add_web_user(username: str, password: str, role: str) -> tuple[bool, str]:
    username = (username or "").strip()
    if not SAFE_LOGIN.match(username):
        return False, "Логин: 2–32 символа, буквы/цифры/._-"
    if username == get_username():
        return False, "Это имя занято главным админом"
    if len(password) < 8:
        return False, "Пароль: минимум 8 символов"
    if role not in (ROLE_ADMIN, ROLE_USER):
        return False, "Неизвестная роль"
    with db.connect() as cx:
        exists = cx.execute("SELECT 1 FROM web_users WHERE username=?", (username,)).fetchone()
        if exists:
            return False, "Такой пользователь уже есть"
        cx.execute("INSERT INTO web_users(username,pwhash,role) VALUES(?,?,?)",
                   (username, _hash(password), role))
    return True, ""

def set_web_user_password(username: str, password: str) -> tuple[bool, str]:
    if len(password) < 8:
        return False, "Пароль: минимум 8 символов"
    with db.connect() as cx:
        cur = cx.execute("UPDATE web_users SET pwhash=? WHERE username=?",
                         (_hash(password), (username or "").strip()))
        if cur.rowcount == 0:
            return False, "Пользователь не найден"
    return True, ""

def delete_web_user(username: str) -> tuple[bool, str]:
    with db.connect() as cx:
        cur = cx.execute("DELETE FROM web_users WHERE username=?", ((username or "").strip(),))
        if cur.rowcount == 0:
            return False, "Пользователь не найден"
    return True, ""

def set_password(new_password: str) -> None:
    db.set_setting(SETTING_PWHASH, _hash(new_password))

def require_login(request: Request) -> str:
    user = request.session.get("user")
    if not user:
        raise HTTPException(status_code=302, headers={"Location": "/login"})
    return user
