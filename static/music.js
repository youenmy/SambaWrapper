/* Музыкальный раздел SambaWrapper.
 *
 * Весь клиентский код музыки живёт здесь и не смешивается с файловым браузером.
 * Правило модуля: единственный источник истины о происходящем — объект `st`.
 * Список треков (`st.queue`) может свободно перерисовываться сервером; то, что
 * сейчас звучит, хранится отдельно (`st.now`), поэтому перерисовка списка
 * никогда не сбивает воспроизведение.
 */
(function () {
  "use strict";

  var LS = {
    view: "sw.musView",       // фильтры и сортировка
    track: "sw.musTrack",     // что играло и на какой секунде
    volume: "sw.musVolume",
    cols: "sw.musCols",
  };

  var COLUMNS = [
    {id: "cover", name: "Обложка", fixed: true},
    {id: "title", name: "Название", fixed: true},
    {id: "artist", name: "Исполнитель"},
    {id: "album", name: "Альбом"},
    {id: "year", name: "Год"},
    {id: "genre", name: "Жанр"},
    {id: "bitrate", name: "Битрейт"},
    {id: "path", name: "Путь в библиотеке"},
    {id: "duration", name: "Время"},
    {id: "actions", name: "Действия", fixed: true},
  ];
  var HIDDEN_BY_DEFAULT = ["genre", "bitrate", "path"];

  // ---------------------------------------------------------------- состояние
  var st = {
    q: "", sort: "path", desc: false, seed: 0, sortBefore: "",
    artist: "", album: "", folder: "", page: 1,
    queue: [],      // треки текущей страницы списка
    total: 0,       // всего треков в текущей выборке
    hasMore: false, // есть ли ещё порции для подгрузки
    loading: false, // порция уже запрашивается
    recent: [],     // недавно сыгранные id (чтобы «случайно» не повторялось)
    dups: [],       // копии, показанные в окне дубликатов (в порядке отображения)
    now: null,      // трек, который звучит (может не быть в queue)
    nowId: 0,
  };

  function $(id) { return document.getElementById(id); }

  /* Дек две: одна звучит, вторая заранее качает следующий трек. Когда доходит
   * очередь до предзагруженного — деки просто меняются ролями, поэтому старт
   * мгновенный даже на медленном канале. */
  var deck = "mus-audio";
  function audio() { return $(deck); }
  function spare() { return $(deck === "mus-audio" ? "mus-audio-b" : "mus-audio"); }
  function swapDecks() { deck = (deck === "mus-audio") ? "mus-audio-b" : "mus-audio"; }
  function srcOf(el) { return el && el.getAttribute("src") || ""; }
  function clear(el) {
    if (!el) return;
    el.pause();
    el.removeAttribute("src");
    el.load();
  }

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
  }

  function store(key, value) {
    try { localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value)); }
    catch (e) { /* приватный режим — просто не сохраняем */ }
  }
  function load(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  }

  // ------------------------------------------------------------------ раздел
  var M = {
    get state() { return st; },

    /** Открыть раздел «Музыка» в правой панели. */
    open: function () {
      M.restoreFilters();
      setTimeout(function () {
        var sel = $("mus-sort");
        if (sel) sel.value = st.sort + ":" + (st.desc ? "desc" : "asc");
      }, 120);
      $("mus-bar").classList.remove("hidden");   // док виден всегда в разделе
      htmx.ajax("GET", "/htmx/music-page", {target: "#browser", swap: "innerHTML"})
        .then(function () { M.restoreNow(); });
    },

    // ---------------------------------------------------------------- список
    reloadTracks: function () {
      M.saveFilters();
      var el = $("music-tracks");
      if (el) htmx.trigger(el, "refreshMusicTracks");
    },
    reloadLists: function () {
      var el = $("music-lists");
      if (el) htmx.trigger(el, "reloadMusicLists");
    },
    /** Данные для hx-vals: сервер получает ровно текущее состояние фильтров. */
    query: function () {
      return {q: st.q, sort: st.sort, desc: st.desc ? "yes" : "no",
              artist: st.artist, album: st.album, folder: st.folder,
              page: st.page, seed: st.seed};
    },

    search: function (value) {
      st.q = value; st.page = 1;
      clearTimeout(M._searchTimer);
      M._searchTimer = setTimeout(M.reloadTracks, 300);
    },
    sortBy: function (column) {
      if (st.sort === column) st.desc = !st.desc;
      else { st.sort = column; st.desc = false; }
      st.page = 1; st.seed = 0;
      var sel = $("mus-sort");
      if (sel) sel.value = column + ":" + (st.desc ? "desc" : "asc");
      M.reloadTracks();
    },
    sortSelect: function (value) {
      var parts = String(value).split(":");
      st.sort = parts[0]; st.desc = parts[1] === "desc"; st.page = 1;
      // «перемешать»: новый seed при каждом выборе — иначе порядок повторится
      st.seed = (st.sort === "random") ? Math.floor(Math.random() * 900000) + 1000 : 0;
      M.reloadTracks();
    },
    filterArtist: function (name) {
      st.artist = name; st.album = ""; st.folder = ""; st.page = 1;
      M.reloadTracks(); M.reloadLists();
    },
    filterAlbum: function (name) {
      st.album = name; st.page = 1;
      M.reloadTracks(); M.markLists();
    },
    filterFolder: function (path) {
      st.folder = path; st.artist = ""; st.album = ""; st.page = 1;
      M.reloadTracks(); M.markLists();
    },
    clearFilters: function () {
      st.q = ""; st.artist = ""; st.album = ""; st.folder = ""; st.page = 1;
      var box = $("mus-search"); if (box) box.value = "";
      M.reloadTracks(); M.reloadLists();
    },
    goPage: function (page) {
      st.page = Math.max(1, page);
      M.reloadTracks();
      var pane = $("music-tracks"); if (pane) pane.scrollTop = 0;
    },

    /** Порция строк отрисована: первая — заменяет очередь, последующие дополняют. */
    appendQueue: function (tracks, isFirst, hasMore, page) {
      if (isFirst) { st.queue = tracks || []; st.page = page || 1; }
      else { st.queue = st.queue.concat(tracks || []); st.page = page || st.page; }
      st.hasMore = !!hasMore;
      st.loading = false;
      M._watchScroll();
      M.markRow();
      M.columns.apply();
      if (M._playAfterLoad) {
        var wanted = M._playAfterLoad;
        M._playAfterLoad = null;
        var found = M._find(wanted);
        if (found) M.playTrack(found);
      }
      M.revealCurrent();
      if (st.nowId) M.preloadNext();   // очередь изменилась — следующий трек мог стать другим
    },
    /** Подгрузка следующей порции при прокрутке к низу списка. */
    _watchScroll: function () {
      var pane = $("music-tracks");
      if (!pane || pane._musScroll) return;
      pane._musScroll = true;
      pane.addEventListener("scroll", function () {
        if (pane.scrollHeight - pane.scrollTop - pane.clientHeight < 400) M.loadMore();
      });
    },
    loadMore: function () {
      if (st.loading || !st.hasMore) return;
      var body = $("mus-rows");
      if (!body) return;
      st.loading = true;
      var next = st.page + 1;
      htmx.ajax("GET", "/htmx/music-rows", {
        target: "#mus-rows", swap: "beforeend",
        values: {q: st.q, sort: st.sort, desc: st.desc ? "yes" : "no",
                 artist: st.artist, album: st.album, folder: st.folder,
                 page: next, seed: st.seed},
      }).then(function () { st.page = next; })
        .catch(function () { st.loading = false; });
    },

    /** Страховка: собрать очередь прямо из таблицы, если она разошлась. */
    queueFromDom: function () {
      var rows = document.querySelectorAll("#music-tracks .mrow[data-id]");
      st.queue = Array.prototype.map.call(rows, function (r) {
        return {
          id: Number(r.dataset.id), title: r.dataset.title || "",
          artist: r.dataset.artist || "", album: r.dataset.album || "",
          duration: Number(r.dataset.dur || 0), cover: r.dataset.cover === "1",
        };
      });
    },

    // ---------------------------------------------------------------- плеер
    play: function (id) {
      // повторный клик по звучащему треку — пауза, следующий — продолжение
      if (id === st.nowId && srcOf(audio())) { M.toggle(); return; }
      var track = M._find(id);
      if (!track) { M.queueFromDom(); track = M._find(id); }
      if (track) M.playTrack(track);
      else SW.toast("Трек не найден в списке");
    },
    _find: function (id) {
      for (var i = 0; i < st.queue.length; i++) if (st.queue[i].id === id) return st.queue[i];
      return null;
    },
    /** Единственное место, где начинается воспроизведение. */
    playTrack: function (track) {
      var url = "/music-audio/" + track.id;
      st.now = track; st.nowId = track.id;

      if (srcOf(spare()) === url) {
        clear(audio());                           // старый поток обрываем целиком
        swapDecks();                              // предзагруженная дека становится активной
      } else {
        var cur = audio();
        cur.pause();                              // корректно обрываем предыдущий поток
        cur.src = url;
        cur.load();                               // сбрасываем состояние, в т.ч. после ошибки чтения
      }
      var a = audio();
      M._applyVolume(a);
      if (a.readyState > 0 && a.currentTime > 0) { try { a.currentTime = 0; } catch (e) {} }
      var started = a.play();
      if (started && started.catch) started.catch(function () { /* автозапуск заблокирован */ });
      $("mus-bar").classList.remove("hidden");
      $("mus-title").textContent = track.title || "—";
      $("mus-artist").textContent = [track.artist, track.album].filter(Boolean).join(" — ");
      var cover = $("mus-cover");
      if (track.cover) {
        cover.src = "/music-cover/" + track.id;
        cover.classList.remove("hidden");
        cover.onerror = function () { cover.classList.add("hidden"); };
      } else {
        cover.removeAttribute("src"); cover.classList.add("hidden");
      }
      if (track.duration) $("mus-dur").textContent = fmt(track.duration);
      st.recent.push(track.id);
      if (st.recent.length > 150) st.recent.shift();
      M.markRow();
      M.revealCurrent();
      M.viz.start();
      M.preloadNext();
      M._fitLists();
      store(LS.track, {track: track, time: 0});
    },

    /** Заранее скачать следующий трек во вторую деку. */
    preloadNext: function () {
      var next = M.shuffleOn ? null : M._peekNext();   // в случайном режиме следующий неизвестен
      var sp = spare();
      if (!sp) return;
      if (!next) { if (srcOf(sp)) clear(sp); return; }
      var url = "/music-audio/" + next.id;
      if (srcOf(sp) === url) return;                   // уже качается нужный
      sp.pause();
      sp.src = url;
      sp.load();
    },
    /** Какой трек пойдёт следующим при обычном (не случайном) порядке. */
    _peekNext: function () {
      if (!st.queue.length) return null;
      var i = M._indexOfNow();
      if (i < 0) return null;
      return st.queue[i + 1] || (st.hasMore ? null : st.queue[0]) || null;
    },
    toggle: function () {
      var a = audio();
      if (!a.src) { if (st.queue.length) M.playTrack(st.queue[0]); return; }
      if (a.paused) a.play().catch(function () {}); else a.pause();
    },
    next: function () {
      if (M.shuffleOn) return M.playRandom();
      if (!st.queue.length) return;
      var i = M._indexOfNow();
      if (i + 1 < st.queue.length) return M.playTrack(st.queue[i + 1]);
      // дошли до конца загруженного — подгружаем ещё, если есть
      if (st.hasMore) {
        var known = st.queue.length;
        M.loadMore();
        setTimeout(function () {
          if (st.queue.length > known) M.playTrack(st.queue[known]);
        }, 700);
        return;
      }
      M.playTrack(st.queue[0]);                // список кончился — начинаем сначала
    },
    prev: function () {
      var a = audio();
      if (a.currentTime > 3) { a.currentTime = 0; return; }
      if (!st.queue.length) return;
      var i = M._indexOfNow();
      M.playTrack(st.queue[(i - 1 + st.queue.length) % st.queue.length]);
    },
    _indexOfNow: function () {
      for (var i = 0; i < st.queue.length; i++) if (st.queue[i].id === st.nowId) return i;
      return -1;   // играет что-то вне списка → «следующий» начнёт с начала
    },
    shuffleOn: false,
    repeatOn: false,
    toggleShuffle: function () {
      M.shuffleOn = !M.shuffleOn;
      $("mus-shuffle").classList.toggle("text-sky-600", M.shuffleOn);
      // список остаётся в своей сортировке — случайным становится только выбор трека
      SW.toast(M.shuffleOn ? "Случайное воспроизведение включено"
                           : "Случайное воспроизведение выключено");
    },
    /** Случайный трек берём с сервера — из всей выборки, а не из показанной части. */
    playRandom: function () {
      var params = new URLSearchParams({
        q: st.q, artist: st.artist, album: st.album, folder: st.folder,
        sort: st.sort, desc: st.desc ? "yes" : "no", seed: st.seed,
        exclude: st.recent.join(","),
      });
      fetch("/api/music-random?" + params.toString())
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (!data || !data.track) { SW.toast("Треков не найдено"); return; }
          M.playTrack(data.track);
          // трек может быть далеко в списке — показываем ту его часть, где он есть
          if (!document.querySelector('#music-tracks .mrow[data-id="' + data.track.id + '"]')) {
            M.jumpToPage(data.page || 1);
          }
        })
        .catch(function () { SW.toast("Не удалось выбрать трек"); });
    },
    /** Показать список начиная с указанной страницы (для прыжка к треку). */
    jumpToPage: function (page) {
      st.loading = true;
      htmx.ajax("GET", "/htmx/music-rows", {
        target: "#mus-rows", swap: "innerHTML",
        values: {q: st.q, sort: st.sort, desc: st.desc ? "yes" : "no",
                 artist: st.artist, album: st.album, folder: st.folder,
                 page: page, seed: st.seed, reset: "yes"},
      }).then(function () {
        st.loading = false;
        setTimeout(M.revealCurrent, 60);
      }).catch(function () { st.loading = false; });
    },
    toggleRepeat: function () {
      M.repeatOn = !M.repeatOn;
      $("mus-repeat").classList.toggle("text-sky-600", M.repeatOn);
    },
    seekClick: function (event) {
      var a = audio();
      if (!a.duration) return;
      var box = $("mus-seek").getBoundingClientRect();
      a.currentTime = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) * a.duration;
    },
    seekWheel: function (event) {
      event.preventDefault();
      var a = audio();
      if (!a.duration) return;
      a.currentTime = Math.max(0, Math.min(a.duration - 0.5,
        a.currentTime + (event.deltaY < 0 ? 5 : -5)));
    },
    setVolume: function (value) {
      var a = audio();
      a.volume = parseFloat(value);
      a.muted = a.volume <= 0;
      M._applyVolume(spare());                 // вторая дека должна зазвучать так же
      M._volumeIcon();
      store(LS.volume, String(a.volume));
    },
    /** Перенести громкость активной деки на указанный элемент. */
    _applyVolume: function (el) {
      if (!el) return;
      var from = (el === audio()) ? spare() : audio();
      if (!from) return;
      el.volume = from.volume;
      el.muted = from.muted;
    },
    volumeWheel: function (event) {
      event.preventDefault();
      var a = audio();
      M.setVolume(Math.max(0, Math.min(1, a.volume + (event.deltaY < 0 ? 0.05 : -0.05))));
      var slider = $("mus-vol"); if (slider) slider.value = a.volume;
    },
    mute: function () {
      var a = audio();
      a.muted = !a.muted;
      M._applyVolume(spare());
      var slider = $("mus-vol"); if (slider) slider.value = a.muted ? 0 : a.volume;
      M._volumeIcon();
    },
    _volumeIcon: function () {
      var a = audio(), icon = $("mus-vol-icon");
      if (!icon) return;
      icon.className = (a.muted || a.volume === 0) ? "ti ti-volume-off"
                     : (a.volume < 0.5 ? "ti ti-volume-2" : "ti ti-volume");
    },
    close: function () {
      clear(audio()); clear(spare());
      M.viz.stop();
      st.now = null; st.nowId = 0;
      M._fitLists();
      if (SW.view !== "music") $("mus-bar").classList.add("hidden");
      $("mus-title").textContent = "—";
      $("mus-artist").textContent = "";
      M.markRow();
    },

    /* ---------------------------------------------------- визуализатор
     * Спектр рисуется прямо в полосе перемотки: сыгранная часть — синяя,
     * оставшаяся — серая. Если Web Audio недоступен, полоса просто остаётся
     * обычным прогрессом, воспроизведение от этого не страдает. */
    viz: {
      ctx: null, analyser: null, data: null, raf: 0, sources: {},

      _ensure: function () {
        var V = M.viz;
        var Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) return false;
        if (!V.ctx) {
          try { V.ctx = new Ctor(); } catch (e) { return false; }
          V.analyser = V.ctx.createAnalyser();
          V.analyser.fftSize = 128;
          V.analyser.smoothingTimeConstant = 0.75;
          // окно по умолчанию (−100…−30 дБ) для музыки слишком широкое: реальные
          // уровни жмутся к нулю и столбики шевелятся на пару пикселей
          V.analyser.minDecibels = -78;
          V.analyser.maxDecibels = -22;
          // немой выход: граф должен доходить до устройства, иначе он не считается,
          // но сам анализатор звучать не должен
          V.sink = V.ctx.createGain();
          V.sink.gain.value = 0;
          V.analyser.connect(V.sink);
          V.sink.connect(V.ctx.destination);
          V.data = new Uint8Array(V.analyser.frequencyBinCount);
        }
        return true;
      },
      /* Снять звук с деки для анализа (один раз на элемент).
       *
       * Основной путь — captureStream(): он даёт отдельный отвод и не трогает
       * собственный выход элемента, поэтому не важно, играет тот уже или нет.
       * Запасной путь — createMediaElementSource(), который выход перехватывает,
       * и тогда звук приходится вернуть на устройство вручную. */
      _connect: function (el) {
        var V = M.viz;
        if (!el || !V.ctx) return;
        var url = srcOf(el);
        var have = V.sources[el.id];
        /* Отвод через captureStream живёт ровно до смены файла на деке: дорожка
         * завершается, и узел молча отдаёт тишину. Поэтому при новом src его
         * пересоздаём. Отвод через createMediaElementSource, наоборот, снимается
         * с элемента один раз навсегда — второй вызов бросает исключение. */
        var dead = have && have.track && have.track.readyState === "ended";
        if (have && !dead && (have.kind === "element" || have.url === url)) return;
        if (have) {
          try { have.node.disconnect(); } catch (e) { /* уже отключён */ }
          delete V.sources[el.id];
        }

        var capture = el.captureStream || el.mozCaptureStream;
        if (capture) {
          try {
            var stream = capture.call(el);
            if (stream && stream.getAudioTracks().length) {
              var tap = V.ctx.createMediaStreamSource(stream);
              tap.connect(V.analyser);
              V.sources[el.id] = {node: tap, kind: "stream", url: url,
                                  track: stream.getAudioTracks()[0]};
              return;
            }
          } catch (e) { /* поток ещё не готов — попробуем на следующем старте */ }
        }
        try {
          var src = V.ctx.createMediaElementSource(el);
          src.connect(V.analyser);
          src.connect(V.ctx.destination);      // выход перехвачен — возвращаем звук
          V.sources[el.id] = {node: src, kind: "element", url: url};
        } catch (e) { /* элемент уже привязан к контексту */ }
      },
      /** Завести в граф деку, которая звучит прямо сейчас. */
      attach: function () {
        var V = M.viz;
        if (!$("mus-viz") || !V._ensure()) return;
        V._connect(audio());
      },
      start: function () {
        var V = M.viz;
        V.attach();
        if (!V.ctx) return;
        // контекст создаётся приглушённым — будим его, иначе звука не будет вовсе
        if (V.ctx.state !== "running") V.ctx.resume().catch(function () {});
        if (!V.raf) V.raf = requestAnimationFrame(V._draw);
      },
      stop: function () {
        var V = M.viz;
        if (V.raf) cancelAnimationFrame(V.raf);
        V.raf = 0;
        V._clear();
      },
      _clear: function () {
        var c = $("mus-viz");
        if (c && c.getContext) c.getContext("2d").clearRect(0, 0, c.width, c.height);
      },
      /* Если во время игры спектр остаётся ровно нулевым, звук идёт мимо графа —
       * сообщаем в консоль один раз, чтобы причина была видна, а не гадалась. */
      _checkSilence: function (peak) {
        var V = M.viz, a = audio();
        if (peak > 0) { V._silentSince = 0; return; }
        if (!a || a.paused) { V._silentSince = 0; return; }
        if (!V._silentSince) { V._silentSince = Date.now(); return; }
        // отвод мог не сняться с деки при старте — пробуем ещё раз, не чаще раза в секунду
        if (!V._retriedAt || Date.now() - V._retriedAt > 1000) {
          V._retriedAt = Date.now();
          V._connect(a);
        }
        if (V._warned || Date.now() - V._silentSince < 2500) return;
        V._warned = true;
        console.warn("SambaWrapper: визуализатор не получает звук.",
                     "состояние контекста:", V.ctx && V.ctx.state,
                     "деки в графе:", Object.keys(V.sources).join(",") || "нет");
      },
      _draw: function () {
        var V = M.viz, c = $("mus-viz");
        if (!c || !V.analyser) { V.raf = 0; return; }

        var dpr = window.devicePixelRatio || 1;
        var w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
        if (w < 2 || h < 2) { V.raf = requestAnimationFrame(V._draw); return; }
        if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }

        var g = c.getContext("2d");
        g.clearRect(0, 0, w, h);
        V.analyser.getByteFrequencyData(V.data);

        var a = audio();
        var played = (a && a.duration) ? (a.currentTime / a.duration) * w : 0;
        var bins = V.data.length;
        var barW = Math.round(9 * dpr);
        var gap = Math.round(4 * dpr);
        var count = Math.max(8, Math.floor(w / (barW + gap)));
        var radius = barW / 2;
        var peak = 0;

        // сыгранная часть — яркий градиент снизу вверх, остаток — приглушённый
        var hot = g.createLinearGradient(0, h, 0, 0);
        hot.addColorStop(0, "#0284c7");
        hot.addColorStop(1, "#7dd3fc");
        var cold = g.createLinearGradient(0, h, 0, 0);
        cold.addColorStop(0, "rgba(148,163,184,0.35)");
        cold.addColorStop(1, "rgba(148,163,184,0.6)");

        // тихую запись растягиваем на всю высоту: делим не на 255, а на текущий
        // пик, который медленно оседает, — громкая всё равно не упрётся в потолок
        for (var k = 0; k < bins; k++) if (V.data[k] > peak) peak = V.data[k];
        V.norm = Math.max(peak, (V.norm || 0) * 0.97, 32);

        for (var i = 0; i < count; i++) {
          // верхние бины почти всегда пустые — растягиваем полезную часть спектра
          var v = V.data[Math.min(bins - 1, Math.floor(i / count * bins * 0.75))];
          var bar = Math.max(2 * dpr, Math.min(1, Math.pow(v / V.norm, 0.85)) * h);
          var x = i * (barW + gap);
          g.fillStyle = (x + barW / 2 <= played) ? hot : cold;
          if (g.roundRect) {
            var r = Math.min(radius, bar / 2);      // низкий столбик не должен стать кружком
            g.beginPath();
            g.roundRect(x, h - bar, barW, bar, [r, r, 0, 0]);
            g.fill();
          } else {
            g.fillRect(x, h - bar, barW, bar);
          }
        }
        V._checkSilence(peak);
        V.raf = requestAnimationFrame(V._draw);
      },
    },

    // ------------------------------------------------------------ подсветка
    markRow: function () {
      document.querySelectorAll("#music-tracks .mrow").forEach(function (row) {
        row.classList.toggle("mus-playing", st.nowId > 0 && Number(row.dataset.id) === st.nowId);
      });
      // та же пометка для копий в окне дубликатов
      document.querySelectorAll("#modal-host .dup-row").forEach(function (row) {
        row.classList.toggle("mus-playing", st.nowId > 0 && Number(row.dataset.copy) === st.nowId);
      });
    },
    /** Показать играющий трек в списке (прокрутка + фокус). */
    revealCurrent: function () {
      if (!st.nowId) return;
      var row = document.querySelector('#music-tracks .mrow[data-id="' + st.nowId + '"]');
      if (!row) return;
      row.scrollIntoView({block: "center", behavior: "smooth"});
    },
    /* Обложка выступает над доком и перекрывала бы хвост списка папок —
     * дотягиваем список ровно на высоту выступающей части. */
    _fitLists: function () {
      var tail = $("mus-lists-tail"), bar = $("mus-bar"), cover = $("mus-cover-wrap");
      if (!tail) return;
      if (!bar || !cover || bar.classList.contains("hidden")) { tail.style.height = "8px"; return; }
      var over = bar.getBoundingClientRect().top - cover.getBoundingClientRect().top;
      tail.style.height = Math.max(8, Math.round(over) + 8) + "px";
    },
    markLists: function () {
      var nothingPicked = !st.folder && !st.artist && !st.album;
      document.querySelectorAll("#music-lists .mus-item").forEach(function (b) {
        var on = b.dataset.all ? nothingPicked          // «Все треки» — когда фильтров нет
              : (b.dataset.folder && b.dataset.folder === st.folder)
              || (b.dataset.artist && b.dataset.artist === st.artist)
              || (b.dataset.album && b.dataset.album === st.album);
        b.classList.toggle("mus-on", !!on);
      });
    },

    // -------------------------------------------------------------- удаление
    deleteTrack: function (id, name) {
      SW.confirm("Удалить трек «" + name + "» с диска?\nФайл будет стёрт безвозвратно.",
        function () { SW.post("/htmx/music-delete", {id: id}); },
        {ok: "Удалить", danger: true});
    },
    /** Del в разделе музыки — удалить то, что сейчас звучит. */
    deleteCurrent: function () {
      var track = st.now;
      if (!track) { SW.toast("Сначала включи трек"); return; }
      var name = [track.artist, track.title].filter(Boolean).join(" — ") || track.title;
      SW.confirm("Удалить трек с диска?\n" + name + "\n\nEnter или пробел — удалить, Esc — отмена",
        function () {
          var following = M._nextInQueue(track.id);
          M._request(track.id, function () {
            if (following) M.playTrack(following); else M.close();
            M.reloadTracks();
          });
        }, {ok: "Удалить", danger: true, quick: true});
    },
    _nextInQueue: function (id) {
      var i = -1;
      for (var k = 0; k < st.queue.length; k++) if (st.queue[k].id === id) { i = k; break; }
      if (i < 0) return null;
      return st.queue[i + 1] || st.queue[i - 1] || null;
    },
    _request: function (id, done) {
      fetch("/htmx/music-delete", {method: "POST", body: new URLSearchParams({id: id})})
        .then(function (r) { return r.text(); })
        .then(function (html) { SW._toastHtml(html); if (done) done(); })
        .catch(function () { SW.toast("Не удалось удалить"); });
    },

    // ------------------------------------------------------------ дубликаты
    openDuplicates: function () {
      var p = new URLSearchParams({folder: st.folder, artist: st.artist, album: st.album});
      SW.openModal("/htmx/music-duplicates?" + p.toString());
    },
    /** Окно дубликатов отрисовано — запоминаем порядок копий. */
    dupsRendered: function () {
      st.dups = Array.prototype.map.call(
        document.querySelectorAll("#modal-host .dup-row"),
        function (row) {
          return {id: Number(row.dataset.copy), label: row.dataset.label || ""};
        });
      M.markRow();
    },
    /** Проиграть конкретную копию из окна дубликатов. */
    playCopy: function (id, label) {
      M.playTrack({id: id, title: label, artist: "", album: "", duration: 0, cover: false});
    },
    /**
     * Удалить копию. Следующий трек выбирается по сохранённому порядку (st.dups),
     * а не поиском в DOM — так переход не зависит от того, что уже удалено со страницы.
     */
    deleteCopy: function (id, path) {
      SW.confirm("Удалить копию?" + String.fromCharCode(10) + path, function () {
        var wasPlaying = st.nowId === id;
        var idx = -1;
        for (var i = 0; i < st.dups.length; i++) if (st.dups[i].id === id) { idx = i; break; }
        var following = idx >= 0 ? (st.dups[idx + 1] || st.dups[idx - 1] || null) : null;

        if (wasPlaying) {          // отпускаем файл до удаления
          var a = audio();
          a.pause(); a.removeAttribute("src"); a.load();
        }

        M._request(id, function () {
          if (idx >= 0) st.dups.splice(idx, 1);
          var row = document.querySelector('#modal-host .dup-row[data-copy="' + id + '"]');
          if (row) {
            var group = row.closest(".dup-group");
            row.remove();
            // в группе осталась одна копия — это уже не дубликат
            if (group && group.querySelectorAll(".dup-row").length < 2) group.remove();
          }
          if (wasPlaying) {
            if (following) M.playCopy(following.id, following.label);
            else {
              var next = M._nextInQueue(id);
              if (next) M.playTrack(next); else M.close();
            }
          }
          M.reloadTracks();
        });
      }, {ok: "Удалить", danger: true});
    },
    // -------------------------------------------------------------- столбцы
    columns: {
      config: function () {
        var cfg = load(LS.cols, {}) || {};
        var all = COLUMNS.map(function (c) { return c.id; });
        var order = (cfg.order || []).filter(function (id) { return all.indexOf(id) >= 0; });
        all.forEach(function (id) { if (order.indexOf(id) < 0) order.push(id); });
        return {order: order, hidden: cfg.hidden || HIDDEN_BY_DEFAULT.slice(), widths: cfg.widths || {}};
      },
      save: function (cfg) { store(LS.cols, cfg); },
      apply: function () {
        var cfg = M.columns.config();
        var table = document.querySelector("#music-tracks table");
        if (!table) return;
        table.querySelectorAll("tr").forEach(function (row) {
          var cells = {};
          row.querySelectorAll("[data-col]").forEach(function (c) { cells[c.dataset.col] = c; });
          if (!Object.keys(cells).length) return;
          cfg.order.forEach(function (id) {
            var cell = cells[id];
            if (!cell) return;
            cell.style.display = cfg.hidden.indexOf(id) >= 0 ? "none" : "";
            var w = cfg.widths[id];
            if (w && cell.tagName === "TH" && id !== "actions") {
              cell.style.width = w + "px"; cell.style.minWidth = w + "px";
            }
            row.appendChild(cell);
          });
        });
        M.columns._freezeWidths();
        M.columns._dragAndDrop();
        M.columns._resizers();
      },
      /**
       * Перетаскивание столбцов мышью. HTML5 drag&drop внутри таблицы со
       * «липкой» шапкой отрабатывает ненадёжно, поэтому тащим вручную.
       */
      _dragAndDrop: function () {
        document.querySelectorAll("#music-tracks th[data-col] .col-grip").forEach(function (grip) {
          if (grip._musDrag) return;
          grip._musDrag = true;
          grip.addEventListener("mousedown", function (e) {
            e.preventDefault(); e.stopPropagation();
            var th = grip.closest("th");
            var from = th.dataset.col, target = null;
            th.classList.add("col-dragging");
            document.body.style.userSelect = "none";

            function over(ev) {
              var el = document.elementFromPoint(ev.clientX, ev.clientY);
              var cell = el && el.closest ? el.closest("#music-tracks th[data-col]") : null;
              document.querySelectorAll("#music-tracks th").forEach(function (x) {
                x.classList.remove("col-drop-target");
              });
              target = (cell && cell.dataset.col !== from) ? cell.dataset.col : null;
              if (target) cell.classList.add("col-drop-target");
            }
            function up() {
              document.removeEventListener("mousemove", over);
              document.removeEventListener("mouseup", up);
              document.body.style.userSelect = "";
              th.classList.remove("col-dragging");
              document.querySelectorAll("#music-tracks th").forEach(function (x) {
                x.classList.remove("col-drop-target");
              });
              if (!target) return;
              var cfg = M.columns.config();
              cfg.order.splice(cfg.order.indexOf(from), 1);
              cfg.order.splice(cfg.order.indexOf(target), 0, from);
              M.columns.save(cfg);
              M.columns.apply();
            }
            document.addEventListener("mousemove", over);
            document.addEventListener("mouseup", up);
          });
        });
      },

      /** Зафиксировать текущие ширины всех столбцов в пикселях. */
      _freezeWidths: function () {
        document.querySelectorAll("#music-tracks th[data-col]").forEach(function (th) {
          if (th.dataset.col === "actions") return;   // остаток отдаём ему
          if (!th.style.width) {
            var w = th.offsetWidth;
            th.style.width = w + "px"; th.style.minWidth = w + "px";
          }
        });
      },
      _resizers: function () {
        document.querySelectorAll("#music-tracks th[data-col]").forEach(function (th) {
          if (th.querySelector(".col-resizer") || th.dataset.col === "actions") return;
          th.style.position = "relative";
          var handle = document.createElement("div");
          handle.className = "col-resizer";
          handle.addEventListener("click", function (e) { e.stopPropagation(); });
          handle.addEventListener("dragstart", function (e) { e.preventDefault(); });
          handle.addEventListener("mousedown", function (e) {
            e.preventDefault(); e.stopPropagation();
            M.columns._freezeWidths();
            var startX = e.clientX, startW = th.offsetWidth;
            document.body.style.userSelect = "none";
            function move(ev) {
              var w = Math.max(48, startW + ev.clientX - startX);
              th.style.width = w + "px"; th.style.minWidth = w + "px";
            }
            function up() {
              document.removeEventListener("mousemove", move);
              document.removeEventListener("mouseup", up);
              document.body.style.userSelect = "";
              var cfg = M.columns.config();
              document.querySelectorAll("#music-tracks th[data-col]").forEach(function (x) {
                if (x.dataset.col !== "actions") cfg.widths[x.dataset.col] = x.offsetWidth;
              });
              M.columns.save(cfg);
            }
            document.addEventListener("mousemove", move);
            document.addEventListener("mouseup", up);
          });
          th.appendChild(handle);
        });
      },
      modal: function () {
        var cfg = M.columns.config();
        var rows = cfg.order.map(function (id) {
          var col = COLUMNS.find(function (c) { return c.id === id; });
          if (!col || col.fixed) return "";
          var checked = cfg.hidden.indexOf(id) < 0 ? "checked" : "";
          return '<label class="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-100 cursor-pointer text-sm">' +
                 '<input type="checkbox" ' + checked + ' onchange="Music.columns.toggle(\'' + id + '\', this.checked)">' +
                 col.name + "</label>";
        }).join("");
        var host = $("modal-host");
        host.innerHTML =
          '<div class="bg-white rounded-xl p-5 w-full max-w-xs" onclick="event.stopPropagation()">' +
          '<div class="flex items-center justify-between mb-3">' +
          '<h3 class="font-medium flex items-center gap-2"><i class="ti ti-columns text-sky-600"></i>Столбцы</h3>' +
          '<button class="text-slate-400 hover:text-slate-700" onclick="SW.closeModal()"><i class="ti ti-x"></i></button>' +
          '</div><div class="space-y-0.5">' + rows + "</div>" +
          '<p class="text-[0.6875rem] text-slate-400 mt-3">Порядок меняется перетаскиванием заголовков, ширина — за правый край.</p>' +
          '<div class="flex justify-end mt-3"><button class="text-[0.8125rem] text-slate-500 hover:text-sky-600" onclick="Music.columns.reset()">Сбросить по умолчанию</button></div></div>';
        host.classList.remove("hidden");
      },
      toggle: function (id, visible) {
        var cfg = M.columns.config();
        cfg.hidden = cfg.hidden.filter(function (x) { return x !== id; });
        if (!visible) cfg.hidden.push(id);
        M.columns.save(cfg); M.columns.apply();
      },
      reset: function () {
        try { localStorage.removeItem(LS.cols); } catch (e) {}
        document.querySelectorAll("#music-tracks th[data-col]").forEach(function (th) {
          th.style.width = ""; th.style.minWidth = "";
        });
        M.columns.apply(); SW.closeModal();
      },
    },

    // ------------------------------------------------------------- хранилище
    saveFilters: function () {
      store(LS.view, {q: st.q, sort: st.sort, desc: st.desc, seed: st.seed,
                      artist: st.artist, album: st.album, folder: st.folder});
    },
    restoreFilters: function () {
      var s = load(LS.view, null);
      if (!s) return;
      st.q = s.q || ""; st.sort = s.sort || "path"; st.desc = !!s.desc;
      st.seed = s.seed || 0;
      st.artist = s.artist || ""; st.album = s.album || ""; st.folder = s.folder || "";
      st.page = 1;
    },
    /** Вернуть последний трек на паузе (автозапуск браузеры блокируют). */
    restoreNow: function () {
      var a = audio();
      if (!a || a.src) return;
      var saved = load(LS.track, null);
      if (!saved || !saved.track) return;
      var track = saved.track;
      st.now = track; st.nowId = track.id;
      a.src = "/music-audio/" + track.id;
      a.addEventListener("loadedmetadata", function once() {
        if (saved.time > 0) a.currentTime = saved.time;
        a.removeEventListener("loadedmetadata", once);
      });
      $("mus-title").textContent = track.title || "—";
      $("mus-artist").textContent = [track.artist, track.album].filter(Boolean).join(" — ");
      var cover = $("mus-cover");
      if (track.cover) {
        cover.src = "/music-cover/" + track.id;
        cover.classList.remove("hidden");
        cover.onerror = function () { cover.classList.add("hidden"); };
      } else {
        cover.removeAttribute("src"); cover.classList.add("hidden");
      }
      M.markRow();
    },

    // ------------------------------------------------------------------ init
    init: function () {
      var a = audio();
      if (!a) return;

      var vol = parseFloat(localStorage.getItem(LS.volume));
      if (!isNaN(vol)) {
        a.volume = vol; a.muted = vol <= 0;
        var slider = $("mus-vol"); if (slider) slider.value = vol;
        M._volumeIcon();
      }

      /* События вешаем на обе деки, но реагируем только на активную —
       * вторая в это время молча качает следующий трек. */
      [$("mus-audio"), $("mus-audio-b")].forEach(function (el) {
        if (!el) return;
        function active() { return el === audio(); }

        el.addEventListener("timeupdate", function () {
          if (!active()) return;
          var pct = el.duration ? el.currentTime / el.duration * 100 : 0;
          var fill = $("mus-fill"), head = $("mus-head"), cur = $("mus-cur");
          if (fill) fill.style.width = pct + "%";
          if (head) head.style.left = pct + "%";
          if (cur) cur.textContent = fmt(el.currentTime);
          // позицию сохраняем не чаще раза в 5 секунд
          if (!M._savedAt || Date.now() - M._savedAt > 5000) {
            M._savedAt = Date.now();
            if (st.now) store(LS.track, {track: st.now, time: el.currentTime});
          }
        });
        el.addEventListener("loadedmetadata", function () {
          if (!active()) return;
          var d = $("mus-dur"); if (d) d.textContent = fmt(el.duration);
        });
        el.addEventListener("ended", function () {
          if (!active()) return;
          if (M.repeatOn) { el.currentTime = 0; el.play(); } else M.next();
        });
        el.addEventListener("error", function () {
          if (!active() || !srcOf(el)) return;     // источник сняли намеренно
          SW.toast("Не удалось воспроизвести трек");
        });
        el.addEventListener("play", function () {
          if (!active()) return;
          $("mus-play-icon").className = "ti ti-player-pause-filled text-sm";
          M.viz.start();
        });
        // звук пошёл — только теперь у деки есть готовая аудиодорожка для отвода
        el.addEventListener("playing", function () {
          if (active()) M.viz.start();
        });
        el.addEventListener("pause", function () {
          if (!active()) return;
          $("mus-play-icon").className = "ti ti-player-play-filled text-sm";
        });
      });

      /* Контекст создаём внутри жеста пользователя — созданный раньше остаётся
       * «спящим» и звука не пропускает. */
      document.addEventListener("pointerdown", function wake() {
        document.removeEventListener("pointerdown", wake);
        if (!M.viz._ensure()) return;
        if (M.viz.ctx.state !== "running") M.viz.ctx.resume().catch(function () {});
      });

      var seekZone = $("mus-seek-zone");
      if (seekZone) seekZone.addEventListener("wheel", M.seekWheel, {passive: false});
      var volZone = $("mus-vol-zone");
      if (volZone) volZone.addEventListener("wheel", M.volumeWheel, {passive: false});

      document.addEventListener("keydown", function (e) {
        if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
        var dialog = $("confirm-host");
        if (dialog && !dialog.classList.contains("hidden")) return;
        if (SW.view !== "music") return;
        if (e.key === "Delete") { e.preventDefault(); M.deleteCurrent(); return; }
        if (e.key === " " || e.key === "Spacebar") {
          // гасим и прокрутку страницы, и нажатие кнопки, если фокус на ней:
          // иначе пробел сработал бы дважды
          e.preventDefault();
          M.toggle();
          return;
        }

        // стрелки: перемотка на 10 секунд и громкость шагом 5%, как в видеоплеере
        var a = audio();
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          if (!a || !a.duration) return;
          e.preventDefault();
          var to = a.currentTime + (e.key === "ArrowRight" ? 10 : -10);
          a.currentTime = Math.max(0, Math.min(a.duration - 0.5, to));
        } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          if (!a) return;
          e.preventDefault();
          M.setVolume(Math.max(0, Math.min(1, a.volume + (e.key === "ArrowUp" ? 0.05 : -0.05))));
          var slider = $("mus-vol"); if (slider) slider.value = a.muted ? 0 : a.volume;
        }
      });

      // после подмены списка/боковых панелей восстанавливаем подсветку и столбцы
      document.body.addEventListener("htmx:afterSwap", function (e) {
        if (!e.target) return;
        if (e.target.id === "music-tracks") { M.markRow(); M.columns.apply(); }
        if (e.target.id === "music-lists") { M.markLists(); M._fitLists(); }
      });
      document.body.addEventListener("reloadMusic", function () {
        if (SW.view === "music") M.open();
      });
    },
  };

  window.Music = M;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", M.init);
  else M.init();
})();
