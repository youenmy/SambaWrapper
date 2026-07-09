"""Torrent client (Transmission) control.

The app talks to a local transmission-daemon over its RPC API on 127.0.0.1:9091
(no auth — bound to localhost only, configured at install time). Adding torrents,
listing and pause/resume/remove all go through RPC and need no sudo. The daemon
itself runs as the 'sambawrapper' user, so downloaded files land owned by us and
are immediately browsable and shareable over Samba.

Only enabling/disabling the systemd service needs sudo.
"""
import base64
import json
import os
import urllib.error
import urllib.request
from pathlib import Path

from .shell import sudo, run
from .config import MOUNT_ROOT

RPC_URL = os.environ.get("SAMBAWRAPPER_TRANSMISSION_RPC", "http://127.0.0.1:9091/transmission/rpc")
SERVICE = "transmission-daemon"
DAEMON_BIN = "/usr/bin/transmission-daemon"

_session_id = ""  # X-Transmission-Session-Id, refreshed on 409

# torrent-get status codes -> (label, css-tone)
_STATUS = {
    0: ("остановлен", "slate"),
    1: ("в очереди на проверку", "slate"),
    2: ("проверка", "amber"),
    3: ("в очереди", "slate"),
    4: ("качается", "sky"),
    5: ("в очереди на раздачу", "slate"),
    6: ("раздаётся", "emerald"),
}

_FIELDS = ["id", "name", "percentDone", "rateDownload", "rateUpload",
           "status", "eta", "totalSize", "errorString", "downloadDir",
           "peersSendingToUs", "peersGettingFromUs", "uploadRatio",
           "sequential_download"]


class TorrentError(Exception):
    pass


def _rpc(method: str, arguments: dict | None = None, timeout: int = 10) -> dict:
    """Call Transmission RPC, handling the 409 session-id handshake. Raises TorrentError."""
    global _session_id
    body = json.dumps({"method": method, "arguments": arguments or {}}).encode()
    for attempt in range(2):
        req = urllib.request.Request(RPC_URL, data=body, method="POST")
        req.add_header("Content-Type", "application/json")
        if _session_id:
            req.add_header("X-Transmission-Session-Id", _session_id)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = json.loads(resp.read().decode() or "{}")
        except urllib.error.HTTPError as e:
            if e.code == 409 and attempt == 0:
                _session_id = e.headers.get("X-Transmission-Session-Id", "")
                continue  # retry with the fresh session id
            raise TorrentError(f"RPC HTTP {e.code}")
        except (urllib.error.URLError, ConnectionError, OSError):
            raise TorrentError("демон торрентов не отвечает")
        if data.get("result") != "success":
            raise TorrentError(data.get("result") or "RPC error")
        return data.get("arguments", {})
    raise TorrentError("не удалось пройти RPC-аутентификацию")


# ---------- service status ----------

def status() -> dict:
    installed = run(["test", "-x", DAEMON_BIN]).ok
    active = run(["systemctl", "is-active", SERVICE]).stdout.strip() == "active"
    count = None
    if active:
        try:
            count = len(_rpc("torrent-get", {"fields": ["id"]}).get("torrents", []))
        except TorrentError:
            count = None
    return {"installed": installed, "active": active, "count": count}


def enable() -> tuple[bool, str]:
    r = sudo(["systemctl", "enable", "--now", SERVICE])
    if not r.ok:
        return False, r.stderr.strip() or "не удалось запустить торрент-демон"
    return True, "Торрент-клиент включён"


def disable() -> tuple[bool, str]:
    r = sudo(["systemctl", "disable", "--now", SERVICE])
    if not r.ok:
        return False, r.stderr.strip() or "не удалось остановить торрент-демон"
    return True, "Торрент-клиент выключен"


# ---------- download dir validation ----------

def _valid_dir(download_dir: str) -> Path:
    """Resolve and ensure download_dir is an existing folder under a real mount. Raises TorrentError."""
    if not download_dir:
        raise TorrentError("не выбрана папка для загрузки")
    try:
        target = Path(download_dir).resolve()
        target.relative_to(MOUNT_ROOT.resolve())
    except (ValueError, OSError):
        raise TorrentError("папка вне зоны хранилища")
    rel = target.relative_to(MOUNT_ROOT.resolve())
    if not rel.parts:
        raise TorrentError("выбери папку на конкретном диске")
    top = MOUNT_ROOT.resolve() / rel.parts[0]
    if not os.path.ismount(str(top)):
        raise TorrentError("диск не смонтирован")
    if not target.is_dir():
        raise TorrentError("папка не существует")
    return target


# ---------- torrent operations ----------

def add_magnet(spec: str, download_dir: str) -> tuple[bool, str]:
    spec = (spec or "").strip()
    if not spec:
        return False, "пустая ссылка"
    if not (spec.startswith("magnet:") or spec.startswith("http://") or spec.startswith("https://")):
        return False, "ожидается magnet-ссылка или http(s)-URL на .torrent"
    try:
        target = _valid_dir(download_dir)
        res = _rpc("torrent-add", {"filename": spec, "download-dir": str(target), "paused": False})
    except TorrentError as e:
        return False, str(e)
    if "torrent-duplicate" in res:
        return True, "Торрент уже добавлен"
    name = (res.get("torrent-added") or {}).get("name", "торрент")
    return True, f"Добавлен: {name}"


def add_file(content: bytes, download_dir: str) -> tuple[bool, str]:
    if not content:
        return False, "пустой .torrent-файл"
    try:
        target = _valid_dir(download_dir)
        meta = base64.b64encode(content).decode()
        res = _rpc("torrent-add", {"metainfo": meta, "download-dir": str(target), "paused": False})
    except TorrentError as e:
        return False, str(e)
    if "torrent-duplicate" in res:
        return True, "Торрент уже добавлен"
    name = (res.get("torrent-added") or {}).get("name", "торрент")
    return True, f"Добавлен: {name}"


def list_torrents() -> list[dict]:
    try:
        torrents = _rpc("torrent-get", {"fields": _FIELDS}).get("torrents", [])
    except TorrentError:
        return []
    out = []
    for t in torrents:
        label, tone = _STATUS.get(t.get("status", 0), ("—", "slate"))
        ratio = t.get("uploadRatio", 0) or 0
        out.append({
            "id": t.get("id"),
            "name": t.get("name", "?"),
            "pct": round((t.get("percentDone", 0) or 0) * 100),
            "down": _human_rate(t.get("rateDownload", 0)),
            "up": _human_rate(t.get("rateUpload", 0)),
            "size": _human_size(t.get("totalSize", 0)),
            "eta": _human_eta(t.get("eta", -1)),
            "status": label, "tone": tone,
            "running": t.get("status", 0) not in (0,),
            "error": (t.get("errorString") or "").strip(),
            "dir": t.get("downloadDir", ""),
            "seeds": t.get("peersSendingToUs", 0),
            "peers": t.get("peersGettingFromUs", 0),
            "ratio": round(ratio, 2) if ratio >= 0 else 0.0,
            "seq": bool(t.get("sequential_download")),
            # сырые значения для сортировки
            "_size": t.get("totalSize", 0), "_down": t.get("rateDownload", 0),
            "_up": t.get("rateUpload", 0), "_eta": t.get("eta", -1),
        })
    return out

SORT_KEYS = {
    "name": lambda t: t["name"].lower(), "pct": lambda t: t["pct"],
    "status": lambda t: t["status"], "size": lambda t: t["_size"],
    "seeds": lambda t: t["seeds"], "peers": lambda t: t["peers"],
    "ratio": lambda t: t["ratio"], "down": lambda t: t["_down"],
    "up": lambda t: t["_up"], "eta": lambda t: (t["_eta"] < 0, t["_eta"]),
}


def start(tid: int) -> tuple[bool, str]:
    try:
        _rpc("torrent-start", {"ids": [tid]})
    except TorrentError as e:
        return False, str(e)
    return True, "Запущен"


def stop(tid: int) -> tuple[bool, str]:
    try:
        _rpc("torrent-stop", {"ids": [tid]})
    except TorrentError as e:
        return False, str(e)
    return True, "Приостановлен"


def remove(tid: int, delete_data: bool) -> tuple[bool, str]:
    try:
        _rpc("torrent-remove", {"ids": [tid], "delete-local-data": delete_data})
    except TorrentError as e:
        return False, str(e)
    return True, "Удалён вместе с файлами" if delete_data else "Удалён из списка (файлы оставлены)"


# ---------- per-torrent details ----------

_MEDIA_EXT = {"mp4","mkv","avi","mov","m4v","webm","ogv","mpg","mpeg","ts","wmv","flv",
              "mp3","flac","wav","m4a","aac","ogg","oga","opus","wma"}
_PRIO = {-1: "low", 0: "normal", 1: "high"}

def get_details(tid: int) -> dict | None:
    try:
        r = _rpc("torrent-get", {"ids": [tid], "fields":
                 ["id", "name", "downloadDir", "files", "fileStats",
                  "sequential_download", "percentDone", "status"]})
    except TorrentError:
        return None
    ts = r.get("torrents", [])
    if not ts:
        return None
    t = ts[0]
    ddir = t.get("downloadDir", "")
    root = str(MOUNT_ROOT)
    files = []
    seq = bool(t.get("sequential_download"))
    for i, (f, st) in enumerate(zip(t.get("files", []), t.get("fileStats", []))):
        length = f.get("length", 0) or 0
        done = f.get("bytesCompleted", 0) or 0
        pct = round(done / length * 100) if length else 0
        name = f.get("name", "")
        abs_path = os.path.join(ddir, name)
        rel = abs_path[len(root) + 1:] if abs_path.startswith(root + "/") else None
        ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
        is_media = ext in _MEDIA_EXT
        # можно запускать: файл готов, либо качается последовательно и
        # начало уже на диске (минимум 32 МБ или 2% файла)
        playable = bool(rel and is_media and (
            pct >= 100 or (seq and done >= min(length, max(32 * 1024 * 1024, length * 0.02)))))
        files.append({
            "i": i, "name": name, "base": name.split("/")[-1],
            "size": _human_size(length), "pct": pct,
            "wanted": bool(st.get("wanted", True)),
            "prio": _PRIO.get(st.get("priority", 0), "normal"),
            "rel": rel, "media": is_media, "playable": playable,
        })
    return {"id": t.get("id"), "name": t.get("name", "?"), "seq": seq, "files": files}

def set_sequential(tid: int, on: bool) -> tuple[bool, str]:
    try:
        _rpc("torrent-set", {"ids": [tid], "sequential_download": on})
    except TorrentError as e:
        return False, str(e)
    return True, "Последовательная загрузка " + ("включена" if on else "выключена")

def set_file_wanted(tid: int, idx: int, wanted: bool) -> tuple[bool, str]:
    key = "files-wanted" if wanted else "files-unwanted"
    try:
        _rpc("torrent-set", {"ids": [tid], key: [idx]})
    except TorrentError as e:
        return False, str(e)
    return True, "Файл включён в загрузку" if wanted else "Файл исключён из загрузки"

def set_file_priority(tid: int, idx: int, prio: str) -> tuple[bool, str]:
    key = {"low": "priority-low", "normal": "priority-normal", "high": "priority-high"}.get(prio)
    if not key:
        return False, "неизвестный приоритет"
    try:
        _rpc("torrent-set", {"ids": [tid], key: [idx]})
    except TorrentError as e:
        return False, str(e)
    return True, "Приоритет обновлён"

# ---------- session limits ----------

def get_limits() -> dict | None:
    try:
        a = _rpc("session-get", {"fields": [
            "speed-limit-down", "speed-limit-down-enabled",
            "speed-limit-up", "speed-limit-up-enabled",
            "alt-speed-down", "alt-speed-up", "alt-speed-enabled",
            "seedRatioLimit", "seedRatioLimited"]})
    except TorrentError:
        return None
    return {
        "down": a.get("speed-limit-down", 0), "down_on": a.get("speed-limit-down-enabled", False),
        "up": a.get("speed-limit-up", 0), "up_on": a.get("speed-limit-up-enabled", False),
        "alt_down": a.get("alt-speed-down", 0), "alt_up": a.get("alt-speed-up", 0),
        "alt_on": a.get("alt-speed-enabled", False),
        "ratio": a.get("seedRatioLimit", 2.0), "ratio_on": a.get("seedRatioLimited", False),
    }

def set_limits(down: int, down_on: bool, up: int, up_on: bool,
               alt_down: int, alt_up: int, ratio: float, ratio_on: bool) -> tuple[bool, str]:
    try:
        _rpc("session-set", {
            "speed-limit-down": max(0, down), "speed-limit-down-enabled": down_on,
            "speed-limit-up": max(0, up), "speed-limit-up-enabled": up_on,
            "alt-speed-down": max(0, alt_down), "alt-speed-up": max(0, alt_up),
            "seedRatioLimit": max(0.0, ratio), "seedRatioLimited": ratio_on,
        })
    except TorrentError as e:
        return False, str(e)
    return True, "Лимиты сохранены"

def toggle_alt_speed() -> tuple[bool, str]:
    try:
        cur = _rpc("session-get", {"fields": ["alt-speed-enabled"]}).get("alt-speed-enabled", False)
        _rpc("session-set", {"alt-speed-enabled": not cur})
    except TorrentError as e:
        return False, str(e)
    return True, "Тихий режим включён" if not cur else "Тихий режим выключен"

# ---------- formatting helpers ----------

def _human_size(n: int) -> str:
    n = float(n or 0)
    for unit in ("Б", "КБ", "МБ", "ГБ", "ТБ"):
        if n < 1024 or unit == "ТБ":
            return f"{n:.0f} {unit}" if unit == "Б" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} ТБ"


def _human_rate(n: int) -> str:
    if not n:
        return ""
    return _human_size(n) + "/с"


def _human_eta(secs: int) -> str:
    if secs is None or secs < 0:
        return ""
    if secs < 60:
        return f"{secs}с"
    m, s = divmod(secs, 60)
    h, m = divmod(m, 60)
    if h:
        return f"{h}ч {m}м"
    return f"{m}м"
