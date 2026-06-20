# Frontend — Closed-Loop Discovery MVP

React + Vite + TypeScript single-page app over the backend API (`docs/openapi.json`).
Renders the two-loop DMTA flow and makes the semantic-completeness bottleneck
visible end-to-end for three personas (scientist / ML engineer / manager).

## Run

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173
```

`npm run build` does a typecheck (`tsc -b`) + production build.

## Backend connection

The app calls the API at `VITE_API_BASE` (default `http://localhost:8000`).
The backend sets permissive CORS, so direct calls work. A Vite dev proxy also
maps `/api` → `http://localhost:8000` if you prefer a same-origin path
(`VITE_API_BASE=/api`). See `.env.example`.

## Mock backend (MSW) — demoable with no backend

An [MSW](https://mswjs.io) mock implements every endpoint from `openapi.json`
against an in-memory store that mirrors the real status/normalization rules
(Cheng–Prusoff, blocked reasons). The mock starts when:

- `VITE_USE_MOCK=1`, **or**
- the **MOCK/LIVE** badge in the nav is toggled to MOCK (persisted), **or**
- the live backend `/health` check fails (automatic fallback).

The key interaction works in mock mode: open a blocked record on `/records`,
fill the missing fields, save — the row flips green and the model-ready count on
`/` updates.

## Routes

| Route | View |
|-------|------|
| `/` | Loop overview (two-loop SVG with live counts; blocked highlighted) |
| `/records` | Records table + inline fix of blocked records (`?status=` filter) |
| `/compound/:inchikey` | Per-compound measurements by comparability + Boltz prediction |
| `/acquisition` | Ranked candidate batch; Approve / Replay buttons |
| `/metrics` | Manager dashboard: model-ready %, blocked-by-reason, credit, calibration |

## Layout

- `src/api/` — typed client + types (mirrors the frozen contract)
- `src/mocks/` — MSW handlers + in-memory backend
- `src/components/` — NavBar, StructureCanvas (smiles-drawer), StatusDot
- `src/views/` — the five routes
- `src/lib/` — persona context, formatting, async hook
