"""Single-admin auth: password hashed in SQLite, session cookies."""
import secrets
import bcrypt
from fastapi import Request, HTTPException
from . import db
from .config import INITIAL_PASSWORD_FILE, SESSION_SECRET_FILE, DATA_DIR

ADMIN_USERNAME = "admin"
SETTING_PWHASH = "admin_password_hash"

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
    if username != ADMIN_USERNAME:
        return False
    hashed = db.get_setting(SETTING_PWHASH)
    if not hashed:
        return False
    return _check(password, hashed)

def set_password(new_password: str) -> None:
    db.set_setting(SETTING_PWHASH, _hash(new_password))

def require_login(request: Request) -> str:
    user = request.session.get("user")
    if not user:
        raise HTTPException(status_code=302, headers={"Location": "/login"})
    return user
