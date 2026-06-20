"""FastAPI entrypoint: `uvicorn app.main:app`."""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api import router
from .seed_loader import seed_store


@asynccontextmanager
async def lifespan(app: FastAPI):
    seed_store()
    yield


app = FastAPI(
    title="Closed-Loop Discovery MVP",
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
