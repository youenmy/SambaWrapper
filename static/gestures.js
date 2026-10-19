/* Жесты пальцем — только для сенсорных экранов.
 *
 * Док плеера тянется вверх и разворачивается в «Сейчас играет», развёрнутый
 * режим смахивается вниз обратно, строка трека смахивается влево — удалить
 * (с отсчётом и отменой). Вбок по доку или по обложке — следующий/предыдущий.
 * Мышь здесь ни при чём: обработчики слушают только touch-события, поэтому
 * на компьютере всё работает как раньше.
 *
 * Во время перетаскивания элементы ведёт палец (transform без перехода), а по
 * отпускании решаем по пройденному расстоянию и скорости: короткий быстрый
 * взмах засчитывается так же, как длинный медленный.
 */
(function () {
  "use strict";

  var OPEN_SHARE = 0.25;      // доля высоты экрана, после которой режим открывается или закрывается
  var FLICK = 0.5;            // пикс/мс — взмах, засчитываемый независимо от расстояния
  var SLOP = 10;              // столько пикселей палец может проехать, прежде чем это станет жестом
  var DELETE_SHARE = 0.35;    // доля ширины строки для удаления
  var EASE = "transform .26s cubic-bezier(.2,.8,.2,1)";

  function $(id) { return document.getElementById(id); }
  function np() { return $("mus-np"); }
  function height() { return window.innerHeight || document.documentElement.clientHeight; }

  /* После перетаскивания браузер всё равно присылает click тому, на чём
     начался палец, — кнопка «следующий» в доке сработала бы сама. */
  var swallowUntil = 0;
  document.addEventListener("click", function (e) {
    if (Date.now() < swallowUntil) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  function swallowClick() { swallowUntil = Date.now() + 400; }

  /** Отслеживание одного пальца: старт, текущий сдвиг, скорость на отпускании. */
  function track(e) {
    var t = e.touches[0];
    return {x0: t.clientX, y0: t.clientY, dx: 0, dy: 0, t0: Date.now(),
            lastY: t.clientY, lastX: t.clientX, lastT: Date.now(), vx: 0, vy: 0, axis: null};
  }
  function move(g, e) {
    var t = e.touches[0], now = Date.now(), dt = Math.max(1, now - g.lastT);
    g.vx = (t.clientX - g.lastX) / dt; g.vy = (t.clientY - g.lastY) / dt;
    g.lastX = t.clientX; g.lastY = t.clientY; g.lastT = now;
    g.dx = t.clientX - g.x0; g.dy = t.clientY - g.y0;
    if (!g.axis && (Math.abs(g.dx) > SLOP || Math.abs(g.dy) > SLOP)) {
      g.axis = Math.abs(g.dy) >= Math.abs(g.dx) ? "y" : "x";
    }
  }

  // ---------------------------------------------------------- переключение трека вбок
  var SKIP = 70;              // столько пикселей вбок — уже переключение
  /* Палец ведёт кадр один к одному — как ленту. В полноэкранном режиме
     вместе с обложкой едет и подпись. */
  function frames(el) {
    if (el && el.id === "mus-np-art") return [el, document.querySelector("#mus-np .np-text")];
    if (el && el.classList.contains("sw-dock-tape")) return [$("mus-cover-wrap"), el.querySelector(".sw-dock-meta")];
    return [el];
  }
  function nudge(el, dx) {
    frames(el).forEach(function (f) {
      if (!f) return;
      f.style.transition = "none";
      f.style.transform = "translateX(" + dx + "px)";
    });
  }
  /** Влево — следующий трек, вправо — предыдущий, как в мобильных плеерах. */
  function skip(g, el) {
    var go = Math.abs(g.dx) > SKIP || Math.abs(g.vx) > FLICK;
    var np = el && el.id === "mus-np-art";
    var dock = el && el.classList.contains("sw-dock-tape");
    if (go && (np || dock)) {
      /* Кадр остаётся там, где его отпустили: смену трека дорисует лента
         (Music.np._swap или Music._dockTape) — старый уедет дальше, новый
         въедет вплотную. */
      if (np) Music.np._swipeDx = g.dx; else Music._dockDx = g.dx;
    } else {
      frames(el).forEach(function (f) {
        if (!f) return;
        f.style.transition = EASE;
        f.style.transform = "";
        setTimeout(function () { f.style.transition = ""; }, 280);
      });
    }
    if (!go) return;
    buzz(10);
    if (g.dx < 0) Music.next(); else Music.prev();
    // трек так и не сменился (список пуст, сервер не ответил) — кадр возвращаем на место
    if (go && (np || dock)) setTimeout(function () {
      if (np ? !Music.np._swipeDx : !Music._dockDx) return;
      if (np) Music.np._swipeDx = 0; else Music._dockDx = 0;
      frames(el).forEach(function (f) { if (f) { f.style.transition = EASE; f.style.transform = ""; } });
    }, 2500);
  }
  // короткий толчок вибромотора; iPhone вибрацию из браузера не даёт — там тишина
  function buzz(ms) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) {} }

  /* Отклик кнопок плеера под пальцем: лёгкий толчок в момент касания.
     Само нажатие видно по CSS (:active) — кнопка чуть проседает. */
  document.addEventListener("pointerdown", function (e) {
    if (e.pointerType !== "touch" || !e.target.closest) return;
    if (e.target.closest("#mus-np .np-btn, #mus-np .np-play, #mus-bar button")) buzz(8);
  }, true);

  // ---------------------------------------------------------- перемотка пальцем по полосе дока
  /* Касание полосы сразу ставит позицию, ведение пальцем перематывает
     следом — как ползунок. Мышью полоса работает щелчком, как раньше. */
  var seekG = null;
  function seekTo(x) {
    var bar = $("mus-seek");
    if (!bar) return;
    var r = bar.getBoundingClientRect();
    var frac = Math.max(0, Math.min(1, (x - r.left) / r.width));
    Music.seekTo(frac);
  }
  document.addEventListener("touchstart", function (e) {
    if (e.touches.length !== 1 || !e.target.closest || !e.target.closest("#mus-bar #mus-seek")) return;
    seekG = true;
    seekTo(e.touches[0].clientX);
  }, {passive: true});
  document.addEventListener("touchmove", function (e) {
    if (!seekG) return;
    if (e.cancelable) e.preventDefault();
    seekTo(e.touches[0].clientX);
  }, {passive: false});
  document.addEventListener("touchend", function () {
    if (!seekG) return;
    seekG = null;
    swallowClick();                 // иначе следом придёт click и перемотает ещё раз
  });

  // ---------------------------------------------------------- режим «Сейчас играет»
  function sheetAt(y, animate) {
    var el = np();
    el.style.transition = animate ? EASE : "none";
    el.style.transform = "translateY(" + Math.max(0, y) + "px)";
  }
  function sheetDone(el) {
    el.classList.remove("np-drag");
    el.style.transition = ""; el.style.transform = "";
  }
  /** Довести шторку до конца после отпускания пальца. */
  function settle(open) {
    var el = np();
    sheetAt(open ? 0 : height(), true);
    setTimeout(function () {
      if (!open) {
        // режим уже за краем экрана — гасим его без затухания
        Music.np.hide();
        el.hidden = true;
      }
      sheetDone(el);
    }, 270);
  }

  // док: тянем вверх
  var dockG = null;
  document.addEventListener("touchstart", function (e) {
    var bar = e.target.closest && e.target.closest("#mus-bar");
    if (!bar || e.touches.length !== 1 || !window.Music || !Music.state.now) return;
    if (e.target.closest("#mus-seek")) return;              // перемотка — своё дело
    dockG = track(e);
  }, {passive: true});
  document.addEventListener("touchmove", function (e) {
    if (!dockG) return;
    move(dockG, e);
    if (dockG.axis === "x") {
      // вбок — переключение трека; название едет за пальцем
      e.preventDefault();
      dockG.side = true;
      nudge(document.querySelector("#mus-bar .sw-dock-tape"), dockG.dx);
      return;
    }
    if (dockG.axis !== "y") return;
    e.preventDefault();
    if (!dockG.started) {
      if (dockG.dy > 0) { dockG = null; return; }          // вниз из дока тянуть некуда
      dockG.started = true;
      var el = np();
      Music.np.show();
      el.classList.add("np-drag");
    }
    sheetAt(height() + dockG.dy, false);
  }, {passive: false});
  document.addEventListener("touchend", function () {
    if (!dockG) return;
    var g = dockG; dockG = null;
    if (g.side) { swallowClick(); skip(g, document.querySelector("#mus-bar .sw-dock-tape")); return; }
    if (!g.started) return;
    swallowClick();
    settle(-g.dy > height() * OPEN_SHARE || g.vy < -FLICK);
  });

  // развёрнутый режим: смахиваем вниз
  var sheetG = null;
  document.addEventListener("touchstart", function (e) {
    var el = np();
    if (!el || el.hidden || !e.target.closest || !e.target.closest("#mus-np") || e.touches.length !== 1) return;
    if (e.target.closest(".np-seek")) return;              // по волне перематывают
    sheetG = track(e);
  }, {passive: true});
  document.addEventListener("touchmove", function (e) {
    if (!sheetG) return;
    move(sheetG, e);
    if (sheetG.axis === "x") {
      e.preventDefault();
      sheetG.side = true;
      nudge($("mus-np-art"), sheetG.dx);
      return;
    }
    if (sheetG.axis !== "y") return;
    e.preventDefault();
    if (!sheetG.started) { sheetG.started = true; np().classList.add("np-drag"); }
    sheetAt(sheetG.dy, false);
  }, {passive: false});
  document.addEventListener("touchend", function () {
    if (!sheetG) return;
    var g = sheetG; sheetG = null;
    if (g.side) { swallowClick(); skip(g, $("mus-np-art")); return; }
    if (!g.started) return;
    swallowClick();
    settle(!(g.dy > height() * OPEN_SHARE || g.vy > FLICK));
  });

  // ---------------------------------------------------------- строка трека: влево — удалить
  /* Сдвигаем ячейки, а не саму строку: transform на <tr> ломает липкие
     ячейки. Под сдвинутыми ячейками видна красная подложка строки. */
  var rowG = null;
  function cells(row) { return row.querySelectorAll("td"); }
  function rowAt(row, x, animate) {
    cells(row).forEach(function (td) {
      td.style.transition = animate ? EASE : "none";
      td.style.transform = x ? "translateX(" + x + "px)" : "";
    });
  }
  function rowReset(row) {
    rowAt(row, 0, true);
    setTimeout(function () {
      row.classList.remove("sw-swipe", "sw-swipe-armed");
      cells(row).forEach(function (td) { td.style.transition = ""; });
    }, 270);
  }
  document.addEventListener("touchstart", function (e) {
    var row = e.target.closest && e.target.closest("#music-tracks tr.mrow");
    if (!row || e.touches.length !== 1 || SW.role === "guest") return;
    rowG = track(e); rowG.row = row;
  }, {passive: true});
  document.addEventListener("touchmove", function (e) {
    if (!rowG) return;
    move(rowG, e);
    if (rowG.axis === "y") { rowG = null; return; }          // это прокрутка списка
    if (rowG.axis !== "x") return;
    if (e.cancelable) e.preventDefault();
    var row = rowG.row, x = Math.min(0, rowG.dx);
    if (!rowG.started) { rowG.started = true; row.classList.add("sw-swipe"); }
    var armed = -x > row.offsetWidth * DELETE_SHARE;
    // порог пересекли в любую сторону — толчок, чтобы палец чувствовал момент
    if (armed !== row.classList.contains("sw-swipe-armed")) buzz(armed ? 20 : 8);
    row.classList.toggle("sw-swipe-armed", armed);
    rowAt(row, x, false);
  }, {passive: false});
  document.addEventListener("touchend", function () {
    if (!rowG) return;
    var g = rowG; rowG = null;
    if (!g.started) return;
    swallowClick();
    var row = g.row;
    var go = -g.dx > row.offsetWidth * DELETE_SHARE || (g.vx < -FLICK && g.dx < -40);
    if (!go) { rowReset(row); return; }
    /* Без окна-вопроса: строка уходит за край и превращается в обратный
       отсчёт с «Отменить» — случайный взмах успевают отменить. */
    rowAt(row, -row.offsetWidth, true);
    setTimeout(function () {
      row.classList.remove("sw-swipe", "sw-swipe-armed");
      cells(row).forEach(function (td) { td.style.transition = ""; td.style.transform = ""; });
      Music.deleteSoon(Number(row.dataset.id), row.dataset.title || "");
    }, 230);
  });
  // ---------------------------------------------------------- панель дисков: влево — закрыть
  var sideG = null;
  function sidebarOpen() {
    var sb = $("sidebar");
    return sb && window.innerWidth < 768 && !sb.classList.contains("-translate-x-full");
  }
  document.addEventListener("touchstart", function (e) {
    if (!sidebarOpen() || e.touches.length !== 1) return;
    var t = e.target.closest && e.target.closest("#sidebar, #sb-backdrop");
    if (!t) return;
    sideG = track(e);
  }, {passive: true});
  document.addEventListener("touchmove", function (e) {
    if (!sideG) return;
    move(sideG, e);
    if (sideG.axis === "y") { sideG = null; return; }       // прокрутка списка дисков
    if (sideG.axis !== "x") return;
    if (e.cancelable) e.preventDefault();
    var sb = $("sidebar");
    if (!sideG.started) { sideG.started = true; sb.style.transition = "none"; }
    sb.style.transform = "translateX(" + Math.min(0, sideG.dx) + "px)";
  }, {passive: false});
  document.addEventListener("touchend", function () {
    if (!sideG) return;
    var g = sideG; sideG = null;
    if (!g.started) return;
    swallowClick();
    var sb = $("sidebar");
    var close = -g.dx > sb.offsetWidth * 0.3 || g.vx < -FLICK;
    sb.style.transition = EASE;
    sb.style.transform = close ? "translateX(-100%)" : "";
    setTimeout(function () {
      sb.style.transition = ""; sb.style.transform = "";
      if (close) SW.closeSidebar();
    }, 260);
  });

  document.addEventListener("touchcancel", function () {
    if (rowG && rowG.started) rowReset(rowG.row);
    if (dockG && dockG.started) settle(false);
    if (sheetG && sheetG.started) settle(true);
    rowG = dockG = sheetG = null; seekG = null;
  });
})();
