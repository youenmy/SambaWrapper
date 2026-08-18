#!/usr/bin/env bash
# Пересобрать static/tailwind.css после появления новых классов в разметке.
#
# Приложение не тянет стили с внешних CDN: они собираются в статический файл
# из шаблонов, из строк в music.js и из фрагментов HTML, которые формируются
# в Python. Нужен standalone-бинарь Tailwind:
#   curl -sLO https://github.com/tailwindlabs/tailwindcss/releases/download/v3.4.17/tailwindcss-linux-x64
#   chmod +x tailwindcss-linux-x64
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TW="${TAILWIND_BIN:-./tailwindcss-linux-x64}"

cat > /tmp/tw.config.js <<CFG
module.exports = {
  darkMode: "class",
  content: [
    "${ROOT}/templates/**/*.html",
    "${ROOT}/static/*.js",
    "${ROOT}/app/*.py",
  ],
  theme: { extend: {} },
};
CFG
printf '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n' > /tmp/tw.input.css
"$TW" -c /tmp/tw.config.js -i /tmp/tw.input.css -o "${ROOT}/static/tailwind.css" --minify
echo "готово: ${ROOT}/static/tailwind.css"
