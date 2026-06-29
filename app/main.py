"""FastAPI app: routes + HTMX endpoints (two-pane File Station UI)."""
import asyncio
import contextlib
import json
import logging
import socket
from pathlib import Path

APP_VERSION = "1.1"
from fastapi import FastAPI, Request, Form, Depends, HTTPException, UploadFile, File
from fastapi.responses import HTMLResponse, RedirectResponse, PlainTextResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.sessions import SessionMiddleware
from . import auth, disks, browse, samba, fileops, portcfg, dlna
from .config import MOUNT_ROOT

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
        "dlna": dlna.status(), "mount_root": root,
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
                            write_users: list[str] = Form(default=[])):
    ok, msg = samba.create_share(name=name, abs_path=abs_path, mode=mode,
                                 guest_write=(guest_write == "yes"),
                                 access_users=access_users, write_users=write_users)
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
    })

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
