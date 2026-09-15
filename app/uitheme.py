"""Своя тема и графические эффекты: проверка того, что пришло из браузера.

Токены своей темы попадают в <style> каждой страницы пользователя, поэтому
сервер не доверяет присланному. Пропускаются только известные ключи и только
значения узких форматов: цвет #rrggbb, rgba(…) из чисел, длина в rem. Шрифт
и тень выбираются из фиксированных списков по ключу. Всё остальное молча
отбрасывается — через настройки нельзя подсунуть произвольный CSS или
закрыть тег <style>.
"""
import re

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
FX_BG = ("none", "grid", "dots", "lines", "noise", "aurora")


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
    return {
        "bg": _pick(v.get("bg"), FX_BG, "none"),
        "glass": v.get("glass") is True,
        "glow": v.get("glow") is True,
        # подкраска цветом обложки включена, пока её явно не выключили
        "tint": v.get("tint") is not False,
    }


def custom_css(theme: dict | None) -> str:
    """CSS-блок своей темы. Принимает только результат clean_custom_theme."""
    if not theme:
        return ""
    parts = [f"--sw-{k}:{v}" for k, v in theme["tokens"].items()]
    parts.append("--sw-font:" + FONTS[theme["font"]])
    parts.append("--sw-shadow:" + SHADOWS[theme["shadow"]])
    return 'html[data-theme="custom"]{' + ";".join(parts) + "}"
