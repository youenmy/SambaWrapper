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

  /* Прокручен ли контейнер вниз и вбок. Стеклянным эффектам нужно знать, есть
     ли что-то под липкой шапкой или колонкой: в покое они прозрачны, фон
     появляется, только когда под ними проезжают строки. Событие scroll не
     всплывает, поэтому слушаем на погружении — один слушатель на все списки.
     Класс переключается, только когда состояние меняется, так что частые
     события прокрутки не трогают стили лишний раз. */
  document.addEventListener("scroll", function (e) {
    var box = e.target;
    if (!box || box.nodeType !== 1) return;          // прокрутка самой страницы
    var y = box.scrollTop > 0, x = box.scrollLeft > 0;
    if (box.classList.contains("sw-scrolled-y") !== y) box.classList.toggle("sw-scrolled-y", y);
    if (box.classList.contains("sw-scrolled-x") !== x) box.classList.toggle("sw-scrolled-x", x);
  }, true);

  /* Строки нового списка проявляются короткой волной — сверху до низа экрана.
     Раньше волна охватывала фиксированные 16 строк и на высоком мониторе
     обрывалась примерно на 70 % высоты. Теперь анимируются все новые строки,
     которые видны в окне (но не больше 60), а шаг подстраивается так, чтобы
     вся волна укладывалась примерно в треть секунды: 24 строки — по 15 мс,
     40 строк — по 9 мс. Строки ниже края окна и дописанные при подгрузке
     следующей страницы появляются сразу; уже показанные повторно не
     анимируются. */
  var STEP = 15, SPREAD = 360, MAX_WAVE = 60;
  function settle(row) {
    row.classList.remove("sw-enter");
    row.style.animationDelay = "";
  }
  /* Видимые строки — те, что пересекаются и с окном браузера, и с окном
     прокрутки списка. Раньше считались строки «от начала списка до низа
     экрана»: когда плеер прокручивал список к играющему треку, анимации
     уходили строкам, уехавшим вверх за экран, а видимая часть появлялась
     рывком. */
  function viewport(row) {
    var top = 0, bottom = window.innerHeight || document.documentElement.clientHeight;
    for (var el = row.parentElement; el && el !== document.body; el = el.parentElement) {
      var oy = getComputedStyle(el).overflowY;
      if (oy === "auto" || oy === "scroll") {
        var r = el.getBoundingClientRect();
        top = Math.max(top, r.top);
        bottom = Math.min(bottom, r.bottom);
        break;
      }
    }
    return {top: top, bottom: bottom};
  }
  function enterRows(nodes) {
    if (!nodes) return 0;
    var fresh = [];
    for (var i = 0; i < nodes.length; i++) {
      if (!nodes[i].dataset.entered) fresh.push(nodes[i]);
      nodes[i].dataset.entered = "1";
    }
    // в фоновой вкладке волну никто не увидит — строки просто появляются
    if (!fresh.length || document.hidden) return 0;
    /* Список перерисовали второй раз подряд — например, «вся библиотека
       вперемешку» сначала сбрасывает фильтры, а потом прыгает к странице
       выбранного трека. Для глаза это одна смена списка, вторая волна
       выглядела повтором. */
    var box = fresh[0].parentElement, now = Date.now();
    var again = box && box._swWaveAt && now - box._swWaveAt < 1500;
    if (box) box._swWaveAt = now;
    if (again) return 0;
    /* Меряем сразу, как в 3.17, когда волна работала: отложенный замер в
       requestAnimationFrame давал кадр без анимации и мог не найти видимых
       строк вовсе. */
    return wave(fresh).length;
  }
  function wave(fresh) {
    var view = viewport(fresh[0]);
    var visible = [];
    for (var j = 0; j < fresh.length && visible.length < MAX_WAVE; j++) {
      var rect = fresh[j].getBoundingClientRect();
      if (rect.bottom > view.top && rect.top < view.bottom) visible.push(fresh[j]);
      else if (visible.length) break;                  // ниже видимой части — дальше не смотрим
    }
    // замер ничего не нашёл (раскладка ещё не готова) — волна по первым строкам
    if (!visible.length) visible = fresh.slice(0, 24);
    var step = visible.length ? Math.min(STEP, SPREAD / visible.length) : STEP;
    for (var k = 0; k < visible.length; k++) {
      var row = visible[k];
      var delay = Math.round(k * step);
      row.style.animationDelay = delay + "ms";
      row.classList.add("sw-enter");
      row.addEventListener("animationend", function (e) { settle(e.currentTarget); }, {once: true});
      // Анимация может вовсе не начаться — строка скрыта или вкладка в фоне.
      // Тогда animationend не придёт, и класс снимается по таймеру.
      setTimeout(settle.bind(null, row), delay + 600);
    }
    return visible;
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
