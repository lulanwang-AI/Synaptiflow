"""FastAPI entrypoint: `uvicorn app.main:app`."""
from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from .api import router
from .seed_loader import seed_store


@asynccontextmanager
async def lifespan(app: FastAPI):
    seed_store()
    yield


app = FastAPI(
    title="SynaptiFlow — Closed-Loop Discovery MVP",
    version="0.1.0",
    description=(
        "Assay-metadata schema as the spine of wet↔dry communication. "
        "Boltz outputs are PREDICTIONS, never assay records. All Boltz access "
        "goes through app/boltz_client.py with mock mode, caching, and a credit guard."
    ),
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)


@app.get("/health", tags=["meta"])
def health():
    return {"status": "ok"}


# --------------------------------------------------------------------------- #
# Single-origin static serving (Replit / any single-service deploy) — ADDITIVE.
#
# When the frontend has been built (`frontend/dist` exists), serve it from this
# same process so one Uvicorn on $PORT serves both the API and the SPA — no CORS,
# no second port. The API routes registered above always match first; this
# catch-all only handles paths the API didn't claim, returning the built asset
# when present and falling back to index.html for client-side routes. It is
# excluded from the OpenAPI schema, so `docs/openapi.json` is unchanged, and it
# is a no-op in tests/CI (no dist dir), leaving the frozen contract untouched.
# --------------------------------------------------------------------------- #
_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if _DIST.is_dir():

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa_fallback(full_path: str) -> FileResponse:
        asset = _DIST / full_path
        if full_path and asset.is_file():
            return FileResponse(asset)
        return FileResponse(_DIST / "index.html")
