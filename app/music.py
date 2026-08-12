"""Music library: scan a folder, read tags, extract cover art.

Scanning runs in a background thread; progress is exposed via `scan_state()`
so the UI can poll it. Tracks are keyed by path; a file is re-read only when
its mtime/size changed, so repeat scans of a large library are cheap.
"""
import os
import threading
import time
from pathlib import Path

from mutagen import File as MutagenFile
from mutagen.flac import FLAC
from mutagen.id3 import ID3
from mutagen.mp4 import MP4

from . import db
from .config import DATA_DIR, MOUNT_ROOT

SETTING_LIBRARY = "music_library_path"
COVER_DIR = DATA_DIR / "music-covers"
DEFAULT_LIBRARY = str(MOUNT_ROOT)

AUDIO_EXT = {".mp3", ".flac", ".m4a", ".mp4", ".aac", ".ogg", ".oga",
             ".opus", ".wav", ".wma", ".alac", ".aiff"}
SKIP_DIRS = {"$RECYCLE.BIN", "System Volume Information", "lost+found",
             ".Trash-1000", "@eaDir", "__MACOSX"}

_scan = {"running": False, "found": 0, "done": 0, "added": 0, "removed": 0,
         "error": "", "finished_at": 0.0}
_scan_lock = threading.Lock()


# ---------- library path ----------

def library_path() -> str:
    return db.get_setting(SETTING_LIBRARY) or DEFAULT_LIBRARY

def set_library_path(path: str) -> tuple[bool, str]:
    try:
        p = Path(path).expanduser().resolve()
        p.relative_to(MOUNT_ROOT.resolve())
    except (ValueError, OSError):
        return False, f"Библиотека должна быть внутри {MOUNT_ROOT}"
    if not p.is_dir():
        return False, "Папка не существует"
    if not os.access(p, os.R_OK):
        return False, "Нет доступа на чтение"
    db.set_setting(SETTING_LIBRARY, str(p))
    return True, "Библиотека сохранена"


# ---------- tag reading ----------

def _first(value) -> str:
    if isinstance(value, (list, tuple)):
        return str(value[0]) if value else ""
    return str(value or "")

def _int(value) -> int:
    s = _first(value)
    if not s:
        return 0
    # "3/12" -> 3, "2003-05-01" -> 2003
    for sep in ("/", "-", "."):
        if sep in s:
            s = s.split(sep)[0]
    try:
        return int("".join(c for c in s if c.isdigit()) or 0)
    except ValueError:
        return 0

def read_tags(path: Path) -> dict | None:
    """Return tag dict for an audio file, or None if it isn't readable."""
    try:
        audio = MutagenFile(str(path), easy=True)
    except Exception:
        return None
    if audio is None:
        return None
    tags = audio.tags or {}
    info = getattr(audio, "info", None)
    # у части файлов тегов нет вовсе — тогда берём подсказки из путей:
    # .../Исполнитель/Альбом/трек.mp3
    parent = path.parent.name
    grandparent = path.parent.parent.name
    return {
        "title": _first(tags.get("title")) or path.stem,
        "artist": _first(tags.get("artist")) or grandparent,
        "album": _first(tags.get("album")) or parent,
        "albumartist": _first(tags.get("albumartist")) or _first(tags.get("artist")) or grandparent,
        "genre": _first(tags.get("genre")),
        "year": _int(tags.get("date") or tags.get("originaldate") or tags.get("year")),
        "track_no": _int(tags.get("tracknumber")),
        "duration": float(getattr(info, "length", 0) or 0),
        "bitrate": int(getattr(info, "bitrate", 0) or 0) // 1000,
    }

def extract_cover(path: Path) -> bytes | None:
    """Pull embedded cover art out of a file (ID3 APIC / MP4 covr / FLAC picture)."""
    suffix = path.suffix.lower()
    try:
        if suffix == ".mp3":
            for frame in ID3(str(path)).getall("APIC"):
                if frame.data:
                    return frame.data
        elif suffix in (".m4a", ".mp4", ".aac", ".alac"):
            covr = MP4(str(path)).tags.get("covr") if MP4(str(path)).tags else None
            if covr:
                return bytes(covr[0])
        elif suffix == ".flac":
            pics = FLAC(str(path)).pictures
            if pics:
                return pics[0].data
        else:
            audio = MutagenFile(str(path))
            pics = getattr(audio, "pictures", None)
            if pics:
                return pics[0].data
    except Exception:
        return None
    return None

COVER_MAX_PX = 400

def _shrink(data: bytes) -> bytes:
    """Ужать обложку до COVER_MAX_PX — иначе кэш разрастается до гигабайтов."""
    try:
        import io

        from PIL import Image
        img = Image.open(io.BytesIO(data))
        img = img.convert("RGB")
        img.thumbnail((COVER_MAX_PX, COVER_MAX_PX))
        out = io.BytesIO()
        img.save(out, "JPEG", quality=82, optimize=True)
        return out.getvalue()
    except Exception:
        return data  # Pillow нет или картинка битая — кладём как есть

def _save_cover(track_id: int, data: bytes) -> bool:
    try:
        COVER_DIR.mkdir(parents=True, exist_ok=True)
        (COVER_DIR / f"{track_id}.img").write_bytes(_shrink(data))
        return True
    except OSError:
        return False

def cover_file(track_id: int) -> Path | None:
    p = COVER_DIR / f"{track_id}.img"
    return p if p.exists() else None


# ---------- scanning ----------

def scan_state() -> dict:
    with _scan_lock:
        return dict(_scan)

def start_scan(full: bool = False) -> tuple[bool, str]:
    with _scan_lock:
        if _scan["running"]:
            return False, "Сканирование уже идёт"
        _scan.update(running=True, found=0, done=0, added=0, removed=0, error="")
    threading.Thread(target=_scan_worker, args=(full,), daemon=True).start()
    return True, "Сканирование запущено"

def _iter_audio(root: Path):
    for dirpath, dirnames, filenames in os.walk(root, onerror=lambda e: None):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        for name in filenames:
            if Path(name).suffix.lower() in AUDIO_EXT and not name.startswith("."):
                yield Path(dirpath) / name

def _scan_worker(full: bool) -> None:
    try:
        root = Path(library_path())
        files = list(_iter_audio(root))
        with _scan_lock:
            _scan["found"] = len(files)

        with db.connect() as cx:
            known = {r["path"]: (r["id"], r["mtime"], r["size"])
                     for r in cx.execute("SELECT id, path, mtime, size FROM tracks")}

        seen: set[str] = set()
        added = 0
        for i, f in enumerate(files, 1):
            spath = str(f)
            seen.add(spath)
            try:
                st = f.stat()
            except OSError:
                continue
            prev = known.get(spath)
            if prev and not full and abs(prev[1] - st.st_mtime) < 1 and prev[2] == st.st_size:
                if i % 50 == 0:
                    with _scan_lock:
                        _scan["done"] = i
                continue  # не изменился — пропускаем

            tags = read_tags(f)
            if tags is None:
                continue
            row = (spath, tags["title"], tags["artist"], tags["album"], tags["albumartist"],
                   tags["genre"], tags["year"], tags["track_no"], tags["duration"],
                   tags["bitrate"], st.st_size, st.st_mtime, time.time())
            with db.connect() as cx:
                cx.execute(
                    "INSERT INTO tracks(path,title,artist,album,albumartist,genre,year,"
                    "track_no,duration,bitrate,size,mtime,added) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) "
                    "ON CONFLICT(path) DO UPDATE SET title=excluded.title, artist=excluded.artist,"
                    " album=excluded.album, albumartist=excluded.albumartist, genre=excluded.genre,"
                    " year=excluded.year, track_no=excluded.track_no, duration=excluded.duration,"
                    " bitrate=excluded.bitrate, size=excluded.size, mtime=excluded.mtime", row)
                tid = cx.execute("SELECT id FROM tracks WHERE path=?", (spath,)).fetchone()["id"]

            cover = extract_cover(f)
            has_cover = bool(cover) and _save_cover(tid, cover)
            with db.connect() as cx:
                cx.execute("UPDATE tracks SET has_cover=? WHERE id=?", (1 if has_cover else 0, tid))
            added += 1
            with _scan_lock:
                _scan["done"] = i
                _scan["added"] = added

        # убрать из БД треки, которых больше нет на диске
        gone = [p for p in known if p not in seen]
        if gone:
            with db.connect() as cx:
                for chunk_start in range(0, len(gone), 500):
                    chunk = gone[chunk_start:chunk_start + 500]
                    q = ",".join("?" * len(chunk))
                    for r in cx.execute(f"SELECT id FROM tracks WHERE path IN ({q})", chunk):
                        (COVER_DIR / f"{r['id']}.img").unlink(missing_ok=True)
                    cx.execute(f"DELETE FROM tracks WHERE path IN ({q})", chunk)
            with _scan_lock:
                _scan["removed"] = len(gone)
    except Exception as e:  # никогда не оставляем состояние «running»
        with _scan_lock:
            _scan["error"] = str(e)[:200]
    finally:
        with _scan_lock:
            _scan["running"] = False
            _scan["finished_at"] = time.time()


# ---------- queries ----------

SORTS = {
    "title": "title COLLATE NOCASE",
    "artist": "artist COLLATE NOCASE, album COLLATE NOCASE, track_no",
    "album": "album COLLATE NOCASE, track_no",
    "year": "year",
    "duration": "duration",
    "added": "added",
}

def list_tracks(q: str = "", sort: str = "artist", desc: bool = False,
                artist: str = "", album: str = "", folder: str = "",
                limit: int = 100, offset: int = 0, seed: int = 0) -> tuple[list[dict], int]:
    where, args = [], []
    if folder:
        where.append("path LIKE ?")
        args.append(folder.rstrip("/") + "/%")
    if q:
        where.append("(title LIKE ? OR artist LIKE ? OR album LIKE ?)")
        like = f"%{q}%"
        args += [like, like, like]
    if artist:
        where.append("artist = ?")
        args.append(artist)
    if album:
        where.append("album = ?")
        args.append(album)
    clause = ("WHERE " + " AND ".join(where)) if where else ""
    order = SORTS.get(sort, SORTS["artist"]) + (" DESC" if desc else "")
    with db.connect() as cx:
        total = cx.execute(f"SELECT COUNT(*) c FROM tracks {clause}", args).fetchone()["c"]
        rows = cx.execute(
            f"SELECT * FROM tracks {clause} ORDER BY {order} LIMIT ? OFFSET ?",
            args + [limit, offset]).fetchall()
    return [dict(r) for r in rows], total

def random_tracks(q: str = "", artist: str = "", album: str = "", folder: str = "",
                  limit: int = 1, exclude: list[int] | None = None) -> list[dict]:
    """Случайные треки в пределах текущего фильтра — для режима «перемешать».

    Выбор делается по всей выборке в БД, а не по показанной части списка,
    иначе «случайность» крутится вокруг первых по алфавиту исполнителей.
    """
    where, args = [], []
    if q:
        where.append("(title LIKE ? OR artist LIKE ? OR album LIKE ?)")
        like = f"%{q}%"
        args += [like, like, like]
    if artist:
        where.append("artist = ?")
        args.append(artist)
    if album:
        where.append("album = ?")
        args.append(album)
    if folder:
        where.append("path LIKE ?")
        args.append(folder.rstrip("/") + "/%")
    if exclude:
        exclude = list(exclude)[:200]
        where.append("id NOT IN (%s)" % ",".join("?" * len(exclude)))
        args += exclude
    clause = ("WHERE " + " AND ".join(where)) if where else ""
    with db.connect() as cx:
        rows = cx.execute(
            f"SELECT * FROM tracks {clause} ORDER BY RANDOM() LIMIT ?", args + [limit]).fetchall()
    return [dict(r) for r in rows]

def track_page(track_id: int, q: str = "", sort: str = "artist", desc: bool = False,
               artist: str = "", album: str = "", folder: str = "", page_size: int = 100) -> int:
    """Номер страницы, на которой окажется трек при текущей сортировке и фильтрах."""
    where, args = [], []
    if q:
        where.append("(title LIKE ? OR artist LIKE ? OR album LIKE ?)")
        like = f"%{q}%"
        args += [like, like, like]
    if artist:
        where.append("artist = ?")
        args.append(artist)
    if album:
        where.append("album = ?")
        args.append(album)
    if folder:
        where.append("path LIKE ?")
        args.append(folder.rstrip("/") + "/%")
    clause = ("WHERE " + " AND ".join(where)) if where else ""
    order = SORTS.get(sort, SORTS["artist"]) + (" DESC" if desc else "")
    with db.connect() as cx:
        row = cx.execute(
            f"SELECT pos FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY {order}) - 1 AS pos "
            f"FROM tracks {clause}) WHERE id = ?", args + [track_id]).fetchone()
    return (row["pos"] // page_size + 1) if row else 1

def list_folders() -> list[dict]:
    """Папки библиотеки (по одному уровню вложенности) с числом треков."""
    root = library_path().rstrip("/") + "/"
    with db.connect() as cx:
        rows = cx.execute("SELECT path FROM tracks WHERE path LIKE ?", (root + "%",)).fetchall()
    counts: dict[str, int] = {}
    for r in rows:
        rel = r["path"][len(root):]
        if "/" not in rel:
            continue  # файл в корне библиотеки
        top = rel.split("/", 1)[0]
        counts[top] = counts.get(top, 0) + 1
    return [{"name": k, "abs": root + k, "n": v}
            for k, v in sorted(counts.items(), key=lambda kv: kv[0].lower())]

def find_duplicates(folder: str = "", artist: str = "", album: str = "",
                    limit: int = 200) -> list[dict]:
    """Дубли по исполнителю+названию в пределах текущего фильтра (папка/исполнитель/альбом)."""
    where, args = ["title <> ''"], []
    if folder:
        where.append("path LIKE ?")
        args.append(folder.rstrip("/") + "/%")
    if artist:
        where.append("artist = ?")
        args.append(artist)
    if album:
        where.append("album = ?")
        args.append(album)
    clause = " AND ".join(where)
    with db.connect() as cx:
        groups = cx.execute(
            f"SELECT artist, title, COUNT(*) n FROM tracks WHERE {clause} "
            f"GROUP BY artist COLLATE NOCASE, title COLLATE NOCASE "
            f"HAVING n > 1 ORDER BY n DESC, artist LIMIT ?", args + [limit]).fetchall()
        out = []
        for g in groups:
            copies = cx.execute(
                f"SELECT id, path, size, duration FROM tracks WHERE {clause} "
                f"AND artist = ? COLLATE NOCASE AND title = ? COLLATE NOCASE ORDER BY size DESC",
                args + [g["artist"], g["title"]]).fetchall()
            root = library_path().rstrip("/") + "/"
            items = []
            for c in copies:
                item = dict(c)
                # в окне показываем путь от корня библиотеки — остальное и так известно
                item["rel"] = item["path"][len(root):] if item["path"].startswith(root) else item["path"]
                items.append(item)
            out.append({"artist": g["artist"], "title": g["title"], "n": g["n"], "copies": items})
    return out

def get_track(track_id: int) -> dict | None:
    with db.connect() as cx:
        row = cx.execute("SELECT * FROM tracks WHERE id=?", (track_id,)).fetchone()
    return dict(row) if row else None

def delete_track(track_id: int) -> tuple[bool, str]:
    """Удалить трек с диска и из библиотеки."""
    track = get_track(track_id)
    if not track:
        return False, "Трек не найден"
    root = Path(library_path()).resolve()
    try:
        p = Path(track["path"]).resolve()
        p.relative_to(root)  # не даём удалить что-то вне библиотеки
    except (ValueError, OSError):
        return False, "Файл вне библиотеки"
    try:
        p.unlink(missing_ok=True)
    except OSError as e:
        return False, f"Не удалось удалить файл: {e}"
    (COVER_DIR / f"{track_id}.img").unlink(missing_ok=True)
    with db.connect() as cx:
        cx.execute("DELETE FROM tracks WHERE id=?", (track_id,))
    return True, f"Удалён: {track['title'] or Path(track['path']).name}"

def stats() -> dict:
    with db.connect() as cx:
        r = cx.execute("SELECT COUNT(*) c, COALESCE(SUM(duration),0) d, "
                       "COUNT(DISTINCT artist) a, COUNT(DISTINCT album) al FROM tracks").fetchone()
    return {"tracks": r["c"], "duration": r["d"], "artists": r["a"], "albums": r["al"]}

def list_artists(limit: int = 500) -> list[dict]:
    with db.connect() as cx:
        rows = cx.execute(
            "SELECT artist, COUNT(*) n FROM tracks WHERE artist <> '' "
            "GROUP BY artist COLLATE NOCASE ORDER BY artist COLLATE NOCASE LIMIT ?",
            (limit,)).fetchall()
    return [dict(r) for r in rows]

def list_albums(artist: str = "", limit: int = 500) -> list[dict]:
    args, clause = [], "WHERE album <> ''"
    if artist:
        clause += " AND artist = ?"
        args.append(artist)
    with db.connect() as cx:
        rows = cx.execute(
            f"SELECT album, MAX(albumartist) albumartist, COUNT(*) n, MAX(year) year, "
            f"MIN(CASE WHEN has_cover=1 THEN id END) cover_id "
            f"FROM tracks {clause} GROUP BY album COLLATE NOCASE "
            f"ORDER BY album COLLATE NOCASE LIMIT ?", args + [limit]).fetchall()
    return [dict(r) for r in rows]
