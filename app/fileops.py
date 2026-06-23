"""File operations on mounted disks. All paths confined to MOUNT_ROOT.

Disks are mounted owned by the service user (see disks.py), so these are plain
Python calls — no privilege escalation. Every path is resolved and checked to be
inside MOUNT_ROOT, and a single path component is never allowed to contain a
separator or `..`.
"""
import os
import shutil
from pathlib import Path
from .config import MOUNT_ROOT

class FileOpError(Exception): ...

def _safe_target(rel_path: str) -> Path:
    base = MOUNT_ROOT.resolve()
    target = (base / rel_path.lstrip("/")).resolve()
    if target != base and base not in target.parents:
        raise FileOpError("Путь вне разрешённой зоны")
    return target

def _safe_name(name: str) -> str:
    name = (name or "").strip()
    if not name or name in (".", "..") or "/" in name or "\\" in name or "\0" in name:
        raise FileOpError("Недопустимое имя")
    if len(name) > 255:
        raise FileOpError("Слишком длинное имя")
    return name

def mkdir(rel_parent: str, name: str) -> str:
    name = _safe_name(name)
    parent = _safe_target(rel_parent)
    if not parent.is_dir():
        raise FileOpError("Родительская папка не найдена")
    target = parent / name
    if target.exists():
        raise FileOpError("Уже существует")
    target.mkdir()
    return str(target.relative_to(MOUNT_ROOT.resolve()))

def rename(rel_path: str, new_name: str) -> str:
    new_name = _safe_name(new_name)
    src = _safe_target(rel_path)
    if not src.exists():
        raise FileOpError("Не найдено")
    if os.path.ismount(src):
        raise FileOpError("Нельзя переименовать точку монтирования (это сам диск)")
    dst = src.parent / new_name
    if dst.exists():
        raise FileOpError("Целевое имя уже занято")
    src.rename(dst)
    return str(dst.relative_to(MOUNT_ROOT.resolve()))

def delete(rel_path: str) -> None:
    target = _safe_target(rel_path)
    if target == MOUNT_ROOT.resolve():
        raise FileOpError("Нельзя удалить корень")
    if os.path.ismount(target):
        raise FileOpError("Это точка монтирования диска — отмонтируй его вместо удаления")
    if not target.exists():
        raise FileOpError("Не найдено")
    if target.is_dir() and not target.is_symlink():
        shutil.rmtree(target)
    else:
        target.unlink()

def move(rel_src: str, rel_dest_dir: str) -> str:
    src = _safe_target(rel_src)
    dest_dir = _safe_target(rel_dest_dir)
    if not src.exists():
        raise FileOpError("Источник не найден")
    if os.path.ismount(src):
        raise FileOpError("Нельзя перемещать точку монтирования")
    if not dest_dir.is_dir():
        raise FileOpError("Папка назначения не найдена")
    dst = dest_dir / src.name
    if dst.exists():
        raise FileOpError("В папке назначения уже есть элемент с таким именем")
    if dest_dir == src.parent:
        raise FileOpError("Уже в этой папке")
    # forbid moving a directory into itself / its descendant
    if src.is_dir() and (dest_dir == src or src in dest_dir.parents):
        raise FileOpError("Нельзя переместить папку внутрь самой себя")
    shutil.move(str(src), str(dst))
    return str(dst.relative_to(MOUNT_ROOT.resolve()))

def save_upload(rel_dir: str, filename: str, fileobj) -> str:
    filename = _safe_name(filename)
    dest_dir = _safe_target(rel_dir)
    if not dest_dir.is_dir():
        raise FileOpError("Папка назначения не найдена")
    dst = dest_dir / filename
    with open(dst, "wb") as out:
        shutil.copyfileobj(fileobj, out, length=1024 * 1024)
    return str(dst.relative_to(MOUNT_ROOT.resolve()))

def resolve_file_for_download(rel_path: str) -> Path:
    target = _safe_target(rel_path)
    if not target.is_file():
        raise FileOpError("Это не файл")
    return target

def list_dirs_under_mounts() -> list[str]:
    """Flat list of directories (rel paths) across all mounts — for the move picker."""
    base = MOUNT_ROOT.resolve()
    out: list[str] = []
    for entry in sorted(base.iterdir() if base.exists() else []):
        if not entry.is_dir():
            continue
        out.append(entry.name)
        for root, dirs, _files in os.walk(entry):
            dirs.sort()
            for d in dirs:
                full = Path(root) / d
                try:
                    out.append(str(full.relative_to(base)))
                except ValueError:
                    pass
            # keep the picker light: don't descend more than 3 levels
            if Path(root).relative_to(base).parts.__len__() >= 3:
                dirs[:] = []
    return out
