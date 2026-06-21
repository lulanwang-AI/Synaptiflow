#!/usr/bin/env bash
# Starts backend + frontend, waits for readiness, runs the Playwright scripts,
# then tears everything down. Runs as ONE invocation so servers and the browser
# share the network namespace. Pass script names as args (default: snap + interact).
set -u
cd /home/user/Synaptiflow

pkill -f uvicorn 2>/dev/null || true
pkill -f vite 2>/dev/null || true
sleep 1

BOLTZ_MOCK=1 .venv/bin/uvicorn --app-dir backend app.main:app --port 8000 > /tmp/be.log 2>&1 &
BE=$!
( cd frontend && npm run dev -- --port 5173 > /tmp/fe.log 2>&1 ) &
FE=$!

ready=0
for i in $(seq 1 40); do
  if curl -s localhost:8000/health >/dev/null 2>&1 && curl -s localhost:5173/ >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 1
done
echo "ready=$ready backend=$(curl -s localhost:8000/health) fe=$(curl -s -o /dev/null -w '%{http_code}' localhost:5173/)"

# fresh seed state for a deterministic run
curl -s -X POST localhost:8000/reset >/dev/null

RC=0
for script in "${@:-snap interact}"; do
  for s in $script; do
    echo "--- running e2e/$s.js ---"
    node "e2e/$s.js" || RC=1
  done
done

kill $BE $FE 2>/dev/null || true
pkill -f uvicorn 2>/dev/null || true
pkill -f vite 2>/dev/null || true
echo "DEMO_DONE rc=$RC"
