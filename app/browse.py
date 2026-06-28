"""Filesystem browser restricted to mounted disks under MOUNT_ROOT."""
import os
import stat
from pathlib import Path
from .config import MOUNT_ROOT

class BrowseError(Exception): ...

# Служебные имена ФС, которые прячем в браузере (плюс всё, что начинается с точки).
HIDDEN_EXACT = {"lost+found", "System Volume Information", "$RECYCLE.BIN", "RECYCLER",
                "FOUND.000", "$Recycle.Bin"}

def _is_hidden(name: str) -> bool:
    return name.startswith(".") or name in HIDDEN_EXACT

def _resolve_safe(rel_path: str) -> Path:
    base = MOUNT_ROOT.resolve()
    target = (base / rel_path.lstrip("/")).resolve()
    try:
        target.relative_to(base)
    except ValueError:
        raise BrowseError("Путь вне разрешённой зоны")
    return target

def list_dir(rel_path: str) -> dict:
    target = _resolve_safe(rel_path)
    if not target.exists():
        raise BrowseError("Не существует")
    if not target.is_dir():
        raise BrowseError("Не директория")
    entries = []
    try:
        with os.scandir(target) as it:
            for entry in it:
                if _is_hidden(entry.name):
                    continue
                try:
                    st = entry.stat(follow_symlinks=False)
                except OSError:
                    continue
                is_dir = stat.S_ISDIR(st.st_mode)
                entries.append({
                    "name": entry.name,
                    "is_dir": is_dir,
                    "size": st.st_size if not is_dir else None,
                    "size_human": _human(st.st_size) if not is_dir else None,
                    "mtime": _date(st.st_mtime),
                })
    except PermissionError as e:
        raise BrowseError(f"Нет доступа: {e}")
    entries.sort(key=lambda e: (not e["is_dir"], e["name"].lower()))
    rel = str(target.relative_to(MOUNT_ROOT.resolve()))
    if rel == ".": rel = ""
    parent = str(Path(rel).parent) if rel and rel != "/" else None
    if parent == ".": parent = ""
    return {
        "path": rel,
        "abs_path": str(target),
        "parent": parent,
        "entries": entries,
    }

def _human(n: int) -> str:
    units = ["B", "KB", "MB", "GB", "TB"]
    f = float(n); i = 0
    while f >= 1024 and i < len(units) - 1:
        f /= 1024; i += 1
    return f"{f:.1f} {units[i]}" if i else f"{int(f)} {units[i]}"

def _date(ts: float) -> str:
    import datetime
    return datetime.datetime.fromtimestamp(ts).strftime("%d.%m.%Y %H:%M")
