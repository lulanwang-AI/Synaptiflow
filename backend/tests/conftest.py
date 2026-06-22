import os

# Tests NEVER spend credits.
os.environ["BOLTZ_MOCK"] = "1"
os.environ.setdefault("BOLTZ_MAX_SPEND_USD", "50")

import pytest

from app import identity
from app.boltz_client import reset_client
from app.nim_client import reset_nim_client
from app.seed_loader import seed_store
from app.store import reset_store
from app.surrogate import reset_surrogate


@pytest.fixture(autouse=True)
def fresh_state():
    reset_store()
    reset_client()
    reset_nim_client()
    reset_surrogate()
    identity.reset_registry()
    seed_store()
    yield
