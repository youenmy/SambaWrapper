#!/usr/bin/env bash
# SambaWrapper installer for Debian/Ubuntu.
#
#   Local:   sudo bash install.sh
#   Remote:  curl -fsSL https://raw.githubusercontent.com/USER/SambaWrapper/main/install.sh | sudo bash
#
# Interactive by default (asks port / DLNA / admin password via /dev/tty).
# Non-interactive presets via env vars:
#   SW_PORT=9000 SW_DLNA=y SW_ADMIN_PASS=secret sudo -E bash install.sh
#   SW_REPO=https://github.com/you/SambaWrapper.git   (override source repo)
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
    echo "Запусти под root: sudo bash install.sh" >&2
    exit 1
fi

REPO_URL="${SW_REPO:-https://github.com/CHANGEME/SambaWrapper.git}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || echo /nonexistent)"
INSTALL_DIR="/opt/sambawrapper"
DATA_DIR="/var/lib/sambawrapper"
MOUNT_ROOT="/mnt/sambawrapper"
SAMBA_CONF_DIR="/etc/samba/smb.conf.d"
SERVICE_USER="sambawrapper"

export DEBIAN_FRONTEND=noninteractive

# --- self-bootstrap: if piped via curl (no source tree), clone the repo ---
if [[ ! -d "${SRC_DIR}/app" ]]; then
    echo "==> Скачиваю исходники SambaWrapper из ${REPO_URL}"
    apt-get update -qq && apt-get install -y -qq git
    TMP_SRC="$(mktemp -d)"
    git clone --depth 1 "${REPO_URL}" "${TMP_SRC}/src"
    SRC_DIR="${TMP_SRC}/src"
fi

# --- interactive configuration (skipped if env preset or no tty) ---
ask() {  # ask VAR "prompt" "default"
    local var="$1" prompt="$2" def="$3" ans=""
    if [[ -n "${!var:-}" ]]; then return; fi
    if [[ -e /dev/tty ]]; then
        read -r -p "  ${prompt} [${def}]: " ans </dev/tty || ans=""
    fi
    printf -v "$var" '%s' "${ans:-$def}"
}

echo ""
echo "  ┌──────────────────────────────────────┐"
echo "  │   SambaWrapper — установка            │"
echo "  └──────────────────────────────────────┘"
ask SW_PORT "Порт веб-интерфейса"                          "8080"
ask SW_DLNA "Поставить DLNA-медиасервер (включишь в UI)?"  "y"
if [[ -z "${SW_ADMIN_PASS:-}" && -e /dev/tty ]]; then
    read -r -s -p "  Пароль админа (Enter — сгенерировать): " SW_ADMIN_PASS </dev/tty || SW_ADMIN_PASS=""
    echo ""
fi
echo ""

echo "==> Устанавливаю системные пакеты"
apt-get update -qq
PKGS="samba samba-common-bin ntfs-3g exfatprogs python3 python3-venv python3-pip sudo rsync"
[[ "${SW_DLNA,,}" == y* ]] && PKGS="$PKGS minidlna"
apt-get install -y --no-install-recommends $PKGS

echo "==> Создаю сервисного пользователя"
id -u "${SERVICE_USER}" >/dev/null 2>&1 || \
    useradd --system --no-create-home --shell /usr/sbin/nologin "${SERVICE_USER}"

echo "==> Раскладываю файлы в ${INSTALL_DIR}"
mkdir -p "${INSTALL_DIR}"
rsync -a --delete --exclude '__pycache__' --exclude '.git' --exclude 'venv' \
    "${SRC_DIR}/" "${INSTALL_DIR}/"
chown -R root:root "${INSTALL_DIR}"

echo "==> Готовлю virtualenv"
python3 -m venv "${INSTALL_DIR}/venv"
"${INSTALL_DIR}/venv/bin/pip" install --quiet --upgrade pip
"${INSTALL_DIR}/venv/bin/pip" install --quiet -r "${INSTALL_DIR}/requirements.txt"

echo "==> Создаю каталоги данных и монтирования"
mkdir -p "${DATA_DIR}" "${MOUNT_ROOT}" "${SAMBA_CONF_DIR}"
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${DATA_DIR}"
chmod 750 "${DATA_DIR}"; chmod 755 "${MOUNT_ROOT}"

echo "==> Порт ${SW_PORT}"
printf 'SW_HOST=0.0.0.0\nSW_PORT=%s\n' "${SW_PORT}" > "${DATA_DIR}/service.env"
chown "${SERVICE_USER}:${SERVICE_USER}" "${DATA_DIR}/service.env"

echo "==> Включаю include в /etc/samba/smb.conf"
SMB_CONF=/etc/samba/smb.conf
INCLUDE_LINE="include = ${SAMBA_CONF_DIR}/sambawrapper-all.conf"
if ! grep -qF "${INCLUDE_LINE}" "${SMB_CONF}" 2>/dev/null; then
    if grep -qE '^\s*\[global\]' "${SMB_CONF}" 2>/dev/null; then
        sed -i "0,/^\s*\[global\]/{s|^\s*\[global\].*|&\n   # sambawrapper-managed include\n   ${INCLUDE_LINE}|}" "${SMB_CONF}"
    else
        printf '\n# sambawrapper-managed\n[global]\n   %s\n' "${INCLUDE_LINE}" >> "${SMB_CONF}"
    fi
fi
touch "${SAMBA_CONF_DIR}/sambawrapper-all.conf"

echo "==> Ставлю sudoers-правила"
install -m 0440 "${INSTALL_DIR}/samba/sambawrapper-sudoers" /etc/sudoers.d/sambawrapper
visudo -cf /etc/sudoers.d/sambawrapper >/dev/null

echo "==> Регистрирую systemd unit"
install -m 0644 "${INSTALL_DIR}/systemd/sambawrapper.service" /etc/systemd/system/sambawrapper.service
systemctl daemon-reload
systemctl enable --now sambawrapper.service
systemctl reload-or-restart smbd 2>/dev/null || systemctl restart smbd 2>/dev/null || true

# --- admin password preset ---
if [[ -n "${SW_ADMIN_PASS:-}" ]]; then
    sudo -u "${SERVICE_USER}" env SW_ADMIN_PASS="${SW_ADMIN_PASS}" \
        "${INSTALL_DIR}/venv/bin/python" -c \
        "import os,sys;sys.path.insert(0,'${INSTALL_DIR}');from app import db,auth;db.init();auth.set_password(os.environ['SW_ADMIN_PASS'])"
    echo "==> Пароль админа установлен из ввода"
fi

# --- DLNA (installed but OFF by default; enable from the web UI) ---
if [[ "${SW_DLNA,,}" == y* ]]; then
    echo "==> Готовлю DLNA (minidlna) — выключен по умолчанию, включишь в интерфейсе"
    cat > /etc/minidlna.conf <<EOF
media_dir=${MOUNT_ROOT}
friendly_name=SambaWrapper
db_dir=/var/cache/minidlna
log_dir=/var/cache/minidlna
inotify=yes
notify_interval=895
root_container=B
EOF
    systemctl disable --now minidlna 2>/dev/null || true
fi

# wait for the initial password file (only created when no password was preset)
for _ in $(seq 1 10); do [[ -f "${DATA_DIR}/initial-password.txt" ]] && break; sleep 0.5; done

IP_HINT="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo ""
echo "==============================================="
echo " SambaWrapper установлен и запущен."
echo " Веб-морда:  http://${IP_HINT:-<ip-сервера>}:${SW_PORT}"
if [[ -f "${DATA_DIR}/initial-password.txt" ]]; then
    echo ""; cat "${DATA_DIR}/initial-password.txt"
elif [[ -n "${SW_ADMIN_PASS:-}" ]]; then
    echo " Логин: admin, пароль — заданный при установке."
fi
echo "==============================================="
