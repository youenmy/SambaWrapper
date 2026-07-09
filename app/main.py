"""FastAPI app: routes + HTMX endpoints (two-pane File Station UI)."""
import asyncio
import contextlib
import hashlib
import json
import logging
import mimetypes
import re
import socket
from pathlib import Path

APP_VERSION = "1.3"
from fastapi import FastAPI, Request, Form, Depends, HTTPException, UploadFile, File
from fastapi.responses import HTMLResponse, RedirectResponse, PlainTextResponse, FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.sessions import SessionMiddleware
from . import auth, db, disks, browse, samba, fileops, portcfg, dlna, torrent, shell
from .config import MOUNT_ROOT, DATA_DIR

BASE_DIR = Path(__file__).resolve().parent.parent
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))
log = logging.getLogger("sambawrapper")

AUTOMOUNT_INTERVAL = 20  # seconds — covers hot-plug; runs once immediately at startup

@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    async def automount_loop():
        while True:
            try:
                msgs, mounted = await asyncio.to_thread(disks.auto_mount_known)
                for m in msgs:
                    log.info(m)
                for mp in mounted:  # сбросить залипшие SMB-сессии к шарам нового диска
                    await asyncio.to_thread(samba.close_shares_under, mp)
            except Exception as e:  # never let the loop die
                log.warning("automount loop error: %s", e)
            await asyncio.sleep(AUTOMOUNT_INTERVAL)
    task = asyncio.create_task(automount_loop())
    try:
        yield
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

app = FastAPI(title="SambaWrapper", lifespan=lifespan)
app.add_middleware(SessionMiddleware, secret_key=auth.ensure_session_secret(),
                   session_cookie="sambawrapper_sid", max_age=7 * 24 * 3600)
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")
auth.ensure_initial_password()


# ---------- auth ----------

@app.get("/login", response_class=HTMLResponse)
async def login_form(request: Request, err: str | None = None):
    return templates.TemplateResponse("login.html", {"request": request, "err": err})

@app.post("/login")
async def login_submit(request: Request, username: str = Form(...), password: str = Form(...)):
    if not auth.verify_password(username, password):
        await asyncio.sleep(1)  # притормаживаем перебор паролей
        return RedirectResponse("/login?err=1", status_code=303)
    request.session["user"] = username
    return RedirectResponse("/", status_code=303)

@app.post("/logout")
async def logout(request: Request):
    request.session.clear()
    return RedirectResponse("/login", status_code=303)

def current_user(request: Request) -> str:
    user = request.session.get("user")
    if not user:
        raise HTTPException(status_code=302, headers={"Location": "/login"})
    return user


# ---------- page ----------

@app.get("/", response_class=HTMLResponse)
async def index(request: Request, _: str = Depends(current_user)):
    return templates.TemplateResponse("index.html", {
        "request": request, "mount_root": str(MOUNT_ROOT), "port": portcfg.current_port(),
    })


# ---------- sidebar (disks + shares) ----------

@app.get("/htmx/sidebar", response_class=HTMLResponse)
async def htmx_sidebar(request: Request, _: str = Depends(current_user)):
    partitions = disks.list_partitions()
    shares = samba.list_shares()
    root = str(MOUNT_ROOT)
    if db.get_setting("ui_show_system_disks") != "yes":
        # прячем системные разделы: смонтированные вне нашего корня и
        # несмонтируемые; кандидаты на подключение (USB и т.п.) остаются
        partitions = [p for p in partitions
                      if (p.get("mountpoint") or "").startswith(root + "/")
                      or (not p.get("mountpoint") and p.get("mountable"))]
    assigned = set()
    for p in partitions:
        mp = p.get("mountpoint")
        if mp and mp.startswith(root + "/"):
            p["shares"] = sorted(
                [s for s in shares if s["path"] == mp or s["path"].startswith(mp + "/")],
                key=lambda s: s["name"].lower())
            assigned.update(s["name"] for s in p["shares"])
    orphan_shares = sorted([s for s in shares if s["name"] not in assigned],
                           key=lambda s: s["name"].lower())
    return templates.TemplateResponse("_sidebar.html", {
        "request": request, "partitions": partitions, "shares": shares,
        "orphan_shares": orphan_shares, "stale": disks.list_stale_mounts(),
        "dlna": dlna.status(), "torrent": torrent.status(), "mount_root": root,
    })

@app.post("/htmx/stale-clean", response_class=HTMLResponse)
async def htmx_stale_clean(request: Request, _: str = Depends(current_user), mountpoint: str = Form(...)):
    ok, msg = disks.clean_stale(mountpoint)
    return _resp(request, ok, msg or "Зависшая точка очищена", ["refreshSidebar"] if ok else [])

@app.post("/htmx/stale-clean-all", response_class=HTMLResponse)
async def htmx_stale_clean_all(request: Request, _: str = Depends(current_user)):
    n, errors = disks.clean_all_stale()
    if errors:
        return _resp(request, False, f"Очищено: {n}; ошибки: " + "; ".join(errors), ["refreshSidebar"])
    return _resp(request, True, f"Очищено зависших точек: {n}", ["refreshSidebar"])


# ---------- file browser ----------

@app.get("/htmx/browse", response_class=HTMLResponse)
async def htmx_browse(request: Request, _: str = Depends(current_user), path: str = ""):
    ctx = {"request": request, "mount_root": str(MOUNT_ROOT), "error": None, "listing": None, "disk": None}
    try:
        listing = browse.list_dir(path)
        ctx["listing"] = listing
        # at a disk root (top-level) attach disk info for the auto-mount toggle
        if listing["path"] and "/" not in listing["path"]:
            name = listing["path"]
            for p in disks.list_partitions():
                if p.get("mountpoint") == str(MOUNT_ROOT / name):
                    ctx["disk"] = {
                        "name": name, "label": p.get("label"), "uuid": p.get("uuid"),
                        "auto_mount": p.get("auto_mount"), "mountpoint": p.get("mountpoint"),
                    }
                    break
    except browse.BrowseError as e:
        ctx["error"] = str(e)
        ctx["cur_path"] = path
    return templates.TemplateResponse("_browser.html", ctx)


# ---------- disk actions ----------

@app.post("/htmx/mount", response_class=HTMLResponse)
async def htmx_mount(request: Request, _: str = Depends(current_user),
                     path: str = Form(...), mount_name: str = Form(...), fstype: str = Form(...),
                     uuid: str = Form(""), label: str = Form(""), auto_mount: str = Form("no")):
    ok, msg = disks.mount_partition(path, mount_name, fstype)
    if ok:
        if uuid:
            disks.remember_mount({"uuid": uuid, "label": label or None}, mount_name, auto_mount == "yes")
        samba.close_shares_under(str(MOUNT_ROOT / mount_name))  # сбросить залипшие сессии
    return _resp(request, ok, msg if not ok else f"Смонтировано: {mount_name}",
                 ["refreshSidebar", "closeModal"] if ok else [])

@app.post("/htmx/umount", response_class=HTMLResponse)
async def htmx_umount(request: Request, _: str = Depends(current_user),
                      mount_point: str = Form(...), force: str = Form("no")):
    ok, msg = disks.unmount(mount_point, force=(force == "yes"))
    return _resp(request, ok, msg or "Диск отключён — можно безопасно извлекать",
                 ["refreshSidebar", "refreshBrowser"])

@app.post("/htmx/automount-toggle", response_class=HTMLResponse)
async def htmx_automount_toggle(request: Request, _: str = Depends(current_user),
                                uuid: str = Form(...), mount_name: str = Form(...),
                                label: str = Form(""), enabled: str = Form("no")):
    on = enabled == "yes"
    ok, msg = disks.set_auto_mount(uuid, label or None, mount_name, on)
    text = ("Автомонтирование включено" if on else "Автомонтирование выключено") if ok else msg
    return _resp(request, ok, text, ["refreshSidebar"])

@app.post("/htmx/format", response_class=HTMLResponse)
async def htmx_format(request: Request, _: str = Depends(current_user),
                      device: str = Form(...), fstype: str = Form(...),
                      label: str = Form(""), confirm: str = Form("")):
    ok, msg = await asyncio.to_thread(disks.format_partition, device, fstype, label, confirm)
    return _resp(request, ok, msg, ["refreshSidebar", "closeModal"] if ok else [])

@app.post("/htmx/disk-check", response_class=HTMLResponse)
async def htmx_disk_check(request: Request, _: str = Depends(current_user), device: str = Form(...)):
    ok, msg = await asyncio.to_thread(disks.check_repair, device)
    return _resp(request, ok, msg, ["refreshSidebar"])


# ---------- file operations ----------

@app.post("/htmx/mkdir", response_class=HTMLResponse)
async def htmx_mkdir(request: Request, _: str = Depends(current_user),
                     path: str = Form(...), name: str = Form(...)):
    try:
        fileops.mkdir(path, name)
        return _resp(request, True, f"Папка «{name}» создана", ["refreshBrowser"])
    except fileops.FileOpError as e:
        return _resp(request, False, str(e), [])

@app.post("/htmx/rename", response_class=HTMLResponse)
async def htmx_rename(request: Request, _: str = Depends(current_user),
                      path: str = Form(...), new_name: str = Form(...)):
    try:
        fileops.rename(path, new_name)
        return _resp(request, True, "Переименовано", ["refreshBrowser", "refreshSidebar"])
    except fileops.FileOpError as e:
        return _resp(request, False, str(e), [])

@app.post("/htmx/delete", response_class=HTMLResponse)
async def htmx_delete(request: Request, _: str = Depends(current_user), path: str = Form(...)):
    try:
        fileops.delete(path)
        return _resp(request, True, "Удалено", ["refreshBrowser"])
    except fileops.FileOpError as e:
        return _resp(request, False, str(e), [])

@app.post("/htmx/delete-many", response_class=HTMLResponse)
async def htmx_delete_many(request: Request, _: str = Depends(current_user),
                           paths: list[str] = Form(default=[])):
    errs = []
    for p in paths:
        try:
            fileops.delete(p)
        except fileops.FileOpError as e:
            errs.append(f"{p}: {e}")
    if errs:
        return _resp(request, False, "Ошибки: " + "; ".join(errs[:3]), ["refreshBrowser"])
    return _resp(request, True, f"Удалено: {len(paths)}", ["refreshBrowser"])

@app.post("/htmx/move-many", response_class=HTMLResponse)
async def htmx_move_many(request: Request, _: str = Depends(current_user),
                         srcs: list[str] = Form(default=[]), dest_dir: str = Form(...)):
    n, errs = 0, []
    for s in srcs:
        try:
            fileops.move(s, dest_dir); n += 1
        except fileops.FileOpError as e:
            errs.append(f"{s}: {e}")
    if errs:
        return _resp(request, False, f"Перемещено {n}; ошибки: " + "; ".join(errs[:3]),
                     ["refreshBrowser", "closeModal"])
    return _resp(request, True, f"Перемещено: {n}", ["refreshBrowser", "closeModal"])

@app.get("/htmx/move-form", response_class=HTMLResponse)
async def htmx_move_form(request: Request, _: str = Depends(current_user), path: str = ""):
    return templates.TemplateResponse("_move_form.html", {
        "request": request, "src": path, "dirs": fileops.list_dirs_under_mounts(),
    })

@app.post("/htmx/move", response_class=HTMLResponse)
async def htmx_move(request: Request, _: str = Depends(current_user),
                    src: str = Form(...), dest_dir: str = Form(...)):
    try:
        fileops.move(src, dest_dir)
        return _resp(request, True, "Перемещено", ["refreshBrowser", "closeModal"])
    except fileops.FileOpError as e:
        return _resp(request, False, str(e), [])

@app.post("/htmx/mkdirs", response_class=HTMLResponse)
async def htmx_mkdirs(request: Request, _: str = Depends(current_user), dirs: list[str] = Form(default=[])):
    for d in dirs:
        try:
            fileops.makedirs(d)
        except fileops.FileOpError:
            pass
    return HTMLResponse("")  # silent — used by folder upload to pre-create (incl. empty) dirs

@app.post("/htmx/upload", response_class=HTMLResponse)
async def htmx_upload(request: Request, _: str = Depends(current_user),
                      dir: str = Form(...), file: UploadFile = File(...)):
    try:
        fileops.save_upload(dir, file.filename, file.file)
        return _resp(request, True, f"Загружено: {file.filename}", ["refreshBrowser"])
    except fileops.FileOpError as e:
        return _resp(request, False, str(e), [])
    finally:
        await file.close()

@app.get("/download")
async def download(request: Request, _: str = Depends(current_user), path: str = ""):
    try:
        f = fileops.resolve_file_for_download(path)
    except fileops.FileOpError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return FileResponse(str(f), filename=f.name, media_type="application/octet-stream")

@app.get("/stream")
async def stream(request: Request, _: str = Depends(current_user), path: str = ""):
    # Inline-отдача для проигрывания в <video>/<audio> прямо в браузере: без
    # attachment-заголовка, с реальным MIME. Range (перемотку) FileResponse тянет сам.
    try:
        f = fileops.resolve_file_for_download(path)
    except fileops.FileOpError as e:
        raise HTTPException(status_code=404, detail=str(e))
    mime, _enc = mimetypes.guess_type(f.name)
    return FileResponse(str(f), media_type=mime or "application/octet-stream")

_TEXT_SUB_CODECS = {"subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text"}

@app.get("/media-info")
async def media_info(request: Request, _: str = Depends(current_user), path: str = ""):
    try:
        f = fileops.resolve_file_for_download(path)
    except fileops.FileOpError as e:
        raise HTTPException(status_code=404, detail=str(e))
    r = await asyncio.to_thread(shell.run, [
        "ffprobe", "-v", "error", "-show_entries",
        "format=duration:stream=index,codec_type,codec_name:stream_tags=language,title",
        "-of", "json", str(f)])
    dur, audio, subs = 0.0, [], []
    try:
        data = json.loads(r.stdout or "{}")
        dur = float(data.get("format", {}).get("duration") or 0)
        na = ns = 0
        for s in data.get("streams", []):
            tags = s.get("tags") or {}
            label = tags.get("title") or tags.get("language") or ""
            if s.get("codec_type") == "audio":
                audio.append({"i": na, "label": label or f"Дорожка {na + 1}",
                              "codec": s.get("codec_name", "")})
                na += 1
            elif s.get("codec_type") == "subtitle":
                # браузер умеет только текстовые субтитры (не PGS/VobSub)
                if s.get("codec_name") in _TEXT_SUB_CODECS:
                    subs.append({"i": ns, "label": label or f"Субтитры {ns + 1}"})
                ns += 1
    except (ValueError, KeyError):
        pass
    return {"duration": dur, "audio": audio, "subs": subs}

def _ffmpeg_stream(args: list[str], media_type: str):
    async def gen():
        proc = await asyncio.create_subprocess_exec(
            *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        try:
            while True:
                chunk = await proc.stdout.read(65536)
                if not chunk:
                    break
                yield chunk
        finally:
            if proc.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    proc.kill()
                await proc.wait()
    return StreamingResponse(gen(), media_type=media_type)

@app.get("/transcode")
async def transcode(request: Request, _: str = Depends(current_user),
                    path: str = "", ss: float = 0.0, audio: int = 0):
    # Живое перекодирование для звука в браузере: видео копируется как есть
    # (нагрузки почти нет, если это H.264), выбранная аудиодорожка на лету
    # пережимается в AAC. ss — старт с указанной секунды (перемотка перезапуском).
    try:
        f = fileops.resolve_file_for_download(path)
    except fileops.FileOpError as e:
        raise HTTPException(status_code=404, detail=str(e))
    audio = max(0, audio)
    args = ["ffmpeg", "-hide_banner", "-loglevel", "error"]
    if ss and ss > 0:
        args += ["-ss", str(ss)]
    args += ["-i", str(f),
             "-map", "0:v:0?", "-map", f"0:a:{audio}?",
             "-c:v", "copy", "-c:a", "aac", "-ac", "2", "-b:a", "160k",
             # держим звук на исходных таймстампах: дыры/наложения в аудио
             # вебрипов иначе накапливаются в рассинхрон с картинкой
             "-af", "aresample=async=1",
             "-avoid_negative_ts", "make_zero",
             "-movflags", "frag_keyframe+empty_moov+default_base_moof",
             "-f", "mp4", "pipe:1"]
    return _ffmpeg_stream(args, "video/mp4")

# Извлечение субтитров требует прочитать весь контейнер (на большом файле —
# минуты), поэтому дорожка извлекается ОДИН раз в фон и кэшируется; дальше
# отдаётся мгновенно, тайминги сдвигаются под перемотку уже по кэшу.
SUB_CACHE = DATA_DIR / "subcache"
_sub_jobs: dict[str, asyncio.Task] = {}

def _sub_key(f: Path, idx: int) -> str:
    st = f.stat()
    raw = f"{f}|{st.st_size}|{st.st_mtime_ns}|{idx}"
    return hashlib.sha1(raw.encode()).hexdigest()

def _extract_subs(f: Path, idx: int, dest: Path) -> None:
    SUB_CACHE.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".tmp")
    r = shell.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                   "-i", str(f), "-map", f"0:s:{idx}?", "-f", "webvtt", str(tmp)],
                  timeout=1800)
    if r.ok and tmp.exists() and tmp.stat().st_size > 0:
        tmp.replace(dest)
    else:
        tmp.unlink(missing_ok=True)

_TS = re.compile(r"(\d+):(\d{2}):(\d{2})\.(\d{3})|(\d{2}):(\d{2})\.(\d{3})")

def _shift_vtt(text: str, ss: float) -> str:
    if ss <= 0:
        return text
    def fmt(t: float) -> str:
        t = max(0.0, t)
        h, rem = divmod(t, 3600)
        m, s = divmod(rem, 60)
        return f"{int(h):02d}:{int(m):02d}:{s:06.3f}"
    out = ["WEBVTT", ""]
    for block in text.split("\n\n"):
        if "-->" not in block:
            continue
        lines = block.split("\n")
        for i, ln in enumerate(lines):
            if "-->" in ln:
                times = _TS.findall(ln)
                if len(times) < 2:
                    break
                def secs(g):
                    if g[0] != "" or g[1] != "" or g[2] != "":
                        return int(g[0]) * 3600 + int(g[1]) * 60 + int(g[2]) + int(g[3]) / 1000
                    return int(g[4]) * 60 + int(g[5]) + int(g[6]) / 1000
                start, end = secs(times[0]) - ss, secs(times[1]) - ss
                if end <= 0:
                    break
                lines[i] = f"{fmt(start)} --> {fmt(end)}"
                out.append("\n".join(lines[i:]))
                out.append("")
                break
    return "\n".join(out)

@app.get("/subs-prepare")
async def subs_prepare(request: Request, _: str = Depends(current_user),
                       path: str = "", idx: int = 0):
    try:
        f = fileops.resolve_file_for_download(path)
    except fileops.FileOpError as e:
        raise HTTPException(status_code=404, detail=str(e))
    idx = max(0, idx)
    key = _sub_key(f, idx)
    dest = SUB_CACHE / f"{key}.vtt"
    if dest.exists():
        return {"ready": True}
    job = _sub_jobs.get(key)
    if job is None or job.done():
        _sub_jobs[key] = asyncio.create_task(asyncio.to_thread(_extract_subs, f, idx, dest))
    return {"ready": False}

@app.get("/subs")
async def subs(request: Request, _: str = Depends(current_user),
               path: str = "", idx: int = 0, ss: float = 0.0):
    try:
        f = fileops.resolve_file_for_download(path)
    except fileops.FileOpError as e:
        raise HTTPException(status_code=404, detail=str(e))
    dest = SUB_CACHE / f"{_sub_key(f, max(0, idx))}.vtt"
    if not dest.exists():
        raise HTTPException(status_code=404, detail="субтитры ещё готовятся")
    text = await asyncio.to_thread(dest.read_text, "utf-8", "replace")
    return PlainTextResponse(_shift_vtt(text, ss), media_type="text/vtt")


# ---------- shares ----------

@app.get("/htmx/share-form", response_class=HTMLResponse)
async def htmx_share_form(request: Request, _: str = Depends(current_user),
                          path: str = "", suggested_name: str = ""):
    users = samba.list_smb_users()
    return templates.TemplateResponse("_share_form.html", {
        "request": request, "abs_path": path, "suggested_name": suggested_name,
        "smb_users": users, "editing": False, "mode": "guest", "guest_write": False,
        "perms": {u: "none" for u in users},
    })

@app.get("/htmx/share-edit", response_class=HTMLResponse)
async def htmx_share_edit(request: Request, _: str = Depends(current_user), name: str = ""):
    share = samba.get_share(name)
    if not share:
        return _resp(request, False, "Шара не найдена", [])
    users = samba.list_smb_users()
    mode = "guest" if share["guest_ok"] else "users"
    return templates.TemplateResponse("_share_form.html", {
        "request": request, "abs_path": share["path"], "suggested_name": share["name"],
        "smb_users": users, "editing": True, "mode": mode,
        "guest_write": (mode == "guest" and not share["read_only"]),
        "perms": samba.share_user_perms(share, users),
    })

@app.post("/htmx/share-create", response_class=HTMLResponse)
async def htmx_share_create(request: Request, _: str = Depends(current_user),
                            name: str = Form(...), abs_path: str = Form(...),
                            mode: str = Form("guest"), guest_write: str = Form("no"),
                            access_users: list[str] = Form(default=[]),
                            write_users: list[str] = Form(default=[]),
                            old_name: str = Form("")):
    ok, msg = samba.create_share(name=name, abs_path=abs_path, mode=mode,
                                 guest_write=(guest_write == "yes"),
                                 access_users=access_users, write_users=write_users,
                                 old_name=old_name.strip() or None)
    return _resp(request, ok, msg or f"Шара «{name}» сохранена",
                 ["refreshSidebar", "closeModal"] if ok else [])

@app.post("/htmx/share-delete", response_class=HTMLResponse)
async def htmx_share_delete(request: Request, _: str = Depends(current_user), name: str = Form(...)):
    ok, msg = samba.delete_share(name)
    return _resp(request, ok, msg or f"Шара «{name}» удалена",
                 ["refreshSidebar", "closeModal"] if ok else [])


# ---------- samba users ----------

@app.get("/htmx/users", response_class=HTMLResponse)
async def htmx_users(request: Request, _: str = Depends(current_user)):
    return templates.TemplateResponse("_users.html", {"request": request, "users": samba.list_smb_users()})

@app.post("/htmx/user-add", response_class=HTMLResponse)
async def htmx_user_add(request: Request, _: str = Depends(current_user),
                        username: str = Form(...), password: str = Form(...)):
    ok, msg = samba.add_smb_user(username, password)
    return _resp(request, ok, msg or f"Пользователь «{username}» добавлен", ["reloadUsers"] if ok else [])

@app.post("/htmx/user-passwd", response_class=HTMLResponse)
async def htmx_user_passwd(request: Request, _: str = Depends(current_user),
                           username: str = Form(...), password: str = Form(...)):
    ok, msg = samba.set_smb_password(username, password)
    return _resp(request, ok, msg or "Пароль сменён", [])

@app.post("/htmx/user-delete", response_class=HTMLResponse)
async def htmx_user_delete(request: Request, _: str = Depends(current_user), username: str = Form(...)):
    ok, msg = samba.delete_smb_user(username)
    return _resp(request, ok, msg or f"Пользователь «{username}» удалён", ["reloadUsers"] if ok else [])


# ---------- admin password ----------

@app.post("/htmx/admin-passwd", response_class=HTMLResponse)
async def htmx_admin_passwd(request: Request, _: str = Depends(current_user), password: str = Form(...)):
    if len(password) < 8:
        return _resp(request, False, "Минимум 8 символов", [])
    auth.set_password(password)
    return _resp(request, True, "Пароль админки обновлён", ["closeModal"])


@app.get("/htmx/settings", response_class=HTMLResponse)
async def htmx_settings(request: Request, _: str = Depends(current_user)):
    return templates.TemplateResponse("_settings.html", {
        "request": request, "username": auth.get_username(),
        "port": portcfg.current_port(), "srv": _server_info(), "version": APP_VERSION,
        "show_system_disks": db.get_setting("ui_show_system_disks") == "yes",
    })

@app.post("/htmx/ui-pref", response_class=HTMLResponse)
async def htmx_ui_pref(request: Request, _: str = Depends(current_user),
                       show_system_disks: str = Form("no")):
    db.set_setting("ui_show_system_disks", "yes" if show_system_disks == "yes" else "no")
    return _resp(request, True, "Настройка сохранена", ["refreshSidebar"])

@app.post("/htmx/admin-account", response_class=HTMLResponse)
async def htmx_admin_account(request: Request, _: str = Depends(current_user),
                            username: str = Form(...), password: str = Form("")):
    ok, msg = auth.set_username(username)
    if not ok:
        return _resp(request, False, msg, [])
    if password.strip():
        if len(password) < 8:
            return _resp(request, False, "Пароль: минимум 8 символов", [])
        auth.set_password(password)
    request.session["user"] = auth.get_username()  # keep session valid after rename
    return _resp(request, True, "Учётная запись обновлена", ["closeModal"])

@app.post("/htmx/set-port", response_class=HTMLResponse)
async def htmx_set_port(request: Request, _: str = Depends(current_user), port: int = Form(...)):
    ok, msg = portcfg.set_port(port)
    return _resp(request, ok, msg, ["closeModal"] if ok else [])


@app.get("/htmx/dlna", response_class=HTMLResponse)
async def htmx_dlna(request: Request, _: str = Depends(current_user)):
    return templates.TemplateResponse("_dlna.html", {
        "request": request, "st": dlna.status(), "mount_root": str(MOUNT_ROOT),
    })

@app.post("/htmx/dlna-toggle", response_class=HTMLResponse)
async def htmx_dlna_toggle(request: Request, _: str = Depends(current_user), enable: str = Form("no")):
    ok, msg = dlna.enable() if enable == "yes" else dlna.disable()
    return _resp(request, ok, msg, ["refreshSidebar"] if ok else [])

@app.post("/htmx/dlna-rescan", response_class=HTMLResponse)
async def htmx_dlna_rescan(request: Request, _: str = Depends(current_user)):
    ok, msg = dlna.rescan()
    return _resp(request, ok, msg, ["refreshSidebar"])


# ---------- torrents ----------

@app.get("/htmx/torrents-page", response_class=HTMLResponse)
async def htmx_torrents_page(request: Request, _: str = Depends(current_user)):
    dirs = [{"abs": str(MOUNT_ROOT / r), "label": r} for r in fileops.list_dirs_under_mounts()]
    return templates.TemplateResponse("_torrents_page.html", {
        "request": request, "st": torrent.status(), "dirs": dirs,
    })

@app.get("/htmx/torrent-dest", response_class=HTMLResponse)
async def htmx_torrent_dest(request: Request, _: str = Depends(current_user)):
    items = []
    for r in fileops.list_dirs_under_mounts():
        items.append({"abs": str(MOUNT_ROOT / r), "rel": r,
                      "depth": r.count("/"), "name": r.split("/")[-1]})
    return templates.TemplateResponse("_torrent_dest.html", {"request": request, "items": items})

@app.get("/htmx/torrents-list", response_class=HTMLResponse)
async def htmx_torrents_list(request: Request, _: str = Depends(current_user),
                             sort: str = "name", dir: str = "asc"):
    torrents = await asyncio.to_thread(torrent.list_torrents)
    key = torrent.SORT_KEYS.get(sort, torrent.SORT_KEYS["name"])
    torrents.sort(key=key, reverse=(dir == "desc"))
    return templates.TemplateResponse("_torrents_list.html", {"request": request, "torrents": torrents})

@app.get("/htmx/torrent-files", response_class=HTMLResponse)
async def htmx_torrent_files(request: Request, _: str = Depends(current_user), id: int = 0):
    if not id:
        return HTMLResponse("")
    det = await asyncio.to_thread(torrent.get_details, id)
    if not det:
        return HTMLResponse("")
    return templates.TemplateResponse("_torrent_files.html", {"request": request, "t": det})

@app.post("/htmx/torrent-seq", response_class=HTMLResponse)
async def htmx_torrent_seq(request: Request, _: str = Depends(current_user),
                           id: int = Form(...), on: str = Form("no")):
    ok, msg = await asyncio.to_thread(torrent.set_sequential, id, on == "yes")
    return _resp(request, ok, msg, [])

@app.post("/htmx/torrent-file-wanted", response_class=HTMLResponse)
async def htmx_torrent_file_wanted(request: Request, _: str = Depends(current_user),
                                   id: int = Form(...), idx: int = Form(...), wanted: str = Form("yes")):
    ok, msg = await asyncio.to_thread(torrent.set_file_wanted, id, idx, wanted == "yes")
    return _resp(request, ok, msg, [])

@app.post("/htmx/torrent-file-prio", response_class=HTMLResponse)
async def htmx_torrent_file_prio(request: Request, _: str = Depends(current_user),
                                 id: int = Form(...), idx: int = Form(...), prio: str = Form("normal")):
    ok, msg = await asyncio.to_thread(torrent.set_file_priority, id, idx, prio)
    return _resp(request, ok, msg, [])

@app.get("/htmx/torrent-limits", response_class=HTMLResponse)
async def htmx_torrent_limits(request: Request, _: str = Depends(current_user)):
    lim = await asyncio.to_thread(torrent.get_limits)
    return templates.TemplateResponse("_torrent_limits.html", {"request": request, "lim": lim})

@app.post("/htmx/torrent-limits", response_class=HTMLResponse)
async def htmx_torrent_limits_save(request: Request, _: str = Depends(current_user),
                                   down: int = Form(0), down_on: str = Form("no"),
                                   up: int = Form(0), up_on: str = Form("no"),
                                   alt_down: int = Form(0), alt_up: int = Form(0),
                                   ratio: float = Form(2.0), ratio_on: str = Form("no")):
    ok, msg = await asyncio.to_thread(
        torrent.set_limits, down, down_on == "yes", up, up_on == "yes",
        alt_down, alt_up, ratio, ratio_on == "yes")
    return _resp(request, ok, msg, ["closeModal"] if ok else [])

@app.post("/htmx/torrent-alt-speed", response_class=HTMLResponse)
async def htmx_torrent_alt_speed(request: Request, _: str = Depends(current_user)):
    ok, msg = await asyncio.to_thread(torrent.toggle_alt_speed)
    return _resp(request, ok, msg, [])

@app.post("/htmx/torrent-toggle", response_class=HTMLResponse)
async def htmx_torrent_toggle(request: Request, _: str = Depends(current_user), enable: str = Form("no")):
    ok, msg = torrent.enable() if enable == "yes" else torrent.disable()
    return _resp(request, ok, msg, ["refreshSidebar", "reloadTorrents"] if ok else [])

@app.post("/htmx/torrent-add", response_class=HTMLResponse)
async def htmx_torrent_add(request: Request, _: str = Depends(current_user),
                           spec: str = Form(...), download_dir: str = Form(...)):
    ok, msg = await asyncio.to_thread(torrent.add_magnet, spec, download_dir)
    return _resp(request, ok, msg, [])

@app.post("/htmx/torrent-upload", response_class=HTMLResponse)
async def htmx_torrent_upload(request: Request, _: str = Depends(current_user),
                             download_dir: str = Form(...), file: UploadFile = File(...)):
    try:
        content = await file.read(10 * 1024 * 1024 + 1)  # .torrent больше 10 МБ не бывает
    finally:
        await file.close()
    if len(content) > 10 * 1024 * 1024:
        return _resp(request, False, "Файл слишком большой для .torrent", [])
    ok, msg = await asyncio.to_thread(torrent.add_file, content, download_dir)
    return _resp(request, ok, msg, [])

@app.post("/htmx/torrent-action", response_class=HTMLResponse)
async def htmx_torrent_action(request: Request, _: str = Depends(current_user),
                              id: int = Form(...), action: str = Form(...)):
    if action == "start":
        ok, msg = torrent.start(id)
    elif action == "stop":
        ok, msg = torrent.stop(id)
    elif action == "remove":
        ok, msg = torrent.remove(id, delete_data=False)
    elif action == "remove-data":
        ok, msg = torrent.remove(id, delete_data=True)
    else:
        ok, msg = False, "неизвестное действие"
    return _resp(request, ok, msg, [])


@app.get("/healthz", response_class=PlainTextResponse)
async def health():
    return "ok"


# ---------- helpers ----------

def _server_info() -> dict:
    try:
        host = socket.gethostname()
    except Exception:
        host = "?"
    ip = "?"
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1)); ip = s.getsockname()[0]; s.close()
    except Exception:
        pass
    up = ""
    try:
        with open("/proc/uptime") as f:
            secs = float(f.read().split()[0])
        d, h, m = int(secs // 86400), int(secs % 86400 // 3600), int(secs % 3600 // 60)
        up = (f"{d}д " if d else "") + f"{h}ч {m}м"
    except Exception:
        pass
    return {"host": host, "ip": ip, "uptime": up}

def _toast(request: Request, ok: bool, msg: str) -> HTMLResponse:
    return templates.TemplateResponse("_toast.html", {"request": request, "ok": ok, "msg": msg})

def _resp(request: Request, ok: bool, msg: str, events: list[str]) -> HTMLResponse:
    resp = _toast(request, ok, msg)
    if events:
        resp.headers["HX-Trigger"] = json.dumps({e: True for e in events})
    return resp
