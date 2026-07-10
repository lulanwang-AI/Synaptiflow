#!/usr/bin/env bash
# Replit deployment build: build the SPA, then install the backend.
# Runs once before `replit_run.sh` on deploy.
set -euo pipefail
cd "$(dirname "$0")"

echo "==> [1/2] Building frontend (same-origin API calls)"
pushd frontend >/dev/null
if [ -f package-lock.json ]; then npm ci; else npm install; fi
# Empty VITE_API_BASE => the client uses relative URLs, i.e. the same origin
# this server is reached on. No hard-coded localhost:8000.
VITE_API_BASE="" npm run build
popd >/dev/null

echo "==> [2/2] Installing backend into a venv"
python3 -m venv .venv
./.venv/bin/pip install --upgrade pip
./.venv/bin/pip install ./backend

echo "==> Build complete."
