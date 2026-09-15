"""Своя тема, графические эффекты и картинка фона: проверка того, что пришло
из браузера.

Токены своей темы попадают в <style> каждой страницы пользователя, поэтому
сервер не доверяет присланному. Пропускаются только известные ключи и только
значения узких форматов: цвет #rrggbb, rgba(…) из чисел, длина в rem. Шрифт
и тень выбираются из фиксированных списков по ключу. Всё остальное молча
отбрасывается — через настройки нельзя подсунуть произвольный CSS или
закрыть тег <style>.

Картинка фона хранится файлом на сервере, а в настройках — только номер
версии. Файл перекодируется: до диска доходят лишь пиксели.
"""
import hashlib
import io
import re
import time
from pathlib import Path

from .config import DATA_DIR

_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
_RGBA = re.compile(r"^rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(?:0|1|0?\.\d{1,3})\s*\)$")
_REM = re.compile(r"^\d{1,2}(?:\.\d{1,4})?rem$")

COLOR_TOKENS = ("bg", "surface", "surface-2", "surface-3", "text", "text-2", "muted", "faint",
                "border", "border-2", "accent", "accent-hover", "accent-text", "accent-soft",
                "accent-ink", "danger", "ok", "warn", "viz-hot-a", "viz-hot-b")
RGBA_TOKENS = ("viz-cold",)
LENGTH_TOKENS = ("radius", "radius-sm", "radius-lg", "row-pad")
REQUIRED = ("bg", "surface", "text", "accent", "accent-text")
BASE_KEYS = ("bg", "surface", "text", "accent")

# те же ключи и стеки, что в static/theme-studio.js
FONTS = {
    "system": 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    "display": '"Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif',
    "mono": 'ui-monospace, "Cascadia Mono", Consolas, "DejaVu Sans Mono", monospace',
    "serif": 'Georgia, "Times New Roman", "DejaVu Serif", serif',
}
SHADOWS = {
    "dark": "0 8px 24px rgba(0,0,0,.45)",
    "light": "0 4px 14px rgba(0,0,0,.10)",
    "none": "none",
}
DENSITY = ("compact", "normal", "roomy")
FX_BG = ("none", "grid", "dots", "lines", "noise", "aurora", "image")

BG_DIR = DATA_DIR / "theme-bg"
BG_MAX_BYTES = 12 * 1024 * 1024
BG_MAX_PX = 2560                  # длинная сторона после уменьшения
BG_MAX_PIXELS = 50_000_000        # крошечный файл с огромным разрешением — «бомба» для памяти
BG_FORMATS = ("JPEG", "PNG", "WEBP", "GIF", "BMP")


def _pick(value, allowed, default):
    """Значение из разрешённого набора. Проверка типа нужна до `in`: список
    или словарь в `in dict` вызвал бы TypeError вместо тихого отказа."""
    return value if isinstance(value, str) and value in allowed else default


def _int(value, lo, hi, default):
    if isinstance(value, bool):
        return default
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, number))


def _float(value, lo, hi, default):
    if isinstance(value, bool):
        return default
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if number != number:          # NaN
        return default
    return round(max(lo, min(hi, number)), 2)


def clean_custom_theme(value) -> dict | None:
    """Проверенная копия своей темы или None, если собрать её нельзя."""
    if not isinstance(value, dict):
        return None
    raw = value.get("tokens")
    if not isinstance(raw, dict):
        return None
    tokens = {}
    for key in COLOR_TOKENS:
        v = raw.get(key)
        if isinstance(v, str) and _HEX.match(v):
            tokens[key] = v.lower()
    for key in RGBA_TOKENS:
        v = raw.get(key)
        if isinstance(v, str) and _RGBA.match(v):
            tokens[key] = v.replace(" ", "")
    for key in LENGTH_TOKENS:
        v = raw.get(key)
        if isinstance(v, str) and _REM.match(v):
            tokens[key] = v
    # без основных цветов тема не собирается — лучше не применять ничего,
    # чем показать страницу с половиной токенов от классической темы
    if not all(k in tokens for k in REQUIRED):
        return None
    base = value.get("base") if isinstance(value.get("base"), dict) else {}
    name = value.get("name")
    return {
        "v": 1,
        "name": (name if isinstance(name, str) and name.strip() else "Своя тема")[:40],
        "dark": value.get("dark") is True,
        "font": _pick(value.get("font"), FONTS, "system"),
        "shadow": _pick(value.get("shadow"), SHADOWS, "none"),
        "density": _pick(value.get("density"), DENSITY, "normal"),
        "radius_px": _int(value.get("radius_px"), 0, 24, 8),
        "base": {k: base[k].lower() for k in BASE_KEYS
                 if isinstance(base.get(k), str) and _HEX.match(base[k])},
        "tokens": tokens,
    }


def clean_fx(value) -> dict:
    """Эффекты оформления: неизвестное превращается в «выключено»."""
    v = value if isinstance(value, dict) else {}
    image_v = _int(v.get("image_v"), 0, 10 ** 15, 0)
    bg = _pick(v.get("bg"), FX_BG, "none")
    if bg == "image" and not image_v:
        bg = "none"                   # картинки нет — и фона-картинки нет
    return {
        "bg": bg,
        "glass": v.get("glass") is True,
        "glow": v.get("glow") is True,
        # подкраска цветом обложки включена, пока её явно не выключили
        "tint": v.get("tint") is not False,
        "image_v": image_v,
        "dim": _float(v.get("dim"), 0.0, 0.85, 0.35),
        "blur": _int(v.get("blur"), 0, 24, 0),
    }


def custom_css(theme: dict | None) -> str:
    """CSS-блок своей темы. Принимает только результат clean_custom_theme."""
    if not theme:
        return ""
    parts = [f"--sw-{k}:{v}" for k, v in theme["tokens"].items()]
    parts.append("--sw-font:" + FONTS[theme["font"]])
    parts.append("--sw-shadow:" + SHADOWS[theme["shadow"]])
    return 'html[data-theme="custom"]{' + ";".join(parts) + "}"


def fx_style(fx: dict) -> str:
    """Переменные картинки фона для атрибута style у <html>.
    Принимает только результат clean_fx: адрес собирается из числа версии."""
    if fx.get("bg") != "image" or not fx.get("image_v"):
        return ""
    return (f"--fx-image:url('/theme-bg?v={int(fx['image_v'])}');"
            f"--fx-dim:{float(fx['dim'])};--fx-blur:{int(fx['blur'])}px")


# ---------- картинка фона ----------

def _user_key(username: str) -> str:
    """Имя файла — не сам логин: логин может содержать что угодно, включая
    разделители пути. Хеш даёт короткое и безопасное имя."""
    return hashlib.sha1(username.encode("utf-8")).hexdigest()[:16]


def bg_path(username: str, version: int) -> Path:
    return BG_DIR / f"{_user_key(username)}-{int(version)}.jpg"


def _versions(username: str) -> dict[int, Path]:
    key = _user_key(username)
    found = {}
    if not BG_DIR.is_dir():
        return found
    for path in BG_DIR.glob(key + "-*.jpg"):
        tail = path.stem[len(key) + 1:]
        if tail.isdigit():
            found[int(tail)] = path
    return found


def save_background(username: str, data: bytes, keep_version: int | None = None) -> int:
    """Проверить, перекодировать и сохранить картинку. Возвращает номер версии.

    Хранится не больше двух файлов: тот, на который ссылаются сохранённые
    настройки (keep_version), и только что загруженный. Так «Отмена» в
    конструкторе после загрузки не теряет прежнюю картинку."""
    if not data:
        raise ValueError("Файл пустой")
    if len(data) > BG_MAX_BYTES:
        raise ValueError("Картинка больше 12 МБ")
    try:
        from PIL import Image, ImageOps
    except ImportError:
        raise ValueError("На сервере нет Pillow — картинки фона не поддерживаются")
    try:
        probe = Image.open(io.BytesIO(data))
        if probe.format not in BG_FORMATS:
            raise ValueError("формат")
        width, height = probe.size       # размер читается из заголовка, пиксели ещё не загружены
        if width * height > BG_MAX_PIXELS:
            raise OverflowError
        probe.verify()
        img = Image.open(io.BytesIO(data))
        img = ImageOps.exif_transpose(img)
        img = img.convert("RGB")
        img.thumbnail((BG_MAX_PX, BG_MAX_PX))
    except OverflowError:
        raise ValueError("Слишком большое разрешение картинки")
    except Exception:
        raise ValueError("Это не изображение или файл повреждён")

    BG_DIR.mkdir(parents=True, exist_ok=True)
    existing = _versions(username)
    version = int(time.time() * 1000)
    while version in existing:
        version += 1
    final = bg_path(username, version)
    part = final.with_suffix(".part")        # не попадает под маску *.jpg, пока не дописан
    img.save(part, "JPEG", quality=85, optimize=True, progressive=True)
    part.replace(final)
    drop_backgrounds(username, keep=(version, keep_version))
    return version


def drop_backgrounds(username: str, keep=()) -> None:
    """Удалить картинки пользователя, кроме перечисленных версий."""
    keep_set = {int(k) for k in keep if k}
    for version, path in _versions(username).items():
        if version not in keep_set:
            path.unlink(missing_ok=True)


def rename_backgrounds(old: str, new: str) -> None:
    """Пользователя переименовали — картинки переезжают вместе с настройками."""
    for version, path in _versions(old).items():
        path.replace(bg_path(new, version))
