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
    {id: "duration", name: "Время"},
    {id: "actions", name: "Действия", fixed: true},
  ];
  var HIDDEN_BY_DEFAULT = ["genre", "bitrate"];

  // ---------------------------------------------------------------- состояние
  var st = {
    q: "", sort: "artist", desc: false, seed: 0, sortBefore: "",
    artist: "", album: "", folder: "", page: 1,
    queue: [],      // треки текущей страницы списка
    total: 0,       // всего треков в текущей выборке
    recent: [],     // недавно сыгранные id (чтобы «случайно» не повторялось)
    dups: [],       // копии, показанные в окне дубликатов (в порядке отображения)
    now: null,      // трек, который звучит (может не быть в queue)
    nowId: 0,
  };

  function $(id) { return document.getElementById(id); }
  function audio() { return $("mus-audio"); }

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
      st.page = 1;
      var sel = $("mus-sort");
      if (sel) sel.value = column + ":" + (st.desc ? "desc" : "asc");
      M.reloadTracks();
    },
    sortSelect: function (value) {
      var parts = String(value).split(":");
      st.sort = parts[0]; st.desc = parts[1] === "desc"; st.page = 1;
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
    appendQueue: function (tracks, isFirst) {
      if (isFirst) st.queue = tracks || [];
      else st.queue = st.queue.concat(tracks || []);
      M.markRow();
      M.columns.apply();
      if (M._playAfterLoad) {
        var wanted = M._playAfterLoad;
        M._playAfterLoad = null;
        var found = M._find(wanted);
        if (found) M.playTrack(found);
      }
      M.revealCurrent();
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
      var a = audio();
      st.now = track; st.nowId = track.id;
      a.pause();                                  // корректно обрываем предыдущий поток
      a.src = "/music-audio/" + track.id;
      a.load();                                   // сбрасываем состояние, в т.ч. после ошибки чтения
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
      store(LS.track, {track: track, time: 0});
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
      var sentinel = $("mus-sentinel");
      if (sentinel && st.queue.length < st.total) {
        M._playAfterLoad = -1;                 // сыграть первый из новой порции
        var known = st.queue.length;
        htmx.trigger(sentinel, "revealed");
        setTimeout(function () {
          if (st.queue.length > known) M.playTrack(st.queue[known]);
        }, 600);
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
        exclude: st.recent.join(","),
      });
      fetch("/api/music-random?" + params.toString())
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (!data || !data.track) { SW.toast("Треков не найдено"); return; }
          M.playTrack(data.track);
        })
        .catch(function () { SW.toast("Не удалось выбрать трек"); });
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
      M._volumeIcon();
      store(LS.volume, String(a.volume));
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
      var a = audio();
      a.pause(); a.removeAttribute("src"); a.load();
      st.now = null; st.nowId = 0;
      if (SW.view !== "music") $("mus-bar").classList.add("hidden");
      $("mus-title").textContent = "—";
      $("mus-artist").textContent = "";
      M.markRow();
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
      row.scrollIntoView({block: "nearest", behavior: "smooth"});
    },
    markLists: function () {
      document.querySelectorAll("#music-lists .mus-item").forEach(function (b) {
        var on = (b.dataset.folder && b.dataset.folder === st.folder)
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
            if (w && cell.tagName === "TH") { cell.style.width = w + "px"; cell.style.minWidth = w + "px"; }
            row.appendChild(cell);
          });
        });
        M.columns._dragAndDrop();
        M.columns._resizers();
      },
      _dragAndDrop: function () {
        document.querySelectorAll("#music-tracks th[draggable=true]").forEach(function (th) {
          th.ondragstart = function (e) {
            e.stopPropagation();
            e.dataTransfer.setData("text/plain", th.dataset.col);
            th.classList.add("opacity-50");
          };
          th.ondragend = function () { th.classList.remove("opacity-50"); };
          th.ondragover = function (e) { e.preventDefault(); th.classList.add("ring-2", "ring-sky-400"); };
          th.ondragleave = function () { th.classList.remove("ring-2", "ring-sky-400"); };
          th.ondrop = function (e) {
            e.preventDefault(); e.stopPropagation();
            th.classList.remove("ring-2", "ring-sky-400");
            var from = e.dataTransfer.getData("text/plain"), to = th.dataset.col;
            if (!from || from === to) return;
            var cfg = M.columns.config();
            cfg.order.splice(cfg.order.indexOf(from), 1);
            cfg.order.splice(cfg.order.indexOf(to), 0, from);
            M.columns.save(cfg); M.columns.apply();
          };
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
              cfg.widths[th.dataset.col] = th.offsetWidth;
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
      store(LS.view, {q: st.q, sort: st.sort, desc: st.desc,
                      artist: st.artist, album: st.album, folder: st.folder});
    },
    restoreFilters: function () {
      var s = load(LS.view, null);
      if (!s) return;
      st.q = s.q || ""; st.sort = s.sort || "artist"; st.desc = !!s.desc;
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

      a.addEventListener("timeupdate", function () {
        var fill = $("mus-fill"), cur = $("mus-cur");
        if (fill) fill.style.width = (a.duration ? a.currentTime / a.duration * 100 : 0) + "%";
        if (cur) cur.textContent = fmt(a.currentTime);
        // позицию сохраняем не чаще раза в 5 секунд
        if (!M._savedAt || Date.now() - M._savedAt > 5000) {
          M._savedAt = Date.now();
          if (st.now) store(LS.track, {track: st.now, time: a.currentTime});
        }
      });
      a.addEventListener("loadedmetadata", function () {
        var d = $("mus-dur"); if (d) d.textContent = fmt(a.duration);
      });
      a.addEventListener("ended", function () {
        if (M.repeatOn) { a.currentTime = 0; a.play(); } else M.next();
      });
      a.addEventListener("error", function () {
        if (!a.src) return;                       // источник сняли намеренно
        SW.toast("Не удалось воспроизвести трек");
      });
      a.addEventListener("play", function () {
        $("mus-play-icon").className = "ti ti-player-pause-filled text-sm";
      });
      a.addEventListener("pause", function () {
        $("mus-play-icon").className = "ti ti-player-play-filled text-sm";
      });

      var seekZone = $("mus-seek-zone");
      if (seekZone) seekZone.addEventListener("wheel", M.seekWheel, {passive: false});
      var volZone = $("mus-vol-zone");
      if (volZone) volZone.addEventListener("wheel", M.volumeWheel, {passive: false});

      document.addEventListener("keydown", function (e) {
        if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
        var dialog = $("confirm-host");
        if (dialog && !dialog.classList.contains("hidden")) return;
        if (e.key === "Delete" && SW.view === "music") { e.preventDefault(); M.deleteCurrent(); }
      });

      // после подмены списка/боковых панелей восстанавливаем подсветку и столбцы
      document.body.addEventListener("htmx:afterSwap", function (e) {
        if (!e.target) return;
        if (e.target.id === "music-tracks") { M.markRow(); M.columns.apply(); }
        if (e.target.id === "music-lists") M.markLists();
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
