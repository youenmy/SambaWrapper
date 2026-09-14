/* Общие мелочи интерфейса, которым нужен один источник истины.
 *
 * Выделение диапазона одинаково в файловом браузере и в списке треков,
 * появление строк — во всех списках, мини-графики — у торрентов. Код живёт
 * отдельным файлом, а не внутри шаблона: так его можно проверить на стенде,
 * не поднимая всё приложение с авторизацией.
 */
(function () {
  "use strict";

  /** Ключи строк от якоря до нажатой включительно, в порядке списка.
   *  Якоря нет или он уехал из списка — диапазон из одной нажатой строки. */
  function range(keys, anchor, key) {
    var to = keys.indexOf(key);
    if (to < 0) return [];
    var from = keys.indexOf(anchor);
    if (from < 0) from = to;
    return keys.slice(Math.min(from, to), Math.max(from, to) + 1);
  }

  /* Ctrl+A (⌘A на маке). Проверяем и физическую клавишу, и символ: e.code
     не зависит от раскладки, но бывает пустым у сгенерированных событий,
     а e.key на русской раскладке даёт «ф». */
  function isSelectAll(e) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return false;
    return e.code === "KeyA" || /^[aAфФ]$/.test(e.key || "");
  }

  /* Shift+клик по строке списка выделяет строки, а не текст страницы.
     Слушатель один на всё приложение: списки перерисовываются, document — нет.
     Клик после отменённого mousedown всё равно приходит, поэтому галочки
     и сами строки продолжают нажиматься. */
  document.addEventListener("mousedown", function (e) {
    if (!e.shiftKey || !e.target || !e.target.closest) return;
    if (e.target.closest(".frow, .mrow")) e.preventDefault();
  });

  /* Строки нового списка проявляются короткой волной: первые 16 с шагом
     15 мс, остальные сразу — ждать конца волны на длинном списке незачем.
     Строки, которые уже были на экране (подгрузка следующей страницы
     дописывает к ним новые), повторно не анимируются. */
  var WAVE = 16, STEP = 15;
  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }
  function settle(row) {
    row.classList.remove("sw-enter");
    row.style.animationDelay = "";
  }
  function enterRows(nodes) {
    if (!nodes) return 0;
    var skipMotion = reducedMotion(), shown = 0;
    for (var i = 0; i < nodes.length; i++) {
      var row = nodes[i];
      if (row.dataset.entered) continue;
      row.dataset.entered = "1";
      if (skipMotion || shown >= WAVE) continue;
      var delay = shown * STEP;
      row.style.animationDelay = delay + "ms";
      row.classList.add("sw-enter");
      row.addEventListener("animationend", function (e) { settle(e.currentTarget); }, {once: true});
      // Анимация может вовсе не начаться — строка скрыта или вкладка в фоне.
      // Тогда animationend не придёт, и класс снимается по таймеру.
      setTimeout(settle.bind(null, row), delay + 600);
      shown++;
    }
    return shown;
  }

  /* Мини-графики скорости.
   *
   * История живёт в памяти вкладки: 30 последних замеров на ключ, при опросе
   * раз в 2 секунды это минута. Сервер ничего не хранит — после перезагрузки
   * график начинается заново, а для «что происходит прямо сейчас» этого
   * хватает. Рисуется SVG, а не canvas: строк много, SVG не нужно
   * пересчитывать под плотность пикселей, и он берёт цвет текста ячейки. */
  var LIMIT = 30;
  var hist = {};

  function push(key, value) {
    var h = hist[key] || (hist[key] = []);
    h.push(Math.max(0, Number(value) || 0));
    if (h.length > LIMIT) h.shift();
  }
  function series(key) { return hist[key] || []; }

  function draw(svg) {
    var data = series(svg.getAttribute("data-spark"));
    var w = 100, h = 24;                      // координаты viewBox; размер на экране задаёт CSS
    var max = 0;
    for (var i = 0; i < data.length; i++) if (data[i] > max) max = data[i];
    // ничего не качалось — линии нет: ровный ноль на каждой строке был бы шумом
    if (data.length < 2 || max === 0) {
      svg.innerHTML = "";
      svg.setAttribute("data-empty", "1");
      return;
    }
    svg.removeAttribute("data-empty");
    var step = w / (LIMIT - 1);
    var offset = (LIMIT - data.length) * step; // свежие точки прижаты к правому краю
    var pts = [];
    for (var k = 0; k < data.length; k++) {
      var x = offset + k * step;
      var y = h - 2 - (data[k] / max) * (h - 4);
      pts.push(x.toFixed(1) + "," + y.toFixed(1));
    }
    var area = "M" + offset.toFixed(1) + "," + h + " L" + pts.join(" L") + " L" + w + "," + h + " Z";
    svg.setAttribute("viewBox", "0 0 " + w + " " + h);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.innerHTML =
      '<path d="' + area + '" fill="currentColor" fill-opacity="0.16" stroke="none"></path>' +
      '<polyline points="' + pts.join(" ") + '" fill="none" stroke="currentColor" stroke-width="1.6"' +
      ' stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"></polyline>';
  }
  function drawAll(root) {
    if (!root) return;
    var list = root.querySelectorAll("svg[data-spark]");
    for (var i = 0; i < list.length; i++) draw(list[i]);
  }

  window.UI = {
    range: range,
    isSelectAll: isSelectAll,
    enterRows: enterRows,
    spark: {push: push, series: series, draw: draw, drawAll: drawAll, limit: LIMIT},
  };
})();
