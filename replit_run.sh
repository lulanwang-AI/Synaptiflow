#!/usr/bin/env bash
# Replit run: serve the API + built SPA from one Uvicorn on $PORT.
# Self-healing so the green "Run" button works even without a separate build
# step: it builds the frontend / installs the backend on first run if needed.
set -euo pipefail
cd "$(dirname "$0")"

export BOLTZ_MOCK="${BOLTZ_MOCK:-1}"   # default: no key, spends nothing
export NIM_MOCK="${NIM_MOCK:-1}"
export GENERATOR_ENGINE="${GENERATOR_ENGINE:-boltz}"
export PYTHONUNBUFFERED=1
PORT="${PORT:-8000}"

# Backend venv (created by replit_build.sh on deploy; built here on first Run).
if [ ! -x ".venv/bin/uvicorn" ]; then
  echo "==> First run: installing backend"
  python3 -m venv .venv
  ./.venv/bin/pip install --upgrade pip
  ./.venv/bin/pip install ./backend
fi

# Built SPA (served single-origin by FastAPI). Build if missing.
if [ ! -f "frontend/dist/index.html" ]; then
  echo "==> First run: building frontend"
  ( cd frontend && { [ -f package-lock.json ] && npm ci || npm install; } && VITE_API_BASE="" npm run build )
fi

echo "==> Serving SynaptiFlow on 0.0.0.0:${PORT} (BOLTZ_MOCK=${BOLTZ_MOCK}, NIM_MOCK=${NIM_MOCK})"
exec ./.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port "${PORT}" --app-dir backend
