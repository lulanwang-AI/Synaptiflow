"""Load seed records + target into the store. Used at startup and on /reset."""
from __future__ import annotations

import json
from pathlib import Path

from . import identity
from .ingest import ingest
from .loop import reset_queue
from .schema import AssayRecordIn, Target
from .store import get_store

SEED_DIR = Path(__file__).parent / "seed"


def load_target() -> Target:
    data = json.loads((SEED_DIR / "target.json").read_text())
    return Target(**data)


def seed_store() -> int:
    """Reset and reload the store from seed files. Returns record count."""
    store = get_store()
    store.reset()
    identity.reset_registry()
    reset_queue()

    n = 0
    for line in (SEED_DIR / "records.jsonl").read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        raw = AssayRecordIn.model_validate_json(line)
        rec = ingest(raw, record_id=f"REC-{n+1:03d}")
        store.upsert(rec)
        n += 1
    return n
