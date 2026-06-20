# Closed-Loop Discovery MVP — one-command run.
#
# Mock mode (no key, spends nothing):   BOLTZ_MOCK=1 make up
# Live mode (needs key, within cap):    BOLTZ_API_KEY=sk-... BOLTZ_MAX_SPEND_USD=25 make up
#
# Env vars (read by the backend / boltz_client):
#   BOLTZ_MOCK            1 = canned outputs, no network, no spend (default for demo)
#   BOLTZ_API_KEY         required only for live Boltz calls
#   BOLTZ_MAX_SPEND_USD   hard cap on cumulative live spend (default 50)

BACKEND_DIR := backend
FRONTEND_DIR := frontend
VENV := .venv
PY := $(VENV)/bin/python
PIP := $(VENV)/bin/pip
BOLTZ_MOCK ?= 1
export BOLTZ_MOCK

.PHONY: help venv install backend frontend up openapi test smoke reset clean

help:
	@echo "make install   - set up python venv + frontend deps"
	@echo "make up         - run backend (:8000) + frontend (:5173) together"
	@echo "make backend    - run backend only (uvicorn :8000)"
	@echo "make frontend   - run frontend only (vite :5173)"
	@echo "make test       - backend pytest (BOLTZ_MOCK=1)"
	@echo "make smoke      - end-to-end loop smoke test (no key, no spend)"
	@echo "make openapi    - regenerate docs/openapi.json"
	@echo "BOLTZ_MOCK=1 make up   # default: no key, spends nothing"

$(VENV):
	python3 -m venv $(VENV)
	$(PIP) install --upgrade pip

venv: $(VENV)

install: venv
	$(PIP) install -e "$(BACKEND_DIR)[dev]"
	cd $(FRONTEND_DIR) && npm install

backend: venv
	cd $(BACKEND_DIR) && ../$(PY) -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

frontend:
	cd $(FRONTEND_DIR) && npm run dev -- --host

up:
	@echo "Starting backend (:8000) and frontend (:5173). BOLTZ_MOCK=$(BOLTZ_MOCK)"
	@trap 'kill 0' EXIT; \
	( cd $(BACKEND_DIR) && ../$(PY) -m uvicorn app.main:app --host 0.0.0.0 --port 8000 ) & \
	( cd $(FRONTEND_DIR) && npm run dev -- --host ) & \
	wait

openapi: venv
	cd $(BACKEND_DIR) && ../$(PY) export_openapi.py

test: venv
	cd $(BACKEND_DIR) && BOLTZ_MOCK=1 ../$(PY) -m pytest

smoke: venv
	cd $(BACKEND_DIR) && BOLTZ_MOCK=1 ../$(PY) smoke_loop.py

clean:
	rm -rf $(BACKEND_DIR)/*.db $(BACKEND_DIR)/.pytest_cache
	find $(BACKEND_DIR) -name __pycache__ -type d -prune -exec rm -rf {} +
