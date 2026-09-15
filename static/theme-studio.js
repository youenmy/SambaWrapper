/* Конструктор своей темы и графических эффектов.
 *
 * Пользователь задаёт четыре базовых цвета — фон, панели, текст, акцент —
 * плюс скругление, плотность строк и шрифт. Остальные токены вычисляются, а
 * оттенки текста, границ, акцента и статусов подгоняются до порогов WCAG AA
 * тем же способом, каким проверялись готовые темы: светлота сдвигается к
 * ближайшему проходящему значению, тон сохраняется. Своя тема не может
 * получиться нечитаемой молча — если пару не спасти, отчёт это покажет.
 *
 * Эффекты (узор фона, стекло, свечение, цвет из обложки) не привязаны к
 * своей теме и ложатся поверх любой.
 *
 * Файл состоит из двух частей: чистая цветовая математика (её гоняют тесты
 * под node) и панель конструктора для браузера.
 */
(function (root) {
  "use strict";

  // ======================================================= цветовая математика
  function hexToRgb(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
    if (!m) return null;
    var n = parseInt(m[1], 16);
    return {r: n >> 16, g: (n >> 8) & 255, b: n & 255};
  }
  function rgbToHex(c) {
    return "#" + [c.r, c.g, c.b].map(function (v) {
      var x = Math.max(0, Math.min(255, Math.round(v)));
      return (x < 16 ? "0" : "") + x.toString(16);
    }).join("");
  }
  function lum(hex) {
    var c = hexToRgb(hex);
    var f = function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }
  function contrast(a, b) {
    var la = lum(a), lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }
  function mix(a, b, t) {
    var x = hexToRgb(a), y = hexToRgb(b);
    return rgbToHex({r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t});
  }
  function toHsl(hex) {
    var c = hexToRgb(hex), r = c.r / 255, g = c.g / 255, b = c.b / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, h = 0, s = 0;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return {h: h, s: s, l: l};
  }
  function fromHsl(h, s, l) {
    var f = function (n) {
      var k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l);
      return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
    };
    return rgbToHex({r: f(0), g: f(8), b: f(4)});
  }

  /** Сдвигать светлоту цвета, пока контраст со всеми фонами не дойдёт до порога.
   *  Проверяются оба направления на каждом шаге — берётся ближайший проходящий
   *  оттенок. Если спасти нельзя, возвращается лучший из чёрного и белого с ok:false. */
  function ensure(color, bgs, need) {
    var worst = function (hex) {
      var m = Infinity;
      for (var i = 0; i < bgs.length; i++) m = Math.min(m, contrast(hex, bgs[i]));
      return m;
    };
    if (worst(color) >= need) return {color: color, adjusted: false, ok: true};
    var hsl = toHsl(color);
    for (var step = 1; step <= 100; step++) {
      var t = step / 100;
      var darker = fromHsl(hsl.h, hsl.s, hsl.l * (1 - t));
      if (worst(darker) >= need) return {color: darker, adjusted: true, ok: true};
      var lighter = fromHsl(hsl.h, hsl.s, hsl.l + (1 - hsl.l) * t);
      if (worst(lighter) >= need) return {color: lighter, adjusted: true, ok: true};
    }
    var best = worst("#000000") >= worst("#ffffff") ? "#000000" : "#ffffff";
    return {color: best, adjusted: true, ok: worst(best) >= need};
  }

  var DENSITY_PAD = {compact: "0.25rem", normal: "0.4375rem", roomy: "0.625rem"};
  var STATUS = {danger: "#e5484d", ok: "#30a46c", warn: "#f5a524"};

  function rem(px) { return (Math.round(px / 16 * 10000) / 10000) + "rem"; }
  function round2(x) { return Math.round(x * 100) / 100; }

  /** Полный набор токенов из четырёх цветов и формы, с отчётом о читаемости. */
  function derive(input) {
    var bg = input.bg, surface = input.surface, accent = input.accent;
    var dark = lum(surface) < 0.18;
    var s2 = mix(surface, input.text, dark ? 0.06 : 0.035);
    var s3 = mix(surface, input.text, dark ? 0.12 : 0.07);
    var report = [];

    function fit(label, color, bgs, need) {
      var r = ensure(color, bgs, need);
      var ratio = Infinity;
      for (var i = 0; i < bgs.length; i++) ratio = Math.min(ratio, contrast(r.color, bgs[i]));
      report.push({label: label, color: r.color, ratio: round2(ratio), need: need,
                   adjusted: r.adjusted, ok: ratio >= need});
      return r.color;
    }

    var t = {bg: bg, surface: surface, "surface-2": s2, "surface-3": s3};
    t.text = fit("Основной текст", input.text, [bg, surface, s2, s3], 4.5);
    t["text-2"] = fit("Вторичный текст", mix(t.text, surface, 0.2), [surface, s2, s3], 4.5);
    t.muted = fit("Приглушённый текст", mix(t.text, surface, 0.38), [surface, s2, s3], 4.5);
    t.faint = fit("Бледный текст", mix(t.text, surface, 0.5), [surface, s2], 4.5);
    t.border = mix(surface, t.text, dark ? 0.12 : 0.1);
    t["border-2"] = fit("Границы полей", mix(surface, t.text, 0.32), [surface], 3);

    // Акцент — это фон кнопки. Текст на нём выбираем из белого и почти
    // чёрного; если не проходит ни один, сдвигаем сам акцент.
    var onDark = "#ffffff", onLight = "#0b0b0f";
    var acc = accent;
    var accText = contrast(onDark, acc) >= contrast(onLight, acc) ? onDark : onLight;
    if (contrast(accText, acc) < 4.5) acc = ensure(acc, [accText], 4.5).color;
    var btn = contrast(accText, acc);
    report.push({label: "Текст на кнопке", color: acc, ratio: round2(btn), need: 4.5,
                 adjusted: acc !== accent, ok: btn >= 4.5});
    t.accent = acc;
    t["accent-text"] = accText;
    t["accent-hover"] = mix(acc, accText === onDark ? "#000000" : "#ffffff", 0.12);
    t["accent-soft"] = mix(surface, acc, dark ? 0.2 : 0.12);
    t["accent-ink"] = fit("Акцентный текст", acc, [surface, s2, t["accent-soft"]], 4.5);
    t.danger = fit("Ошибка", STATUS.danger, [surface], 4.5);
    t.ok = fit("Успех", STATUS.ok, [surface], 4.5);
    t.warn = fit("Предупреждение", STATUS.warn, [surface], 4.5);

    t["viz-hot-a"] = acc;
    t["viz-hot-b"] = mix(acc, "#ffffff", 0.45);
    var tc = hexToRgb(t.text);
    t["viz-cold"] = "rgba(" + tc.r + "," + tc.g + "," + tc.b + ",0.22)";

    var r = Math.max(0, Math.min(24, Math.round(Number(input.radius_px) || 0)));
    t.radius = rem(r);
    t["radius-sm"] = rem(r * 0.75);
    t["radius-lg"] = rem(r * 1.5);
    t["row-pad"] = DENSITY_PAD[input.density] || DENSITY_PAD.normal;

    return {tokens: t, dark: dark, shadow: dark ? "dark" : "light", report: report};
  }

  var Pure = {hexToRgb: hexToRgb, rgbToHex: rgbToHex, contrast: contrast, mix: mix,
              ensure: ensure, derive: derive, DENSITY_PAD: DENSITY_PAD};
  if (typeof module !== "undefined" && module.exports) module.exports = Pure;
  if (typeof document === "undefined") return;

  // ======================================================= конструктор в браузере
  var html = document.documentElement;
  var LS_THEME = "sw.customTheme", LS_FX = "sw.fx";

  // те же ключи и стеки, что в app/uitheme.py
  var FONT_STACKS = {
    system: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    display: '"Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif',
    mono: 'ui-monospace, "Cascadia Mono", Consolas, "DejaVu Sans Mono", monospace',
    serif: 'Georgia, "Times New Roman", "DejaVu Serif", serif',
  };
  var SHADOWS = {dark: "0 8px 24px rgba(0,0,0,.45)", light: "0 4px 14px rgba(0,0,0,.10)", none: "none"};
  var FONT_LABELS = [["system", "Системный"], ["display", "Округлый"], ["mono", "Моноширинный"], ["serif", "С засечками"]];
  var DENSITY_LABELS = [["compact", "Плотно"], ["normal", "Обычно"], ["roomy", "Просторно"]];
  var FX_BG = [["none", "Без узора"], ["grid", "Сетка"], ["dots", "Точки"], ["lines", "Штриховка"],
               ["noise", "Зерно"], ["aurora", "Аврора"]];
  var COLORS = [["bg", "Фон"], ["surface", "Панели"], ["text", "Текст"], ["accent", "Акцент"]];
  var DEFAULT_FX = {bg: "none", glass: false, glow: false, tint: true};

  var HEX_RE = /^#[0-9a-f]{6}$/i;
  var RGBA_RE = /^rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(?:0|1|0?\.\d{1,3})\s*\)$/;
  var REM_RE = /^\d{1,2}(?:\.\d{1,4})?rem$/;

  function own(obj, key) { return typeof key === "string" && Object.prototype.hasOwnProperty.call(obj, key); }
  function normHex(v) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(v || "").trim());
    return m ? "#" + m[1].toLowerCase() : null;
  }
  function load(key) {
    try {
      var v = JSON.parse(localStorage.getItem(key) || "null");
      return v && typeof v === "object" ? v : null;
    } catch (e) { return null; }
  }
  function store(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* приватный режим */ }
  }

  /* CSS своей темы. Значения фильтруются теми же форматами, что на сервере:
     локальная копия могла быть испорчена, а строка уходит прямо в <style>. */
  function cssFor(theme) {
    var parts = [];
    var tokens = theme && theme.tokens && typeof theme.tokens === "object" ? theme.tokens : {};
    Object.keys(tokens).forEach(function (k) {
      var v = String(tokens[k]);
      if (!/^[a-z0-9-]{1,20}$/.test(k)) return;
      if (HEX_RE.test(v) || RGBA_RE.test(v) || REM_RE.test(v)) parts.push("--sw-" + k + ":" + v);
    });
    parts.push("--sw-font:" + (own(FONT_STACKS, theme.font) ? FONT_STACKS[theme.font] : FONT_STACKS.system));
    parts.push("--sw-shadow:" + (own(SHADOWS, theme.shadow) ? SHADOWS[theme.shadow] : SHADOWS.none));
    return 'html[data-theme="custom"]{' + parts.join(";") + "}";
  }
  function styleEl() {
    var el = document.getElementById("sw-custom-theme");
    if (!el) {
      el = document.createElement("style");
      el.id = "sw-custom-theme";
      document.head.appendChild(el);
    }
    return el;
  }
  function cleanFx(fx) {
    fx = fx && typeof fx === "object" ? fx : {};
    var bg = FX_BG.some(function (x) { return x[0] === fx.bg; }) ? fx.bg : "none";
    return {bg: bg, glass: fx.glass === true, glow: fx.glow === true, tint: fx.tint !== false};
  }
  function applyFx(fx) {
    fx = cleanFx(fx);
    html.setAttribute("data-fx-bg", fx.bg);
    html.toggleAttribute("data-fx-glass", fx.glass);
    html.toggleAttribute("data-fx-glow", fx.glow);
    if (fx.tint) html.removeAttribute("data-fx-tint"); else html.setAttribute("data-fx-tint", "off");
  }
  function refreshMusic() {
    if (!window.Music) return;
    if (Music.viz) Music.viz.recolor();
    if (Music.tint) Music.tint.refresh();
  }

  /* Цвета готовой темы. Тема на мгновение переключается и сразу возвращается:
     getComputedStyle пересчитывает стили синхронно, кадр между этим не рисуется,
     поэтому пользователь переключения не видит. */
  function readPreset(id) {
    var prevTheme = html.dataset.theme, prevDark = html.classList.contains("dark");
    html.dataset.theme = id;
    if (id !== "classic") {
      var light = (window.SW && SW.lightSkins || []).indexOf(id) >= 0;
      html.classList.toggle("dark", !light);
    }
    var cs = getComputedStyle(html);
    var pick = function (name, fallback) { return normHex(cs.getPropertyValue(name)) || fallback; };
    var radius = parseFloat(cs.getPropertyValue("--sw-radius")) || 0.5;
    var out = {
      bg: pick("--sw-bg", "#f1f5f9"), surface: pick("--sw-surface", "#ffffff"),
      text: pick("--sw-text", "#0f172a"), accent: pick("--sw-accent", "#0284c7"),
      radius_px: Math.round(radius * 16),
    };
    html.dataset.theme = prevTheme;
    html.classList.toggle("dark", prevDark);
    return out;
  }

  function el(tag, props, kids) {
    var node = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      var v = props[k];
      if (k === "text") node.textContent = v;
      else if (k === "class") node.className = v;
      else if (k.slice(0, 2) === "on") node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    });
    (kids || []).forEach(function (kid) { if (kid) node.appendChild(kid); });
    return node;
  }

  var ui = null;   // открытая панель и её состояние

  function build() {
    var presets = el("select", {id: "st-base", onchange: function () {
      if (!this.value) return;
      var p = readPreset(this.value);
      ui.state.bg = p.bg; ui.state.surface = p.surface; ui.state.text = p.text; ui.state.accent = p.accent;
      ui.state.radius_px = p.radius_px;
      ui.touched = true;
      sync(); preview();
    }}, [el("option", {value: "", text: "— выбрать —"})]);
    (window.SW && SW.skins || []).forEach(function (s) {
      presets.appendChild(el("option", {value: s[0], text: s[1]}));
    });

    var colors = el("div", {class: "st-colors"});
    COLORS.forEach(function (c) {
      var key = c[0];
      colors.appendChild(el("div", {class: "st-color"}, [
        el("input", {type: "color", id: "st-c-" + key, "aria-label": c[1], oninput: function () {
          ui.state[key] = this.value.toLowerCase();
          ui.touched = true;
          ui.panel.querySelector("#st-h-" + key).value = ui.state[key];
          preview();
        }}),
        el("span", {class: "st-color-box"}, [
          el("span", {class: "st-color-name", text: c[1]}),
          el("input", {type: "text", id: "st-h-" + key, class: "st-hex", maxlength: "7", spellcheck: "false",
                       "aria-label": c[1] + ", шестнадцатеричный код", oninput: function () {
            var hex = normHex(this.value);
            if (!hex) return;
            ui.state[key] = hex;
            ui.touched = true;
            ui.panel.querySelector("#st-c-" + key).value = hex;
            preview();
          }}),
        ]),
      ]));
    });

    var density = el("div", {class: "st-seg", role: "group", "aria-label": "Плотность строк"});
    DENSITY_LABELS.forEach(function (d) {
      density.appendChild(el("button", {type: "button", "data-density": d[0], text: d[1], onclick: function () {
        ui.state.density = d[0];
        ui.touched = true;
        sync(); preview();
      }}));
    });

    var fonts = el("select", {id: "st-font", onchange: function () {
      ui.state.font = this.value; ui.touched = true; preview();
    }});
    FONT_LABELS.forEach(function (f) { fonts.appendChild(el("option", {value: f[0], text: f[1]})); });

    var chips = el("div", {class: "st-chips", role: "group", "aria-label": "Узор фона"});
    FX_BG.forEach(function (b) {
      chips.appendChild(el("button", {type: "button", class: "st-chip", "data-bg": b[0], text: b[1], onclick: function () {
        ui.fx.bg = b[0]; sync(); preview();
      }}));
    });

    function toggle(id, label, field, invert) {
      return el("label", {class: "st-switch"}, [
        el("input", {type: "checkbox", id: id, onchange: function () { ui.fx[field] = this.checked; preview(); }}),
        el("span", {text: label}),
      ]);
    }

    return el("aside", {id: "sw-studio", class: "st", role: "dialog", "aria-modal": "false", "aria-labelledby": "st-title"}, [
      el("div", {class: "st-head"}, [
        el("div", {}, [
          el("div", {id: "st-title", class: "st-title", text: "Своя тема и эффекты"}),
          el("div", {id: "st-mode", class: "st-mode"}),
        ]),
        el("button", {type: "button", class: "st-x", "aria-label": "Закрыть без сохранения", title: "Закрыть без сохранения (Esc)",
                      onclick: function () { Studio.cancel(); }}, [el("i", {class: "ti ti-x"})]),
      ]),
      el("div", {class: "st-body"}, [
        el("section", {class: "st-sec"}, [
          el("h4", {class: "st-h", text: "Основа"}),
          el("div", {class: "st-field"}, [el("label", {for: "st-base", text: "Начать с готовой темы"}), presets]),
          el("div", {class: "st-field"}, [el("label", {for: "st-name", text: "Название"}),
            // название тоже пересчитывает тему: сохраняется то, что собрал
            // последний пересчёт, и без него введённое имя терялось
            el("input", {type: "text", id: "st-name", maxlength: "40", oninput: function () {
              ui.state.name = this.value;
              preview();
            }})]),
        ]),
        el("section", {class: "st-sec"}, [el("h4", {class: "st-h", text: "Цвета"}), colors]),
        el("section", {class: "st-sec"}, [
          el("h4", {class: "st-h", text: "Форма"}),
          el("div", {class: "st-field"}, [
            el("label", {for: "st-radius", class: "st-lbl"}, [el("span", {text: "Скругление "}), el("output", {id: "st-radius-out"})]),
            el("input", {type: "range", id: "st-radius", min: "0", max: "20", step: "1", oninput: function () {
              ui.state.radius_px = Number(this.value); ui.touched = true;
              ui.panel.querySelector("#st-radius-out").textContent = this.value + " px";
              preview();
            }}),
          ]),
          el("div", {class: "st-field"}, [el("span", {class: "st-lbl", text: "Плотность строк"}), density]),
          el("div", {class: "st-field"}, [el("label", {for: "st-font", text: "Шрифт"}), fonts]),
        ]),
        el("section", {class: "st-sec"}, [
          el("h4", {class: "st-h"}, [el("span", {text: "Эффекты"}), el("span", {class: "st-note", text: "для любой темы"})]),
          chips,
          toggle("st-glass", "Стекло — полупрозрачные панели с размытием", "glass"),
          toggle("st-glow", "Свечение акцентных элементов", "glow"),
          toggle("st-tint", "Цвет из обложки играющего трека", "tint"),
        ]),
        el("section", {class: "st-sec"}, [
          el("h4", {class: "st-h", text: "Читаемость"}),
          el("p", {id: "st-summary", class: "st-summary"}),
          el("ul", {id: "st-report", class: "st-report"}),
          el("p", {class: "st-note", text: "Оттенки, не дотягивавшие до WCAG AA, подкручены автоматически — тон сохраняется."}),
        ]),
      ]),
      el("div", {class: "st-foot"}, [
        el("button", {type: "button", class: "st-btn", title: "Скопировать описание темы", onclick: exportTheme}, [el("i", {class: "ti ti-copy"})]),
        el("button", {type: "button", class: "st-btn", title: "Вставить описание темы", onclick: function () {
          SW.prompt("Вставь описание темы (JSON)", "", importTheme, {ok: "Загрузить"});
        }}, [el("i", {class: "ti ti-clipboard-text"})]),
        el("span", {class: "st-spacer"}),
        el("button", {type: "button", class: "st-btn", text: "Отмена", onclick: function () { Studio.cancel(); }}),
        el("button", {type: "button", class: "st-btn st-primary", text: "Сохранить", onclick: function () { Studio.save(); }}),
      ]),
    ]);
  }

  /** Перенести состояние в элементы панели. */
  function sync() {
    var p = ui.panel, s = ui.state;
    COLORS.forEach(function (c) {
      p.querySelector("#st-c-" + c[0]).value = s[c[0]];
      p.querySelector("#st-h-" + c[0]).value = s[c[0]];
    });
    p.querySelector("#st-name").value = s.name || "";
    p.querySelector("#st-radius").value = s.radius_px;
    p.querySelector("#st-radius-out").textContent = s.radius_px + " px";
    p.querySelector("#st-font").value = s.font;
    p.querySelectorAll("[data-density]").forEach(function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-density") === s.density ? "true" : "false");
    });
    p.querySelectorAll("[data-bg]").forEach(function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-bg") === ui.fx.bg ? "true" : "false");
    });
    p.querySelector("#st-glass").checked = ui.fx.glass;
    p.querySelector("#st-glow").checked = ui.fx.glow;
    p.querySelector("#st-tint").checked = ui.fx.tint;
  }

  /** Пересчитать тему и показать её на живом приложении. */
  function preview() {
    var d = derive(ui.state);
    ui.theme = {
      v: 1, name: (String(ui.state.name || "").trim() || "Своя тема").slice(0, 40), dark: d.dark,
      font: ui.state.font, shadow: d.shadow, density: ui.state.density, radius_px: ui.state.radius_px,
      base: {bg: ui.state.bg, surface: ui.state.surface, text: ui.state.text, accent: ui.state.accent},
      tokens: d.tokens,
    };
    // цвета трогали — показываем свою тему; нет — эффекты ложатся на текущую
    if (ui.touched) {
      styleEl().textContent = cssFor(ui.theme);
      html.dataset.theme = "custom";
      html.classList.toggle("dark", d.dark);
    }
    applyFx(ui.fx);
    refreshMusic();
    renderReport(d.report);
    ui.panel.querySelector("#st-mode").textContent = ui.touched
      ? "Предпросмотр своей темы"
      : "Цвета не тронуты — эффекты ложатся на текущую тему";
  }

  function renderReport(items) {
    var list = ui.panel.querySelector("#st-report");
    list.textContent = "";
    var bad = 0;
    items.forEach(function (it) {
      if (!it.ok) bad++;
      var swatch = el("span", {class: "st-swatch", "aria-hidden": "true"});
      swatch.style.background = it.color;
      var verdict = it.ratio.toFixed(2) + " : 1";
      if (!it.ok) verdict += " · ниже " + it.need;
      else if (it.adjusted) verdict += " · подкручено";
      list.appendChild(el("li", {class: it.ok ? (it.adjusted ? "st-fixed" : "st-pass") : "st-fail"}, [
        swatch, el("span", {class: "st-rl", text: it.label}), el("span", {class: "st-rv", text: verdict}),
      ]));
    });
    var sum = ui.panel.querySelector("#st-summary");
    sum.textContent = bad
      ? "Не все пары читаемы — сделай панели заметно светлее или темнее"
      : "Все пары проходят WCAG AA";
    sum.className = "st-summary " + (bad ? "st-fail" : "st-pass");
  }

  function exportTheme() {
    var data = {name: ui.theme.name, base: ui.theme.base, font: ui.state.font,
                density: ui.state.density, radius_px: ui.state.radius_px, fx: ui.fx};
    SW._copyText(JSON.stringify(data, null, 2), function () { SW.toast("Описание темы скопировано"); });
  }

  /* Импорт берёт только исходные параметры, а токены пересчитывает сам:
     чужой JSON не может протащить готовые значения мимо подгонки контраста. */
  function importTheme(text) {
    if (!ui) return;
    var o;
    try { o = JSON.parse(text); } catch (e) { SW.toast("Не получилось прочитать описание темы"); return; }
    var b = o && typeof o === "object" ? (o.base && typeof o.base === "object" ? o.base : o) : {};
    var next = {bg: normHex(b.bg), surface: normHex(b.surface), text: normHex(b.text), accent: normHex(b.accent)};
    if (!next.bg || !next.surface || !next.text || !next.accent) {
      SW.toast("В описании не хватает цветов: bg, surface, text, accent");
      return;
    }
    ui.state.bg = next.bg; ui.state.surface = next.surface; ui.state.text = next.text; ui.state.accent = next.accent;
    if (typeof o.name === "string") ui.state.name = o.name.slice(0, 40);
    if (own(FONT_STACKS, o.font)) ui.state.font = o.font;
    if (own(DENSITY_PAD, o.density)) ui.state.density = o.density;
    if (typeof o.radius_px === "number" && isFinite(o.radius_px)) {
      ui.state.radius_px = Math.max(0, Math.min(20, Math.round(o.radius_px)));
    }
    if (o.fx && typeof o.fx === "object") ui.fx = cleanFx(o.fx);
    ui.touched = true;
    sync(); preview();
    SW.toast("Тема загружена — проверь и сохрани");
  }

  function close() {
    document.removeEventListener("keydown", ui.keys, true);
    ui.panel.remove();
    var back = ui.returnFocus;
    ui = null;
    if (back && back.focus && document.body.contains(back)) back.focus({preventScroll: true});
    if (window.SW && SW._syncTheme) SW._syncTheme();
  }

  var Studio = root.Studio = {
    /** Сохранённая своя тема или null. */
    saved: function () {
      var t = load(LS_THEME);
      return t && t.tokens && typeof t.tokens === "object" ? t : null;
    },
    fx: function () { return cleanFx(load(LS_FX) || DEFAULT_FX); },
    isOpen: function () { return !!ui; },

    /** Настройки пришли с другого устройства — переложить их в страницу. */
    applySaved: function () {
      if (ui) return;                                    // не мешаем открытому конструктору
      var t = Studio.saved();
      styleEl().textContent = t ? cssFor(t) : "";
      if (html.dataset.theme === "custom") {
        if (t) html.classList.toggle("dark", t.dark === true);
        else if (window.SW && SW.setSkin) SW.setSkin("classic");   // своей темы больше нет
      }
      applyFx(Studio.fx());
      refreshMusic();
    },

    open: function () {
      if (ui) { ui.panel.querySelector("#st-base").focus(); return; }
      var saved = Studio.saved();
      var current = html.dataset.theme || "classic";
      var start;
      if (saved && saved.base && normHex(saved.base.bg) && normHex(saved.base.surface)
          && normHex(saved.base.text) && normHex(saved.base.accent)) {
        start = {name: saved.name || "Своя тема", bg: saved.base.bg, surface: saved.base.surface,
                 text: saved.base.text, accent: saved.base.accent,
                 radius_px: typeof saved.radius_px === "number" ? saved.radius_px : 8,
                 density: own(DENSITY_PAD, saved.density) ? saved.density : "normal",
                 font: own(FONT_STACKS, saved.font) ? saved.font : "system"};
      } else {
        var p = readPreset(current === "custom" ? "classic" : current);
        start = {name: "Своя тема", bg: p.bg, surface: p.surface, text: p.text, accent: p.accent,
                 radius_px: p.radius_px, density: "normal", font: "system"};
      }
      ui = {
        state: start,
        fx: Studio.fx(),
        touched: current === "custom",                     // правки цвета включают свою тему; эффекты — нет
        snapshot: {theme: current, dark: html.classList.contains("dark"),
                   css: styleEl().textContent, fx: Studio.fx()},
        returnFocus: document.activeElement,
      };
      ui.panel = build();
      document.body.appendChild(ui.panel);
      ui.keys = function (e) {
        var ask = document.getElementById("confirm-host");
        if (ask && !ask.classList.contains("hidden")) return;       // открыт вопрос «вставь тему»
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); Studio.cancel(); }
      };
      document.addEventListener("keydown", ui.keys, true);
      sync();
      preview();
      ui.panel.querySelector("#st-base").focus();
    },

    /** Закрыть без сохранения и вернуть всё, как было до открытия. */
    cancel: function () {
      if (!ui) return;
      var s = ui.snapshot;
      styleEl().textContent = s.css;
      html.dataset.theme = s.theme;
      html.classList.toggle("dark", s.dark);
      applyFx(s.fx);
      refreshMusic();
      close();
    },

    save: function () {
      if (!ui) return;
      store(LS_FX, ui.fx);
      if (window.SW && SW.savePref) SW.savePref("fx");
      var msg = "Эффекты сохранены";
      if (ui.touched) {
        store(LS_THEME, ui.theme);
        try { localStorage.setItem("sw.skin", "custom"); } catch (e) { /* приватный режим */ }
        if (window.SW && SW.savePref) { SW.savePref("customTheme"); SW.savePref("skin"); }
        msg = "Своя тема «" + ui.theme.name + "» сохранена";
      }
      close();
      if (window.SW && SW.toast) SW.toast(msg);
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
