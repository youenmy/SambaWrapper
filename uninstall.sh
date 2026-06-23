#!/usr/bin/env bash
# Снос sambawrapper. По умолчанию НЕ трогает данные на дисках и user-конфиги Samba.
# С --purge удаляет /var/lib/sambawrapper и все шары sambawrapper-*.conf.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
    echo "Запусти под root: sudo bash uninstall.sh [--purge]" >&2
    exit 1
fi

PURGE=0
[[ "${1:-}" == "--purge" ]] && PURGE=1

echo "==> Останавливаю сервис"
systemctl disable --now sambawrapper.service 2>/dev/null || true
rm -f /etc/systemd/system/sambawrapper.service
systemctl daemon-reload

echo "==> Останавливаю DLNA (minidlna)"
systemctl disable --now minidlna 2>/dev/null || true

echo "==> Снимаю sudoers"
rm -f /etc/sudoers.d/sambawrapper

echo "==> Удаляю код"
rm -rf /opt/sambawrapper

if [[ $PURGE -eq 1 ]]; then
    echo "==> Чищу шары и данные"
    rm -f /etc/samba/smb.conf.d/sambawrapper-*.conf
    # remove the include line from smb.conf (both layouts: inside [global] and standalone)
    if grep -q "sambawrapper-all.conf" /etc/samba/smb.conf; then
        sed -i \
            -e '/# sambawrapper-managed include/d' \
            -e '/# sambawrapper-managed$/,/^[[:space:]]*include = .*sambawrapper-all\.conf/d' \
            -e '/^[[:space:]]*include = .*sambawrapper-all\.conf/d' \
            /etc/samba/smb.conf
        systemctl reload-or-restart smbd || true
    fi
    rm -rf /var/lib/sambawrapper
    # try to unmount and remove mount root
    if mountpoint -q /mnt/sambawrapper 2>/dev/null; then
        umount /mnt/sambawrapper || true
    fi
    for mp in /mnt/sambawrapper/*; do
        [[ -d "$mp" ]] || continue
        mountpoint -q "$mp" && umount "$mp" || true
        rmdir "$mp" 2>/dev/null || true
    done
    rmdir /mnt/sambawrapper 2>/dev/null || true
fi

# Don't remove the sambawrapper system user automatically — it might own files we shouldn't touch.
echo "Готово."
[[ $PURGE -eq 0 ]] && echo "Данные и шары сохранены. Удалить полностью — sudo bash uninstall.sh --purge"
