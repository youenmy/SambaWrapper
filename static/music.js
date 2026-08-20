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
    tree: "sw.musTree",       // режим дерева папок
    viz: "sw.musViz",         // визуализатор включён
    sorts: "sw.musSorts",     // сортировка, запомненная для каждой области
    pins: "sw.musPins",       // папки, закреплённые наверху панели
  };

  var COLUMNS = [
    {id: "pick", name: "Выбор", fixed: true},
    {id: "spacer", name: "", fixed: true},   // распорка: в меню столбцов не показывается
    {id: "cover", name: "Обложка", fixed: true},
    {id: "title", name: "Название", fixed: true},
    {id: "artist", name: "Исполнитель"},
    {id: "album", name: "Альбом"},
    {id: "year", name: "Год"},
    {id: "genre", name: "Жанр"},
    {id: "bitrate", name: "Битрейт"},
    {id: "path", name: "Путь в библиотеке"},
    {id: "size", name: "Размер"},
    {id: "duration", name: "Время"},
    {id: "actions", name: "Действия", fixed: true},
  ];
  var HIDDEN_BY_DEFAULT = ["genre", "bitrate", "path"];

  /* Ширины столбцов в пикселях. Держим их таблицей значений, а не измеряем
     готовую вёрстку: измерения зависят от того, что успел посчитать браузер,
     и любое движение столбца пересчитывало соседей. Здесь ширина столбца
     меняется только тогда, когда её меняет пользователь. */
  var WIDTHS = {
    pick: 34, cover: 44, title: 280, artist: 190, album: 210, year: 60,
    genre: 130, bitrate: 90, path: 280, size: 100, duration: 76, actions: 44,
  };

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
    tree: false,    // библиотека показана деревом папок, а не плоским списком
    only: false,    // показывать только треки самой папки, без вложенных
    picked: [],     // отмеченные галочками треки — для массовых действий
    viz: true,      // визуализатор: снимает звук в аудиограф, это слышно не всем
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
              page: st.page, seed: st.seed, only: st.only ? "yes" : "no"};
    },

    /* ------------------------------------------------ закреплённые папки
     * Панель приходит с сервера в своём порядке, поэтому закрепление делается
     * на клиенте: строки нужных папок переносятся в отдельную секцию наверху.
     * Так порядок не зависит от режима панели — работает и в плоском списке,
     * и в дереве, где строка живёт внутри узла со своими детьми. */
    pins: {
      list: function () {
        var saved = load(LS.pins, []);
        return Array.isArray(saved) ? saved : [];
      },
      has: function (path) { return M.pins.list().indexOf(path) >= 0; },
      toggle: function (path) {
        var pinned = M.pins.list();
        var i = pinned.indexOf(path);
        if (i >= 0) pinned.splice(i, 1); else pinned.push(path);
        store(LS.pins, pinned);
        M.pins.apply();
        SW.toast(i >= 0 ? "Папка откреплена" : "Папка закреплена наверху");
      },
      /** Перенести закреплённые строки наверх и пометить булавки. */
      apply: function () {
        var wrap = $("mus-pinned-wrap"), box = $("mus-pinned");
        if (!wrap || !box) return;
        var pinned = M.pins.list();

        // вернуть на место то, что откреплено: проще перерисовать панель
        var moved = 0;
        pinned.forEach(function (path) {
          var sel = '[data-folder="' + (window.CSS && CSS.escape ? CSS.escape(path) : path) + '"]';
          var item = document.querySelector("#music-lists " + sel);
          if (!item) return;                     // папки нет в текущем срезе дерева
          var node = item.closest(".mus-node") || item;
          if (node.parentElement !== box) box.appendChild(node);
          moved++;
        });
        wrap.classList.toggle("hidden", moved === 0);

        document.querySelectorAll("#music-lists .mus-item[data-folder]").forEach(function (item) {
          var on = pinned.indexOf(item.dataset.folder) >= 0;
          item.classList.toggle("mus-pinned", on);
          var pin = item.querySelector(".mus-pin");
          if (pin) pin.title = on ? "Открепить" : "Закрепить наверху";
        });
      },
    },

    /* --------------------------------------------- сортировка по областям
     * Сортировка принадлежит тому, что сейчас показано: «вся музыка», папка,
     * исполнитель или альбом. Иначе выбранный в одном месте порядок молча
     * переносится на другое — например, «перемешать» во всей библиотеке
     * подменяется алфавитом, выбранным для одного исполнителя. */
    sortScope: {
      key: function () {
        if (st.artist) return "artist:" + st.artist;
        if (st.album) return "album:" + st.album;
        if (st.folder) return (st.only ? "here:" : "folder:") + st.folder;
        return "all";
      },
      all: function () { return load(LS.sorts, {}) || {}; },
      save: function () {
        var map = M.sortScope.all();
        map[M.sortScope.key()] = {sort: st.sort, desc: st.desc, seed: st.seed};
        // список областей не должен расти бесконечно
        var keys = Object.keys(map);
        if (keys.length > 60) delete map[keys[0]];
        store(LS.sorts, map);
      },
      /** Взять сортировку области; для незнакомой — порядок как в папках. */
      restore: function () {
        var saved = M.sortScope.all()[M.sortScope.key()];
        st.sort = saved && saved.sort || "path";
        st.desc = !!(saved && saved.desc);
        st.seed = (saved && saved.seed) || 0;
        var sel = $("mus-sort");
        if (sel) sel.value = st.sort + ":" + (st.desc ? "desc" : "asc");
      },
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
      M.sortScope.save();
      M.reloadTracks();
    },
    sortSelect: function (value) {
      var parts = String(value).split(":");
      st.sort = parts[0]; st.desc = parts[1] === "desc"; st.page = 1;
      // «перемешать»: новый seed при каждом выборе — иначе порядок повторится
      st.seed = (st.sort === "random") ? Math.floor(Math.random() * 900000) + 1000 : 0;
      M.sortScope.save();
      M.reloadTracks();
    },
    filterArtist: function (name) {
      M.sortScope.save();                      // порядок остаётся у прежней области
      st.artist = name; st.album = ""; st.folder = ""; st.page = 1;
      M.sortScope.restore();
      M.reloadTracks(); M.reloadLists();
    },
    filterAlbum: function (name) {
      M.sortScope.save();
      st.album = name; st.page = 1;
      M.sortScope.restore();
      M.reloadTracks(); M.markLists();
    },
    /** Треки, лежащие прямо в корне библиотеки, без содержимого подпапок. */
    filterLoose: function (root) {
      M.sortScope.save();
      st.folder = root; st.artist = ""; st.album = ""; st.page = 1; st.only = true;
      M.sortScope.restore();
      M.reloadTracks(); M.markLists();
    },
    filterFolder: function (path) {
      var same = st.folder === path && !st.only;   // второй клик двойного нажатия ничего не меняет
      if (same) { M.markLists(); return; }
      M.sortScope.save();
      st.folder = path; st.artist = ""; st.album = ""; st.page = 1; st.only = false;
      M.sortScope.restore();
      M.reloadTracks();
      M.markLists();
    },
    /* --------------------------------------------------- дерево: файлы
     * Перетаскивание и контекстное меню работают только в режиме дерева и
     * только у администратора: это операции с диском, а не с базой. */
    fs: {
      dragged: null,          // {kind: "folder"|"track", path, name}

      canEdit: function () { return st.tree && SW.role === "admin"; },

      start: function (event, kind, path, name) {
        if (!M.fs.canEdit()) { event.preventDefault(); return; }
        M.fs.dragged = {kind: kind, path: path, name: name};
        try {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", path);
        } catch (e) { /* некоторым браузерам достаточно объекта выше */ }
      },
      over: function (event, path) {
        var d = M.fs.dragged;
        if (!d || !M.fs.canEdit()) return;
        if (d.kind === "folder" && (d.path === path || path.indexOf(d.path + "/") === 0)) return;
        event.preventDefault();                       // разрешаем бросить
        event.dataTransfer.dropEffect = "move";
        event.currentTarget.classList.add("mus-drop");
      },
      leave: function (event) { event.currentTarget.classList.remove("mus-drop"); },
      drop: function (event, path) {
        event.preventDefault();
        event.currentTarget.classList.remove("mus-drop");
        var d = M.fs.dragged;
        M.fs.dragged = null;
        if (!d || !M.fs.canEdit() || d.path === path) return;
        SW.confirm("Переместить «" + d.name + "» в «" + path.split("/").pop() + "»?",
          function () { SW.post("/htmx/music-fs-move", {src: d.path, dest: path}); },
          {ok: "Переместить"});
      },

      /** Контекстное меню трека в таблице. */
      trackMenu: function (event, id, path, title) {
        event.preventDefault();
        var menu = document.getElementById("ctxmenu");
        if (!menu) return;
        var name = String(path).split("/").pop();
        var folder = String(path).slice(0, String(path).length - name.length - 1);
        var items = [
          ["ti-player-play", "Воспроизвести", function () { M.play(id); }, ""],
          ["ti-folder", "Показать папку", function () { M.filterFolder(folder); }, ""],
          ["ti-download", "Скачать", function () { M.fs.download(path); }, ""],
        ];
        if (SW.role === "admin") {
          items.push(["ti-edit", "Переименовать файл",
                      function () { M.fs.renameFile(path, name); }, ""]);
        }
        items.push(["ti-trash", "Удалить с диска",
                    function () { M.deleteTrack(id, title || name); }, "text-red-600"]);
        M.fs._render(menu, items, event);
      },
      download: function (path) {
        var root = (SW.mountRoot || "").replace(/\/$/, "");
        var rel = path.indexOf(root + "/") === 0 ? path.slice(root.length + 1) : path;
        window.location = "/download?path=" + encodeURIComponent(rel);
      },
      renameFile: function (path, name) {
        SW.prompt("Новое имя файла", name, function (value) {
          value = (value || "").trim();
          if (!value || value === name) return;
          SW.post("/htmx/music-fs-rename", {path: path, name: value});
        });
      },
      /** Собрать меню из готовых пунктов: подписи свои, чужой текст в HTML не попадает. */
      _render: function (menu, items, event) {
        menu.innerHTML = "";
        items.forEach(function (item) {
          var b = document.createElement("button");
          b.className = "w-full text-left flex items-center gap-2 px-2.5 py-1.5 rounded-md " +
                        "hover:bg-slate-100 " + item[3];
          b.innerHTML = '<i class="ti ' + item[0] + ' text-slate-500"></i>' + item[1];
          b.onclick = function () { menu.classList.add("hidden"); item[2](); };
          menu.appendChild(b);
        });
        menu.style.left = Math.min(event.clientX, window.innerWidth - 210) + "px";
        menu.style.top = Math.min(event.clientY, window.innerHeight - 40 - items.length * 34) + "px";
        menu.classList.remove("hidden");
      },

      /** Контекстное меню папки: переименовать или удалить с диска. */
      menu: function (event, path, name) {
        if (!M.fs.canEdit()) return;
        event.preventDefault();
        var menu = document.getElementById("ctxmenu");
        if (!menu) return;
        M.fs._render(menu, [
          ["ti-edit", "Переименовать", function () { M.fs.rename(path, name); }, ""],
          ["ti-trash", "Удалить с диска", function () { M.fs.remove(path, name); }, "text-red-600"],
        ], event);
      },
      rename: function (path, name) {
        SW.prompt("Новое имя папки", name, function (value) {
          value = (value || "").trim();
          if (!value || value === name) return;
          SW.post("/htmx/music-fs-rename", {path: path, name: value});
        });
      },
      remove: function (path, name) {
        SW.confirm("Удалить папку «" + name + "» со всем содержимым?\n" +
                   "Файлы будут стёрты с диска безвозвратно.",
          function () { SW.post("/htmx/music-fs-delete", {path: path}); },
          {ok: "Удалить", danger: true});
      },
    },

    /** Двойной клик по папке в дереве — раскрыть или свернуть её ветку. */
    toggleFolderNode: function (item, path) {
      var node = item.closest(".mus-node");
      var caret = node && node.querySelector(".mus-caret");
      if (caret) M.toggleNode(caret, path);
    },
    /* Дерево папок: включается кнопкой на панели и переживает перезагрузку.
     * Уровни подгружаются по мере раскрытия — строить всё дерево из десяти
     * тысяч путей на каждое открытие панели незачем. */
    toggleTree: function () {
      st.tree = !st.tree;
      store(LS.tree, st.tree ? "1" : "");
      M._treeButton();
      M.reloadLists();
    },
    _treeButton: function () {
      var b = $("mus-tree-btn");
      if (b) b.classList.toggle("tbb-on", st.tree);
    },
    /** Раскрыть или свернуть ветку; дети запрашиваются при первом раскрытии. */
    toggleNode: function (button, path) {
      var node = button.closest(".mus-node");
      var kids = node && node.querySelector(".mus-kids");
      var icon = button.querySelector("i");
      if (!kids) return;
      var opening = kids.classList.contains("hidden");
      kids.classList.toggle("hidden", !opening);
      if (icon) icon.className = "ti ti-chevron-" + (opening ? "down" : "right") + " text-sm";
      if (opening && !kids.dataset.loaded) {
        kids.dataset.loaded = "1";
        kids.innerHTML = '<div class="px-2 py-1 text-xs text-slate-400">Загрузка…</div>';
        htmx.ajax("GET", "/htmx/music-subfolders", {
          target: kids, swap: "innerHTML",
          values: {parent: path, folder: st.folder},
        }).then(function () { M.markLists(); M.pins.apply(); });
      }
    },

    clearFilters: function () {
      M.sortScope.save();
      st.q = ""; st.artist = ""; st.album = ""; st.folder = ""; st.page = 1; st.only = false;
      M.sortScope.restore();
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
        if (found) M.playTrack(found);          // playTrack сам покажет строку
      } else if (isFirst) {
        M.revealCurrent();                      // список перерисован целиком
      }
      // очередная порция при прокрутке ничего не двигает: пользователь смотрит список
      M.pickRestore();
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
                 page: next, seed: st.seed, only: st.only ? "yes" : "no"},
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
      // смена трека в фоне (доиграл, next) не должна вытаскивать док в чужой раздел
      if (SW.view === "music") $("mus-bar").classList.remove("hidden");
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
        exclude: st.recent.join(","), only: st.only ? "yes" : "no",
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
                 page: page, seed: st.seed, reset: "yes", only: st.only ? "yes" : "no"},
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
        if (!st.viz || !$("mus-viz") || !V._ensure()) return;
        V._connect(audio());
      },
      /** Отпустить деки: звук снова идёт напрямую из плеера. */
      detach: function () {
        var V = M.viz;
        Object.keys(V.sources).forEach(function (id) {
          var src = V.sources[id];
          if (src.kind === "stream") {
            try { src.node.disconnect(); } catch (e) { /* уже отключён */ }
            delete V.sources[id];
          }
          // отвод через createMediaElementSource снять нельзя — он навсегда
          // забирает выход элемента; такие деки освободит только перезагрузка
        });
      },
      start: function () {
        var V = M.viz;
        if (!st.viz) return;
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
      /* Цвета спектра живут в теме: читаем токены, а не зашиваем константы.
         Значение кэшируется — getComputedStyle на каждый кадр слишком дорог. */
      _colors: function () {
        var V = M.viz;
        if (V._skin) return V._skin;
        var css = getComputedStyle(document.documentElement);
        var pick = function (name, fallback) {
          var v = (css.getPropertyValue(name) || "").trim();
          return v || fallback;
        };
        V._skin = {
          a: pick("--sw-viz-hot-a", "#0284c7"),
          b: pick("--sw-viz-hot-b", "#7dd3fc"),
          cold: pick("--sw-viz-cold", "rgba(148,163,184,0.4)"),
        };
        return V._skin;
      },
      /** Тема сменилась — пересчитать цвета на следующем кадре. */
      recolor: function () { M.viz._skin = null; },
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
        var skin = M.viz._colors();
        var hot = g.createLinearGradient(0, h, 0, 0);
        hot.addColorStop(0, skin.a);
        hot.addColorStop(1, skin.b);
        var cold = g.createLinearGradient(0, h, 0, 0);
        cold.addColorStop(0, skin.cold);
        cold.addColorStop(1, skin.cold);

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
    /* Показать играющий трек, но только если он ушёл за пределы окна списка:
     * дёргать прокрутку под треком, который и так на виду, незачем. */
    revealCurrent: function () {
      if (!st.nowId) return;
      var pane = $("music-tracks");
      var row = document.querySelector('#music-tracks .mrow[data-id="' + st.nowId + '"]');
      if (!row || !pane) return;

      var r = row.getBoundingClientRect();
      var p = pane.getBoundingClientRect();
      // липкая шапка висит поверх списка: строка под ней невидима, поэтому
      // рабочий верх окна — её нижний край
      var head = pane.querySelector("thead");
      var top = p.top + (head ? head.getBoundingClientRect().height : 0);
      var gap = 8;

      /* Прокручиваем вручную. scrollIntoView про липкую шапку не знает и
         прижимает строку к краю контейнера — она оказывается под заголовками,
         снова считается невидимой, и так каждый раз. */
      if (r.top < top) pane.scrollTop -= (top - r.top) + gap;
      else if (r.bottom > p.bottom) pane.scrollTop += (r.bottom - p.bottom) + gap;
    },
    /* Обложка выступает над доком и перекрывала бы хвост списка папок —
     * дотягиваем список ровно на высоту выступающей части. */
    _fitLists: function () {
      var lists = $("music-lists"), bar = $("mus-bar"), cover = $("mus-cover-wrap");
      if (!lists) return;
      if (!bar || !cover || bar.classList.contains("hidden")) { lists.style.marginBottom = ""; return; }
      // панель заканчивается над обложкой — вместе с ней и полоса прокрутки
      var over = bar.getBoundingClientRect().top - cover.getBoundingClientRect().top;
      lists.style.marginBottom = Math.max(0, Math.round(over) + 6) + "px";
    },
    markLists: function () {
      var nothingPicked = !st.folder && !st.artist && !st.album;
      document.querySelectorAll("#music-lists .mus-item").forEach(function (b) {
        var on = b.dataset.loose ? st.only
              : b.dataset.all ? (nothingPicked && !st.only)  // «Все треки» — когда фильтров нет
              : (b.dataset.folder && b.dataset.folder === st.folder && !st.only)
              || (b.dataset.artist && b.dataset.artist === st.artist)
              || (b.dataset.album && b.dataset.album === st.album);
        b.classList.toggle("mus-on", !!on);
      });
    },

    // -------------------------------------------------------------- удаление
    deleteTrack: function (id, name) {
      SW.confirm("Удалить трек «" + name + "» с диска?\nФайл будет стёрт безвозвратно.",
        function () {
          var playing = (id === st.nowId);
          var following = playing ? M._nextInQueue(id) : null;
          M._request(id, function () {
            if (playing) { if (following) M.playTrack(following); else M.close(); }
            M.dropRow(id);
          });
        },
        {ok: "Удалить", danger: true});
    },
    /* Визуализатор снимает звук деки в аудиограф. Узел работает в реальном
       времени и пересчитывает частоту дискретизации (файл 44.1 кГц, контекст
       обычно 48 кГц), что у части систем даёт щелчки. Поэтому его можно
       выключить: тогда звук идёт напрямую из плеера, мимо графа. */
    toggleViz: function () {
      st.viz = !st.viz;
      store(LS.viz, st.viz ? "1" : "");
      M.vizButton();
      if (st.viz) {
        M.viz.start();
      } else {
        M.viz.stop();
        M.viz.detach();
        SW.toast("Визуализатор выключен — звук идёт мимо аудиографа");
      }
    },
    vizButton: function () {
      var b = $("mus-viz-btn");
      if (b) {
        b.classList.toggle("tbb-on", st.viz);
        b.title = st.viz ? "Выключить визуализатор (если слышны щелчки)"
                         : "Включить визуализатор";
      }
      var canvas = $("mus-viz");
      if (canvas) canvas.classList.toggle("hidden", !st.viz);
      var fill = $("mus-fill");
      // без спектра полоса прогресса должна быть видимой сама по себе
      if (fill) fill.classList.toggle("bg-sky-500/40", !st.viz);
    },

    /* ------------------------------------------------ выделение галочками
     * Отмеченное живёт в st.picked, а не читается из DOM: строки уезжают при
     * подгрузке и перерисовке, и выделение не должно от этого зависеть. */
    pick: function (id, box) {
      var i = st.picked.indexOf(id);
      if (box.checked && i < 0) st.picked.push(id);
      if (!box.checked && i >= 0) st.picked.splice(i, 1);
      M.pickBar();
    },
    pickAll: function (on) {
      document.querySelectorAll("#music-tracks .mus-pick").forEach(function (box) {
        box.checked = on;
        var id = Number(box.dataset.id);
        var i = st.picked.indexOf(id);
        if (on && i < 0) st.picked.push(id);
        if (!on && i >= 0) st.picked.splice(i, 1);
      });
      M.pickBar();
    },
    pickNone: function () {
      st.picked = [];
      document.querySelectorAll("#music-tracks .mus-pick").forEach(function (b) { b.checked = false; });
      var all = $("mus-pick-all"); if (all) all.checked = false;
      M.pickBar();
    },
    /** Вернуть галочки строкам после перерисовки списка. */
    pickRestore: function () {
      document.querySelectorAll("#music-tracks .mus-pick").forEach(function (box) {
        box.checked = st.picked.indexOf(Number(box.dataset.id)) >= 0;
      });
      M.pickBar();
    },
    /** Панель массовых действий видна, только когда что-то отмечено. */
    pickBar: function () {
      var bar = $("mus-pickbar");
      if (!bar) return;
      bar.classList.toggle("hidden", st.picked.length === 0);
      var label = $("mus-pick-count");
      if (label) label.textContent = st.picked.length;
    },
    deletePicked: function () {
      if (!st.picked.length) return;
      var ids = st.picked.slice();
      var nl = String.fromCharCode(10);
      SW.confirm("Удалить отмеченные треки с диска?" + nl + "Выбрано: " + ids.length +
                 nl + nl + "Файлы будут стёрты безвозвратно.",
        function () {
          fetch("/htmx/music-delete-many", {
            method: "POST", body: new URLSearchParams({ids: ids.join(",")}),
          }).then(function (r) { return r.text(); })
            .then(function (html) {
              SW._toastHtml(html);
              // играющий трек мог оказаться среди удалённых
              if (ids.indexOf(st.nowId) >= 0) {
                var next = M._nextInQueue(st.nowId);
                if (next && ids.indexOf(next.id) < 0) M.playTrack(next); else M.close();
              }
              ids.forEach(function (id) { M.dropRow(id); });
              M.pickNone();
            })
            .catch(function () { SW.toast("Не удалось удалить"); });
        }, {ok: "Удалить", danger: true});
    },

    /* Убрать строку удалённого трека, не перерисовывая список.
     *
     * Перезапрос списка сбрасывал бы и прокрутку, и позицию играющего трека —
     * поэтому строка гаснет на месте, а нижние подтягиваются на её высоту.
     * Сдвиг делается смещением, а не пересчётом вёрстки: высоту строк таблицы
     * браузеры анимировать не умеют. */
    dropRow: function (id) {
      var row = document.querySelector('#music-tracks .mrow[data-id="' + id + '"]');
      for (var k = 0; k < st.queue.length; k++) {
        if (st.queue[k].id === id) { st.queue.splice(k, 1); break; }
      }
      if (st.total > 0) st.total--;
      var p = st.picked.indexOf(id);
      if (p >= 0) st.picked.splice(p, 1);
      if (!row) return;

      var h = row.getBoundingClientRect().height;
      var below = [];
      for (var el = row.nextElementSibling; el; el = el.nextElementSibling) below.push(el);

      row.style.transition = "opacity .12s ease";
      row.style.opacity = "0";
      below.forEach(function (e) {
        e.style.transition = "transform .18s ease";
        e.style.transform = "translateY(-" + h + "px)";
      });
      setTimeout(function () {
        below.forEach(function (e) { e.style.transition = ""; e.style.transform = ""; });
        row.remove();
      }, 190);
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
            M.dropRow(track.id);
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
      var p = new URLSearchParams({folder: st.folder, artist: st.artist, album: st.album,
                                   only: st.only ? "yes" : "no"});
      SW.openModal("/htmx/music-duplicates?" + p.toString());
    },
    /** Окно дубликатов отрисовано — запоминаем порядок копий. */
    dupsRendered: function () {
      st.dups = Array.prototype.map.call(
        document.querySelectorAll("#modal-host .dup-row"),
        function (row) {
          return {id: Number(row.dataset.copy), label: row.dataset.label || "",
                  title: row.dataset.title || row.dataset.label || "",
                  artist: row.dataset.artist || "",
                  duration: Number(row.dataset.dur || 0),
                  cover: row.dataset.cover === "1"};
        });
      M.markRow();
    },
    /** Проиграть конкретную копию из окна дубликатов. */
    playCopy: function (id) {
      var copy = null;
      for (var i = 0; i < st.dups.length; i++) if (st.dups[i].id === id) { copy = st.dups[i]; break; }
      // у копии те же теги и обложка, что у трека в списке: берём их, а не одну подпись
      M.playTrack(copy ? {id: id, title: copy.title, artist: copy.artist, album: "",
                          duration: copy.duration, cover: copy.cover}
                       : {id: id, title: "", artist: "", album: "", duration: 0, cover: true});
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
            if (following) M.playCopy(following.id);
            else {
              var next = M._nextInQueue(id);
              if (next) M.playTrack(next); else M.close();
            }
          }
          M.dropRow(id);          // и в списке за окном строка уходит на месте
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
        // новые столбцы дописываются в конец, поэтому кнопку всегда возвращаем
        // на последнее место — иначе она уезжает в середину таблицы
        order = order.filter(function (id) {
          return id !== "actions" && id !== "pick" && id !== "spacer";
        });
        // распорка всегда перед кнопкой, кнопка всегда последняя
        order = ["pick"].concat(order, "spacer", "actions");
        var widths = {};
        Object.keys(WIDTHS).forEach(function (id) { widths[id] = WIDTHS[id]; });
        Object.keys(cfg.widths || {}).forEach(function (id) { widths[id] = cfg.widths[id]; });
        return {order: order, hidden: cfg.hidden || HIDDEN_BY_DEFAULT.slice(), widths: widths};
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
            cell.style.width = ""; cell.style.minWidth = "";   // ширину задаёт colgroup
            row.appendChild(cell);
          });
        });

        M.columns._colgroup(cfg);
        M.columns._dragAndDrop();
        M.columns._resizers();
      },
      /* Ширины живут в <colgroup>: при табличной раскладке fixed именно он
         определяет столбцы. Перестановка меняет порядок <col> вместе с
         ячейками, поэтому каждый столбец уносит свою ширину с собой и соседи
         не пересчитываются. Распорка идёт без ширины и забирает остаток. */
      _colgroup: function (cfg) {
        var table = document.querySelector("#music-tracks table");
        if (!table) return;
        var group = table.querySelector("colgroup");
        if (!group) {
          group = document.createElement("colgroup");
          table.insertBefore(group, table.firstChild);
        }
        group.innerHTML = "";
        cfg.order.forEach(function (id) {
          if (cfg.hidden.indexOf(id) >= 0) return;
          var col = document.createElement("col");
          col.dataset.col = id;
          if (id !== "spacer") col.style.width = (cfg.widths[id] || 120) + "px";
          group.appendChild(col);
        });
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

      /* Изменение ширины меняет ровно один <col> и запоминает ровно одно
         значение. Остальные столбцы не измеряются и не переписываются —
         поэтому и не могут разъехаться. */
      _resizers: function () {
        document.querySelectorAll("#music-tracks th[data-col]").forEach(function (th) {
          var id = th.dataset.col;
          if (th.querySelector(".col-resizer") || id === "actions" || id === "spacer") return;
          th.style.position = "relative";
          var handle = document.createElement("div");
          handle.className = "col-resizer";
          handle.addEventListener("click", function (e) { e.stopPropagation(); });
          handle.addEventListener("dragstart", function (e) { e.preventDefault(); });
          handle.addEventListener("mousedown", function (e) {
            e.preventDefault(); e.stopPropagation();
            var col = document.querySelector('#music-tracks col[data-col="' + id + '"]');
            if (!col) return;
            var cfg = M.columns.config();
            var startX = e.clientX, startW = cfg.widths[id] || th.offsetWidth;
            var width = startW;
            document.body.style.userSelect = "none";
            function move(ev) {
              width = Math.max(48, Math.round(startW + ev.clientX - startX));
              col.style.width = width + "px";
            }
            function up() {
              document.removeEventListener("mousemove", move);
              document.removeEventListener("mouseup", up);
              document.body.style.userSelect = "";
              var saved = load(LS.cols, {}) || {};
              saved.widths = saved.widths || {};
              saved.widths[id] = width;
              M.columns.save(saved);
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
      st.tree = !!localStorage.getItem(LS.tree);
      st.viz = localStorage.getItem(LS.viz) !== "";   // по умолчанию включён
      setTimeout(M.vizButton, 120);
      setTimeout(M._treeButton, 120);        // кнопка приезжает вместе с панелью
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
          /* Разные причины требуют разных действий, поэтому называем их:
             сеть — проблема с сервером или сессией, декодирование — битый
             файл, формат — браузер не умеет такой кодек. */
          var reasons = {
            1: "загрузка прервана",
            2: "сеть недоступна или сессия истекла",
            3: "не удалось декодировать файл",
            4: "браузер не поддерживает этот формат",
          };
          var code = (el.error && el.error.code) || 0;
          var name = (st.now && st.now.title) || "";
          console.error("SambaWrapper: ошибка воспроизведения", code,
                        el.error && el.error.message, srcOf(el));

          /* Формат «не поддерживается» — чаще всего не кодек, а испорченные
             метаданные в контейнере. Пробуем тот же трек через пересборку на
             сервере, один раз: если и она не сыграет, значит дело в файле. */
          if (code === 4 && srcOf(el).indexOf("fix=yes") < 0 && st.nowId) {
            var retry = "/music-audio/" + st.nowId + "?fix=yes";
            el.src = retry;
            el.load();
            el.play().catch(function () {});
            SW.toast("Файл с испорченными метаданными — играю через пересборку");
            return;
          }
          SW.toast("Не удалось воспроизвести" + (name ? " «" + name + "»" : "") +
                   ": " + (reasons[code] || "неизвестная ошибка"));
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
        if (e.target.id === "music-lists") {
          M.markLists(); M._fitLists(); M._treeButton(); M.pins.apply();
        }
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
