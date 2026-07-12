"""Launcher: генерирует self-signed сертификат (один раз) и стартует uvicorn с TLS.

systemd вызывает `python -m app.serve`. Сертификат живёт в DATA_DIR/tls/ и
создаётся при первом старте — сервис доступен только по https. Браузер один раз
предупредит о самоподписанном сертификате — это нормально для домашнего сервиса.
"""
import os
import subprocess

from .config import DATA_DIR

TLS_DIR = DATA_DIR / "tls"
CERT = TLS_DIR / "cert.pem"
KEY = TLS_DIR / "key.pem"


def ensure_cert() -> bool:
    if CERT.exists() and KEY.exists():
        return True
    try:
        TLS_DIR.mkdir(parents=True, exist_ok=True)
        r = subprocess.run(
            ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
             "-keyout", str(KEY), "-out", str(CERT),
             "-days", "3650", "-subj", "/CN=SambaWrapper"],
            capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            return False
        KEY.chmod(0o600)
        return True
    except (OSError, subprocess.SubprocessError):
        return False


def main() -> None:
    import uvicorn
    host = os.environ.get("SW_HOST", "0.0.0.0")
    port = int(os.environ.get("SW_PORT", "8080"))
    kwargs = {}
    if ensure_cert():
        kwargs = {"ssl_certfile": str(CERT), "ssl_keyfile": str(KEY)}
    # без сертификата (нет openssl?) стартуем по http, чтобы не окирпичить сервис
    uvicorn.run("app.main:app", host=host, port=port, **kwargs)


if __name__ == "__main__":
    main()
