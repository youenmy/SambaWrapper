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
    volume: "sw.musVolume",   // прежняя линейная громкость — читается один раз для переноса
    level: "sw.musLevel",     // положение ползунка громкости
    muted: "sw.musMuted",     // приглушение тоже переживает перезагрузку
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

  /* Часть настроек общая для всех устройств пользователя и живёт на сервере.
     Сохранение остаётся одним вызовом: локальная копия пишется всегда, а
     синхронизируемые ключи дополнительно уходят наверх — так ни одно место
     сохранения не приходится помнить отдельно. */
  var SHARED = {"sw.musPins": "musPins", "sw.musCols": "musCols",
                "sw.musSorts": "musSorts", "sw.musTree": "musTree", "sw.musViz": "musViz",
                "sw.musTrack": "musTrack"};   // что играло и с какой секунды — продолжить на другом компе

  function store(key, value) {
    try { localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value)); }
    catch (e) { /* приватный режим — просто не сохраняем */ }
    if (SHARED[key] && window.SW && SW.savePref) SW.savePref(SHARED[key]);
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
      htmx.ajax("GET", "/htmx/music-page", {target: "#browser", swap: "innerHTML settle:140ms"})
        .then(function () { M.restoreNow(); });
    },

    // ---------------------------------------------------------------- список
    reloadTracks: function () {
      M.saveFilters();
      var el = $("music-tracks");
      if (el) htmx.trigger(el, "refreshMusicTracks");
    },
    /* Панель перезапрашиваем напрямую, а не событием: событие обрабатывается
       общим слушателем, и порядок его прихода относительно других запросов не
       гарантирован — из-за этого закреплённые папки иногда оставались
       непереставленными. Здесь же перенос идёт строго после ответа. */
    reloadLists: function () {
      var el = $("music-lists");
      if (!el) return;
      htmx.ajax("GET", "/htmx/music-lists", {
        target: "#music-lists", swap: "innerHTML",
        values: {artist: st.artist, album: st.album, folder: st.folder,
                 tree: st.tree ? "yes" : "no"},
      }).then(function () {
        M.markLists(); M._fitLists(); M._treeButton(); M.pins.apply();
      });
    },
    /** Данные для hx-vals: сервер получает ровно текущее состояние фильтров. */
    query: function () {
      return {q: st.q, sort: st.sort, desc: st.desc ? "yes" : "no",
              artist: st.artist, album: st.album, folder: st.folder,
              page: st.page, seed: st.seed};
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
      /* Панель перерисовывают несколько источников: загрузка раздела, смена
         фильтров, обновление библиотеки. Любая перерисовка выбрасывает
         перенесённые наверх строки, поэтому вместо угадывания порядка запросов
         следим за содержимым панели и возвращаем закреплённые сразу после
         каждой замены. Свои же перестановки при этом игнорируем. */
      _watch: function () {
        var host = $("music-lists");
        if (!host || host._musPinWatch || typeof MutationObserver !== "function") return;
        host._musPinWatch = true;
        var observer = new MutationObserver(function () {
          /* Событие нельзя отбрасывать, даже если прямо сейчас идёт наша
             перестановка: перерисовка панели приходит вплотную к ней, и
             отброшенное событие означало бы, что закреплённые не вернутся
             уже никогда. Всегда откладываем попытку — она идемпотентна. */
          clearTimeout(M.pins._settle);
          M.pins._settle = setTimeout(function () { M.pins.apply(); }, 60);
        });
        observer.observe(host, {childList: true, subtree: true});
      },
      /* Убрать закрепления папок, которых больше нет.
       *
       * Уверенно судить можно только о папках верхнего уровня: они есть в
       * панели всегда, в обоих режимах. Вложенная папка может отсутствовать
       * просто потому, что её ветка свёрнута, — такие закрепления не трогаем. */
      _forget: function (missing) {
        if (!missing.length) return;
        var host = document.querySelector("#music-lists [data-root]");
        var root = host && host.dataset.root;
        if (!root) return;
        var stale = missing.filter(function (path) {
          return path.lastIndexOf("/") === root.replace(/\/$/, "").length;
        });
        if (!stale.length) return;
        var kept = M.pins.list().filter(function (p) { return stale.indexOf(p) < 0; });
        store(LS.pins, kept);
        console.log("SambaWrapper: закрепления удалённых папок сняты", stale);
      },
      _sel: function (path) {
        return '[data-folder="' + (window.CSS && CSS.escape ? CSS.escape(path) : path) + '"]';
      },
      /** Перенести закреплённые строки наверх и вернуть откреплённые обратно.
       *
       * На месте унесённой строки остаётся метка, поэтому открепление кладёт
       * узел ровно туда, откуда он ушёл, и раскрытые ветки дерева не теряются. */
      apply: function () {
        var wrap = $("mus-pinned-wrap"), box = $("mus-pinned");
        M.pins._watch();
        if (!wrap || !box) return;
        if (M.pins._busy) return;      // защита от рекурсии внутри одной перестановки
        M.pins._busy = true;
        var pinned = M.pins.list();

        // откреплённое возвращаем по метке
        Array.prototype.slice.call(box.children).forEach(function (node) {
          var item = node.matches("[data-folder]") ? node : node.querySelector("[data-folder]");
          var path = item && item.dataset.folder;
          if (!path || pinned.indexOf(path) >= 0) return;
          var anchor = document.querySelector("#music-lists .mus-pin-anchor" + M.pins._sel(path));
          if (anchor) {
            anchor.parentElement.insertBefore(node, anchor);
            anchor.remove();
          } else {
            node.remove();                       // исходного места нет — уберём совсем
          }
        });

        var moved = 0, missing = [];
        pinned.forEach(function (path) {
          var item = document.querySelector("#music-lists " + M.pins._sel(path));
          if (!item) { missing.push(path); return; }   // папки нет в текущем срезе дерева
          var node = item.closest(".mus-node") || item;
          if (node.parentElement !== box) {
            var anchor = document.createElement("div");
            anchor.className = "mus-pin-anchor hidden";
            anchor.dataset.folder = path;
            node.parentElement.insertBefore(anchor, node);
            box.appendChild(node);
          }
          moved++;
        });
        var rows = document.querySelectorAll("#music-lists .mus-item[data-folder]").length;
        // панель ещё не отрисована — не прячем секцию и не снимаем закрепления,
        // иначе одна неудачная попытка похоронит их до перезагрузки страницы
        if (rows || !pinned.length) wrap.classList.toggle("hidden", moved === 0);
        if (rows) M.pins._forget(missing);
        M.pins._busy = false;

        /* Метка закрепления теперь на строке целиком: булавка — соседняя
           кнопка, а не потомок кнопки папки. */
        document.querySelectorAll("#music-lists .mus-item[data-folder]").forEach(function (item) {
          var on = pinned.indexOf(item.dataset.folder) >= 0;
          var row = item.closest(".mus-node") || item;
          item.classList.toggle("mus-pinned", on);
          row.classList.toggle("mus-pinned", on);
          var pin = row.querySelector(".mus-pin");
          if (pin) {
            pin.title = on ? "Открепить" : "Закрепить наверху";
            pin.setAttribute("aria-pressed", on ? "true" : "false");
          }
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
        if (st.folder) return "folder:" + st.folder;
        return "all";
      },
      all: function () { return load(LS.sorts, {}) || {}; },
      save: function () {
        var map = M.sortScope.all();
        var key = M.sortScope.key();
        // ключ переставляется в конец: вытесняется самая давно тронутая область,
        // а не та, что появилась первой и которой пользуются постоянно
        delete map[key];
        map[key] = {sort: st.sort, desc: st.desc, seed: st.seed};
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
      if (!name) return;                       // у трека нет тега исполнителя — фильтровать нечего
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
    filterFolder: function (path) {
      var same = st.folder === path;   // второй клик двойного нажатия ничего не меняет
      if (same) { M.markLists(); return; }
      M.sortScope.save();
      st.folder = path; st.artist = ""; st.album = ""; st.page = 1;
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

      /** Контекстное меню папки: скрыть из общего списка, переименовать, удалить.
       *
       * Меню доступно в обоих режимах панели, а не только в дереве: скрытие
       * никак не связано с перетаскиванием, ради которого дерево включают. */
      menu: function (event, path, name) {
        if (SW.role !== "admin") return;
        event.preventDefault();
        var menu = document.getElementById("ctxmenu");
        if (!menu) return;
        var hidden = !!(event.currentTarget && event.currentTarget.classList.contains("mus-hidden"));
        var items = [hidden
          ? ["ti-eye", "Вернуть в общий список", function () { M.fs.hide(path, false); }, ""]
          : ["ti-eye-off", "Скрыть из общего списка", function () { M.fs.hide(path, true); }, ""]];
        items.push(["ti-edit", "Переименовать", function () { M.fs.rename(path, name); }, ""]);
        items.push(["ti-trash", "Удалить с диска",
                    function () { M.fs.remove(path, name); }, "text-red-600"]);
        M.fs._render(menu, items, event);
      },
      /* Скрытая папка остаётся в панели и играется, если её открыть, но её
         треки не попадают в «Все треки», поиск и случайное воспроизведение. */
      hide: function (path, on) {
        SW.post("/htmx/music-hide", {path: path, hidden: on ? "yes" : "no"});
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
      st.q = ""; st.artist = ""; st.album = ""; st.folder = ""; st.page = 1;
      M.sortScope.restore();
      var box = $("mus-search"); if (box) box.value = "";
      M.reloadTracks(); M.reloadLists();
    },
    /* Играть всю библиотеку: снимаем фильтры и запускаем первый трек, когда
       список придёт. Порядок не трогаем — сортировка и «случайно» остаются
       такими, как их настроили. При включённом «случайно» первый трек берётся
       случайный, как и все следующие. */
    playAll: function () {
      M._playFirst = true;
      M.clearFilters();
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
      if (M._nextAt != null && !isFirst) {
        var at = M._nextAt;
        M._nextAt = null;
        if (st.queue[at]) M.playTrack(st.queue[at]);   // «следующий» из новой порции
      } else if (isFirst) {
        M._nextAt = null;                       // список сменился — ждать нечего
      }
      if (M._playFirst && isFirst) {
        M._playFirst = false;
        if (M.shuffleOn) M.playRandom();
        else if (st.queue[0]) M.playTrack(st.queue[0]);
      } else if (M._playAfterLoad) {
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
                 page: next, seed: st.seed},
      }).then(function () { st.page = next; })
        .catch(function () { st.loading = false; M._nextAt = null; });
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
      M._applyVolume();
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
        cover.onerror = function () { cover.classList.add("hidden"); M.tint.reset(); };
        M.tint.fromCover(cover);
      } else {
        cover.removeAttribute("src"); cover.classList.add("hidden");
        M.tint.reset();
      }
      M.np.sync(track);
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
        /* Следующий трек — в ещё не загруженной порции. Раньше переход ждал
           ровно 0,7 с: через интернет порция часто приходит позже, и музыка
           молча останавливалась. Теперь appendQueue запускает трек, когда
           порция действительно пришла. */
        M._nextAt = st.queue.length;
        M.loadMore();
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
      M.np.buttons();
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
      M.np.buttons();
    },
    seekClick: function (event) {
      var a = audio();
      if (!a.duration) return;
      var box = $("mus-seek").getBoundingClientRect();
      a.currentTime = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) * a.duration;
    },
    /* Полоса перемотки объявлена ползунком, значит должна слушаться клавиш:
       стрелки — 5 секунд, Home/End — края трека. Глобальные стрелки двигают
       на 10 секунд и работают, когда фокуса на полосе нет. */
    seekKey: function (event) {
      var a = audio();
      if (!a || !a.duration) return;
      var step = 5, to = null;
      if (event.key === "ArrowRight" || event.key === "ArrowUp") to = a.currentTime + step;
      else if (event.key === "ArrowLeft" || event.key === "ArrowDown") to = a.currentTime - step;
      else if (event.key === "Home") to = 0;
      else if (event.key === "End") to = a.duration - 1;
      else if (event.key === " " || event.key === "Enter") { event.preventDefault(); M.toggle(); return; }
      if (to === null) return;
      event.preventDefault();
      event.stopPropagation();          // иначе глобальный обработчик добавит свои 10 секунд
      a.currentTime = Math.max(0, Math.min(a.duration - 0.5, to));
    },
    seekWheel: function (event) {
      event.preventDefault();
      var a = audio();
      if (!a.duration) return;
      a.currentTime = Math.max(0, Math.min(a.duration - 0.5,
        a.currentTime + (event.deltaY < 0 ? 5 : -5)));
    },
    /* Громкость хранится одним значением и раздаётся обеим декам.
       Раньше новая дека копировала громкость у прежней; стоило прежней
       оказаться со значением по умолчанию — и в хранилище уезжала единица,
       то есть максимум. Теперь копировать не у кого: есть сохранённое число.

       Хранится положение ползунка (0…1), а шкала логарифмическая — в
       децибелах. Слух воспринимает громкость логарифмически: при линейной
       шкале почти вся слышимая разница умещалась в нижней части ползунка, там
       каждый шаг был скачком, а верхние шаги звучали одинаково. Теперь весь
       ползунок охватывает VOLUME_DB децибел, и каждый шаг прибавляет одно и то
       же число децибел: середина — −25 дБ. Чистый логарифм до нуля не доходит,
       поэтому крайнее левое положение — тишина. Ползунок идёт по 1 %
       (100 уровней), колесо и стрелки — по 2 %. */
    VOLUME_STEP: 0.02,
    VOLUME_DB: 50,
    level: function () {
      var l = parseFloat(localStorage.getItem(LS.level));
      if (isNaN(l)) {
        // Перенос прежней линейной громкости по той же шкале: положение
        // выбирается так, чтобы после обновления звук не стал ни громче, ни тише.
        var old = parseFloat(localStorage.getItem(LS.volume));
        if (isNaN(old)) l = 1;
        else if (old <= 0) l = 0;
        else l = 1 + 20 * Math.log10(Math.min(1, old)) / M.VOLUME_DB;
        l = Math.max(0, Math.min(1, l));
        store(LS.level, String(Math.round(l * 1000) / 1000));
      }
      return Math.max(0, Math.min(1, l));
    },
    /** Громкость в децибелах относительно максимума (0 — максимум). */
    decibels: function () {
      var l = M.level();
      return l <= 0 ? -Infinity : (l - 1) * M.VOLUME_DB;
    },
    /** Громкость, которая уходит в деку: из децибел обратно в множитель. */
    volume: function () {
      var l = M.level();
      return l <= 0 ? 0 : Math.pow(10, M.decibels() / 20);
    },
    setVolume: function (level) {
      var l = Math.max(0, Math.min(1, parseFloat(level)));
      if (isNaN(l)) return;
      store(LS.level, String(Math.round(l * 1000) / 1000));
      M._applyVolume();
      M._volumeIcon();
    },
    /** Раздать сохранённую громкость обеим декам и ползунку. */
    _applyVolume: function () {
      var l = M.level(), v = M.volume();
      var muted = localStorage.getItem(LS.muted) === "1" || l <= 0;
      [$("mus-audio"), $("mus-audio-b")].forEach(function (el) {
        if (!el) return;
        el.volume = v;
        el.muted = muted;
      });
      var slider = $("mus-vol");
      if (slider) {
        slider.value = muted ? 0 : l;
        var pct = muted ? "выключена"
                : Math.round(l * 100) + " % (" + Math.round(M.decibels()) + " дБ)";
        slider.title = "Громкость: " + pct;
        slider.setAttribute("aria-valuetext", pct);
      }
    },
    volumeWheel: function (event) {
      event.preventDefault();
      M.setVolume(M.level() + (event.deltaY < 0 ? M.VOLUME_STEP : -M.VOLUME_STEP));
    },
    mute: function () {
      var on = !audio().muted;
      store(LS.muted, on ? "1" : "");
      M._applyVolume();
      M._volumeIcon();
    },
    _volumeIcon: function () {
      var a = audio(), icon = $("mus-vol-icon");
      if (!icon) return;
      icon.className = (a.muted || a.volume === 0) ? "ti ti-volume-off"
                     : (M.level() < 0.5 ? "ti ti-volume-2" : "ti ti-volume");
    },
    close: function () {
      M.np.hide();
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
        // обложка дала свой цвет — сыгранная часть спектра окрашивается в него
        var t = M.tint.color;
        if (t) {
          V._skin.a = "rgb(" + t.r + "," + t.g + "," + t.b + ")";
          var mix = function (v) { return Math.round(v + (255 - v) * 0.45); };
          V._skin.b = "rgb(" + mix(t.r) + "," + mix(t.g) + "," + mix(t.b) + ")";
        }
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
      /* Кадр: спектр читается один раз, а рисуется в каждый видимый холст —
       * в полосу дока и, если открыт полноэкранный режим, в его полосу. */
      _draw: function () {
        var V = M.viz, c = $("mus-viz");
        if (!c || !V.analyser) { V.raf = 0; return; }
        V.analyser.getByteFrequencyData(V.data);

        // тихую запись растягиваем на всю высоту: делим не на 255, а на текущий
        // пик, который медленно оседает, — громкая всё равно не упрётся в потолок
        var peak = 0;
        for (var k = 0; k < V.data.length; k++) if (V.data[k] > peak) peak = V.data[k];
        V.norm = Math.max(peak, (V.norm || 0) * 0.97, 32);

        var a = audio();
        var played = (a && a.duration) ? a.currentTime / a.duration : 0;
        V._paint(c, played, 9, 4);
        if (M.np.open) {
          var big = $("mus-np-viz");
          if (big) V._paint(big, played, 12, 6);
        }
        V._checkSilence(peak);
        /* На паузе спектр стоит, а 60 кадров в секунду гоняли процессор
           впустую. Рисуем последний кадр и останавливаемся; start() на
           событии play запустит цикл снова. */
        if (a && a.paused) { V.raf = 0; return; }
        V.raf = requestAnimationFrame(V._draw);
      },
      /** Один кадр на паузе: перемотка должна сдвигать сыгранную часть спектра. */
      frame: function () {
        var V = M.viz;
        if (st.viz && V.analyser && !V.raf) V.raf = requestAnimationFrame(V._draw);
      },
      _paint: function (c, played01, barPx, gapPx) {
        var V = M.viz;
        var dpr = window.devicePixelRatio || 1;
        var w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
        if (w < 2 || h < 2) return;                   // холст скрыт — рисовать некуда
        if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }

        var g = c.getContext("2d");
        g.clearRect(0, 0, w, h);
        var played = played01 * w;
        var bins = V.data.length;
        var barW = Math.round(barPx * dpr);
        var gap = Math.round(gapPx * dpr);
        var count = Math.max(8, Math.floor(w / (barW + gap)));
        var radius = barW / 2;

        // сыгранная часть — яркий градиент снизу вверх, остаток — приглушённый
        var skin = M.viz._colors();
        var hot = g.createLinearGradient(0, h, 0, 0);
        hot.addColorStop(0, skin.a);
        hot.addColorStop(1, skin.b);
        var cold = g.createLinearGradient(0, h, 0, 0);
        cold.addColorStop(0, skin.cold);
        cold.addColorStop(1, skin.cold);

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
      },
    },

    /* ------------------------------------------------- цвет из обложки
     *
     * Из обложки берётся самый «живой» цвет и расходится по декоративным
     * слоям: свечению дока, рамке обложки, спектру, фону полноэкранного
     * режима. Текст не трогается никогда — он остаётся на токенах темы,
     * поэтому контраст, выверенный по WCAG, от обложки не зависит.
     */
    tint: {
      color: null,
      _token: 0,
      /** Обложка текущего трека загрузилась (или уже в кэше) — снять цвет. */
      fromCover: function (img) {
        var T = M.tint, token = ++T._token;
        var run = function () {
          if (token !== T._token) return;             // успел смениться трек
          try { T._extract(img); } catch (e) { T.reset(); }
        };
        if (!img || !img.getAttribute || !img.getAttribute("src")) { T.reset(); return; }
        if (img.complete && img.naturalWidth) run();
        else img.addEventListener("load", run, {once: true});
      },
      /** Тема сменилась: у светлой и тёмной разные пределы яркости. */
      refresh: function () {
        var img = $("mus-cover");
        if (img && img.getAttribute("src") && !img.classList.contains("hidden")) M.tint.fromCover(img);
        else M.tint.reset();
      },
      _root: function () { return document.documentElement; },
      _extract: function (img) {
        var root = M.tint._root();
        // «Контраст» обещает отсутствие украшений, а в эффектах подкраску
        // можно выключить явно — в обоих случаях остаёмся на цветах темы
        if (!root || root.dataset.theme === "contrast" || root.dataset.fxTint === "off") {
          M.tint.reset(); return;
        }
        var size = 24;
        var c = document.createElement("canvas");
        c.width = c.height = size;
        var g = c.getContext("2d", {willReadFrequently: true});
        g.drawImage(img, 0, 0, size, size);
        var px = g.getImageData(0, 0, size, size).data;

        /* Среднее по картинке почти всегда даёт грязно-серый. Раскладываем
           пиксели по корзинам тона и взвешиваем насыщенностью и близостью к
           средней яркости: побеждает цвет, который на обложке и заметен, и ярок. */
        var buckets = {};
        for (var i = 0; i < px.length; i += 4) {
          var hsl = M.tint._hsl(px[i], px[i + 1], px[i + 2]);
          if (hsl.s < 0.22 || hsl.l < 0.1 || hsl.l > 0.92) continue;
          var weight = hsl.s * (1 - Math.abs(hsl.l - 0.5) * 1.3);
          if (weight <= 0) continue;
          var key = Math.round(hsl.h * 24) % 24;
          var b = buckets[key] || (buckets[key] = {w: 0, r: 0, g: 0, b: 0});
          b.w += weight; b.r += px[i] * weight; b.g += px[i + 1] * weight; b.b += px[i + 2] * weight;
        }
        var best = null;
        Object.keys(buckets).forEach(function (k) {
          if (!best || buckets[k].w > best.w) best = buckets[k];
        });
        // монохромная обложка: подкрашивать нечем, остаёмся на теме
        if (!best || best.w < size * size * 0.02) { M.tint.reset(); return; }

        var col = M.tint._hsl(best.r / best.w, best.g / best.w, best.b / best.w);
        // на тёмной теме цвет должен светиться, на светлой — не выгорать
        var dark = M.tint._isDark();
        col.s = Math.min(0.9, Math.max(col.s, 0.5));
        col.l = dark ? Math.min(0.72, Math.max(col.l, 0.58)) : Math.min(0.46, Math.max(col.l, 0.34));
        M.tint._apply(M.tint._rgb(col.h, col.s, col.l), true);
      },
      _isDark: function () {
        var root = M.tint._root();
        var v = (getComputedStyle(root).getPropertyValue("--sw-surface") || "").trim();
        var m = /^#([0-9a-f]{6})$/i.exec(v);
        if (!m) return root.classList.contains("dark");
        var n = parseInt(m[1], 16);
        return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) < 128;
      },
      _apply: function (rgb, fromCover) {
        var root = M.tint._root();
        if (!root || !root.style) return;
        var val = rgb.r + " " + rgb.g + " " + rgb.b;
        root.style.setProperty("--sw-cover", "rgb(" + val + ")");
        root.style.setProperty("--sw-cover-soft", "rgb(" + val + " / 0.38)");
        root.style.setProperty("--sw-cover-faint", "rgb(" + val + " / 0.16)");
        root.classList.toggle("sw-tinted", !!fromCover);
        M.tint.color = fromCover ? rgb : null;
        M.viz.recolor();
      },
      /** Цвета нет — фону полноэкранного режима всё равно нужен оттенок: берём акцент темы. */
      reset: function () {
        M.tint._token++;
        var root = M.tint._root();
        if (!root || !root.style) return;
        var acc = (getComputedStyle(root).getPropertyValue("--sw-accent") || "").trim();
        var m = /^#([0-9a-f]{6})$/i.exec(acc);
        var n = m ? parseInt(m[1], 16) : 0x0284c7;
        M.tint._apply({r: n >> 16, g: (n >> 8) & 255, b: n & 255}, false);
      },
      _hsl: function (r, g, b) {
        r /= 255; g /= 255; b /= 255;
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
      },
      _rgb: function (h, s, l) {
        var f = function (n) {
          var k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l);
          return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
        };
        return {r: f(0), g: f(8), b: f(4)};
      },
    },

    /* ------------------------------------------------ «Сейчас играет»
     *
     * Полноэкранный режим поверх всего приложения: крупная обложка, она же
     * размытой авророй на фоне и спектр во всю ширину. Открывается клавишей F
     * или кликом по обложке в доке, закрывается Esc. Звук и очередь — те же,
     * режим только показывает текущее состояние плеера.
     */
    np: {
      open: false,
      toggle: function () { if (M.np.open) M.np.hide(); else M.np.show(); },
      show: function () {
        var el = $("mus-np");
        if (!el || !st.now || M.np.open) return;
        M.np.sync(st.now);
        M.np._return = document.activeElement;
        el.hidden = false;
        M.np.open = true;
        /* Раскладку пересчитываем принудительно, а не ждём следующего кадра:
           переход прозрачности всё равно срабатывает, но режим не зависит от
           requestAnimationFrame — в фоновой вкладке кадры не идут, и оверлей
           оставался бы невидимым, перехватывая клики. */
        void el.offsetWidth;
        el.classList.add("np-on");
        var play = $("mus-np-play");
        if (play && play.focus) play.focus({preventScroll: true});
        M.viz.start();
      },
      hide: function () {
        var el = $("mus-np");
        if (!el || !M.np.open) return;
        M.np.open = false;
        el.classList.remove("np-on");
        setTimeout(function () { if (!M.np.open) el.hidden = true; }, 180);
        var back = M.np._return;
        M.np._return = null;
        if (back && back.focus && document.body.contains(back)) back.focus({preventScroll: true});
      },
      /** Перенести в режим название, обложку и состояние кнопок. */
      sync: function (track) {
        var title = $("mus-np-title");
        if (!title || !track) return;
        title.textContent = track.title || "—";
        $("mus-np-meta").textContent = [track.artist, track.album].filter(Boolean).join(" — ");
        var src = track.cover ? "/music-cover/" + track.id : "";
        ["mus-np-cover", "mus-np-bg"].forEach(function (id) {
          var img = $(id);
          if (!img) return;
          if (src) img.src = src; else img.removeAttribute("src");
        });
        var art = $("mus-np-art");
        if (art) art.classList.toggle("np-noart", !src);
        M.np.buttons();
      },
      buttons: function () {
        var a = audio(), icon = $("mus-np-play-icon"), play = $("mus-np-play");
        var paused = !a || a.paused;
        if (icon) icon.className = "ti " + (paused ? "ti-player-play-filled" : "ti-player-pause-filled");
        if (play) play.setAttribute("aria-label", paused ? "Играть" : "Пауза");
        var sh = $("mus-np-shuffle"), rp = $("mus-np-repeat");
        if (sh) { sh.classList.toggle("np-active", !!M.shuffleOn); sh.setAttribute("aria-pressed", M.shuffleOn ? "true" : "false"); }
        if (rp) { rp.classList.toggle("np-active", !!M.repeatOn); rp.setAttribute("aria-pressed", M.repeatOn ? "true" : "false"); }
      },
      seek: function (event) {
        var a = audio();
        if (!a || !a.duration) return;
        var box = $("mus-np-seek").getBoundingClientRect();
        a.currentTime = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) * a.duration;
      },
      /** Табуляция не должна уходить в приложение за оверлеем. */
      trap: function (e) {
        var el = $("mus-np");
        var items = Array.prototype.slice.call(el.querySelectorAll("button, [tabindex='0']"))
          .filter(function (x) { return x.offsetParent !== null; });
        if (!items.length) return;
        var first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
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
      st.pickAnchor = id;               // от галочки тоже можно продолжить Shift+кликом
      M.pickRestore();
    },
    pickAll: function (on) {
      document.querySelectorAll("#music-tracks .mus-pick").forEach(function (box) {
        var id = Number(box.dataset.id);
        var i = st.picked.indexOf(id);
        if (on && i < 0) st.picked.push(id);
        if (!on && i >= 0) st.picked.splice(i, 1);
      });
      M.pickRestore();
    },
    pickNone: function () {
      st.picked = [];
      st.pickAnchor = null;
      M.pickRestore();
    },

    /* ------------------------------------------ выделение как в проводнике
     * Обычный клик по строке по-прежнему запускает трек: в плеере это главное
     * действие, и отдавать его под выделение было бы неудобно. Отмечают
     * модификаторы: Ctrl переключает строку, Shift отмечает диапазон от
     * последней отмеченной, Ctrl+Shift добавляет диапазон к уже отмеченному.
     * Сам диапазон считает общий UI.range — тот же, что у файлового браузера. */
    rowClick: function (event, id) {
      var add = event.ctrlKey || event.metaKey;
      if (event.shiftKey) { M.pickRange(id, add); return; }
      if (add) { M.pickToggle(id); return; }
      M.play(id);
    },
    pickToggle: function (id) {
      var i = st.picked.indexOf(id);
      if (i >= 0) st.picked.splice(i, 1); else st.picked.push(id);
      st.pickAnchor = id;
      M.pickRestore();
    },
    pickRange: function (id, add) {
      var ids = Array.prototype.map.call(document.querySelectorAll("#music-tracks .mrow"),
                                         function (row) { return Number(row.dataset.id); });
      var span = window.UI ? UI.range(ids, st.pickAnchor, id) : [id];
      if (!span.length) return;
      if (add) span.forEach(function (x) { if (st.picked.indexOf(x) < 0) st.picked.push(x); });
      else st.picked = span;
      // якорь не двигаем: следующий Shift+клик тоже считается от него, как в проводнике
      if (st.pickAnchor == null) st.pickAnchor = id;
      M.pickRestore();
    },

    /** Привести галочки, подсветку строк и общую галочку к st.picked.
     *  Вызывается и после перерисовки списка: строки приходят без отметок. */
    pickRestore: function () {
      var boxes = document.querySelectorAll("#music-tracks .mus-pick"), marked = 0;
      boxes.forEach(function (box) {
        var on = st.picked.indexOf(Number(box.dataset.id)) >= 0;
        box.checked = on;
        if (on) marked++;
      });
      document.querySelectorAll("#music-tracks .mrow").forEach(function (row) {
        row.classList.toggle("mus-picked", st.picked.indexOf(Number(row.dataset.id)) >= 0);
      });
      var all = $("mus-pick-all");
      if (all) {
        all.checked = boxes.length > 0 && marked === boxes.length;
        all.indeterminate = marked > 0 && marked < boxes.length;
      }
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
          }).then(M._deletedFrom)
            .then(function (res) {
              SW._toastHtml(res.html);
              /* Убираем только то, что сервер подтвердил: файл на защищённом
                 диске остаётся, и его строка исчезать не должна. Неудалённые
                 остаются отмеченными — их видно и можно повторить. */
              var gone = res.deleted;
              if (gone.indexOf(st.nowId) >= 0) {
                var next = M._nextInQueue(st.nowId);
                if (next && gone.indexOf(next.id) < 0) M.playTrack(next); else M.close();
              }
              gone.forEach(function (id) { M.dropRow(id); });
              st.picked = st.picked.filter(function (id) { return gone.indexOf(id) < 0; });
              M.pickRestore();
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

      /* Если открыто окно дубликатов и звучит одна из копий, удаление должно
         вести себя ровно как кнопка в этом окне: убрать строку копии и
         перейти к следующей копии, а не искать следующий трек в общем списке. */
      var copy = null;
      for (var i = 0; i < st.dups.length; i++) {
        if (st.dups[i].id === track.id) { copy = st.dups[i]; break; }
      }
      if (copy && document.querySelector('#modal-host .dup-row[data-copy="' + track.id + '"]')) {
        return M.deleteCopy(track.id, copy.path || copy.label || "");
      }
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
    /** Ответ на удаление: текст тоста и id, которые сервер действительно удалил. */
    _deletedFrom: function (r) {
      var header = r.headers.get("X-Deleted") || "";
      var deleted = header.split(",").filter(Boolean).map(Number);
      return r.text().then(function (html) { return {html: html, deleted: deleted}; });
    },
    /* done вызывается, только если файл действительно удалён: раньше
       интерфейс убирал строку и переключал музыку и при отказе сервера
       (нет прав, защищённый от записи диск), хотя файл оставался на месте. */
    _request: function (id, done) {
      fetch("/htmx/music-delete", {method: "POST", body: new URLSearchParams({id: id})})
        .then(M._deletedFrom)
        .then(function (res) {
          SW._toastHtml(res.html);
          if (done && res.deleted.indexOf(id) >= 0) done();
        })
        .catch(function () { SW.toast("Не удалось удалить"); });
    },

    // ------------------------------------------------------------ дубликаты
    openDuplicates: function () {
      var p = new URLSearchParams({folder: st.folder, artist: st.artist, album: st.album});
      SW.openModal("/htmx/music-duplicates?" + p.toString());
    },
    /** Окно дубликатов отрисовано — запоминаем порядок копий. */
    dupsRendered: function () {
      // номер группы нужен, чтобы после схлопывания группы уйти к следующей,
      // а не к оставшейся копии — её как раз и оставили намеренно
      var groups = Array.prototype.slice.call(
        document.querySelectorAll("#modal-host .dup-group"));
      st.dups = Array.prototype.map.call(
        document.querySelectorAll("#modal-host .dup-row"),
        function (row) {
          return {id: Number(row.dataset.copy), label: row.dataset.label || "",
                  path: row.dataset.path || "",
                  title: row.dataset.title || row.dataset.label || "",
                  artist: row.dataset.artist || "",
                  duration: Number(row.dataset.dur || 0),
                  cover: row.dataset.cover === "1",
                  group: groups.indexOf(row.closest(".dup-group"))};
        });
      M.markRow();
    },
    /* Куда переходить после удаления копии.
     *
     * Пока в группе остаётся хотя бы две копии, она никуда не денется —
     * играем следующую в ней. Если после удаления копия останется одна,
     * группа исчезнет из окна, и продолжать ею бессмысленно: уходим к первой
     * копии следующей группы, а если её нет — предыдущей. */
    _afterCopy: function (idx) {
      var gone = st.dups[idx];
      if (!gone) return null;
      var sameGroup = st.dups.filter(function (d, i) {
        return d.group === gone.group && i !== idx;
      });
      if (sameGroup.length >= 2) {
        for (var i = idx + 1; i < st.dups.length; i++) {
          if (st.dups[i].group === gone.group) return st.dups[i];
        }
        return sameGroup[0];
      }
      var next = null, prev = null;
      st.dups.forEach(function (d, i) {
        if (i === idx || d.group === gone.group) return;
        if (d.group > gone.group && !next) next = d;
        if (d.group < gone.group) prev = d;
      });
      return next || prev;
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
        var following = idx >= 0 ? M._afterCopy(idx) : null;

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
        cover.onerror = function () { cover.classList.add("hidden"); M.tint.reset(); };
        M.tint.fromCover(cover);
      } else {
        cover.removeAttribute("src"); cover.classList.add("hidden");
        M.tint.reset();
      }
      /* Восстановленный после перезагрузки трек проходит мимо playTrack, поэтому
         подкраску и полноэкранный режим надо подготовить здесь же — иначе цвет
         появлялся только со следующим треком. */
      M.np.sync(track);
      M.markRow();
    },

    // ------------------------------------------------------------------ init
    init: function () {
      var a = audio();
      if (!a) return;

      M._applyVolume();          // обе деки получают сохранённую громкость
      M._volumeIcon();

      /* События вешаем на обе деки, но реагируем только на активную —
       * вторая в это время молча качает следующий трек. */
      [$("mus-audio"), $("mus-audio-b")].forEach(function (el) {
        if (!el) return;
        function active() { return el === audio(); }

        el.addEventListener("timeupdate", function () {
          if (!active()) return;
          var pct = el.duration ? el.currentTime / el.duration * 100 : 0;
          if (el.paused) M.viz.frame();        // перемотка на паузе
          var fill = $("mus-fill"), head = $("mus-head"), cur = $("mus-cur");
          if (fill) fill.style.width = pct + "%";
          if (head) head.style.left = pct + "%";
          if (cur) cur.textContent = fmt(el.currentTime);
          // ползунок сообщает позицию вслух: процент — для роли, время — для человека
          var seek = $("mus-seek");
          if (seek) {
            seek.setAttribute("aria-valuenow", Math.round(pct));
            seek.setAttribute("aria-valuetext", fmt(el.currentTime) + " из " + fmt(el.duration));
          }
          if (M.np.open) {
            var npc = $("mus-np-cur"), npd = $("mus-np-dur"), nps = $("mus-np-seek");
            if (npc) npc.textContent = fmt(el.currentTime);
            if (npd) npd.textContent = fmt(el.duration);
            if (nps) nps.setAttribute("aria-valuenow", Math.round(pct));
          }
          // позицию сохраняем не чаще раза в 5 секунд (и сразу на паузе — ниже)
          if (!M._savedAt || Date.now() - M._savedAt > 5000) {
            M._savedAt = Date.now();
            if (st.now) store(LS.track, {track: st.now, time: el.currentTime});
          }
        });
        // поставили на паузу — точную секунду сохраняем сразу: скорее всего,
        // дальше слушать будут уже с другого устройства
        el.addEventListener("pause", function () {
          if (el === audio() && st.now && el.currentTime > 0) {
            M._savedAt = Date.now();
            store(LS.track, {track: st.now, time: el.currentTime});
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
          M.np.buttons();
          M.viz.start();
        });
        // звук пошёл — только теперь у деки есть готовая аудиодорожка для отвода
        el.addEventListener("playing", function () {
          if (active()) M.viz.start();
        });
        el.addEventListener("pause", function () {
          if (!active()) return;
          $("mus-play-icon").className = "ti ti-player-play-filled text-sm";
          M.np.buttons();
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
        /* Под открытым окном (настройки, столбцы, видео) клавиши плеера
           молчат: Delete в настройках предлагал удалить играющий трек, а F
           открывал полноэкранный режим поверх окна. Исключение — окно
           дубликатов: Delete в нём удаляет звучащую копию намеренно. */
        var modal = $("modal-host");
        if (modal && !modal.classList.contains("hidden") && !modal.querySelector(".dup-group")) return;
        // F (и А на русской раскладке) — полноэкранный режим, где бы ты ни был
        var plain = !e.ctrlKey && !e.metaKey && !e.altKey;
        if (plain && /^[fFаА]$/.test(e.key) && st.now) { e.preventDefault(); M.np.toggle(); return; }
        if (M.np.open) {
          if (e.key === "Escape") { e.preventDefault(); M.np.hide(); return; }
          if (e.key === "Tab") { M.np.trap(e); return; }
        } else if (SW.view !== "music") {
          return;
        }
        // Ctrl+A — отметить все загруженные треки (распознаёт общий UI.isSelectAll)
        if (window.UI && UI.isSelectAll(e) && !M.np.open) {
          e.preventDefault(); M.pickAll(true); return;
        }
        if (e.key === "Escape" && !M.np.open && st.picked.length) {
          e.preventDefault(); M.pickNone(); return;
        }
        if (e.key === "Delete") {
          if (M.np.open) return;          // удалять файл из полноэкранного режима не даём
          e.preventDefault(); M.deleteCurrent(); return;
        }
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
          M.setVolume(M.level() + (e.key === "ArrowUp" ? M.VOLUME_STEP : -M.VOLUME_STEP));
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
