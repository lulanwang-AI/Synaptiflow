"""UHTS screening campaign: predicted candidates → primary → confirm → feedback."""
from fastapi.testclient import TestClient

from app import acquisition, screen, seed_loader
from app.main import app
from app.store import get_store


def _candidate_smiles():
    # Build a batch so predictions are cached in the store, then screen them.
    batch = acquisition.build_batch(seed_loader.load_target())
    return [c.smiles for c in batch.candidates]


def test_primary_screen_ingests_pct_records_and_calls_hits():
    smis = _candidate_smiles()
    res = screen.run_primary(smis)
    assert res.screened == len(smis)
    assert res.plate_wells == 1536
    assert 0.0 <= res.hit_rate <= 1.0
    assert res.hits == sum(1 for r in res.results if r.is_hit)
    # % inhibition records are now first-class model-ready data
    store = get_store()
    prim = [r for r in store.all_records() if r.assay.readout == "pct_inhibition"]
    assert prim and all(r.status.value == "model_ready" for r in prim)


def test_confirm_feeds_ground_truth_and_calibration():
    smis = _candidate_smiles()
    primary = screen.run_primary(smis)
    hits = [r.smiles for r in primary.results if r.is_hit] or smis[:2]
    conf = screen.run_confirm(hits)
    assert conf.results
    c = conf.results[0]
    assert c.ki_M is not None and c.ic50_M is not None and c.kd_M is not None
    # measured Ki is diffed against the cached prediction → calibration exists
    assert conf.calibration_error is not None


def test_api_screen_endpoints():
    client = TestClient(app)
    with client:
        batch = client.get("/acquisition/batch").json()
        smis = [c["smiles"] for c in batch["candidates"]]
        p = client.post("/screen/primary", json={"smiles": smis}).json()
        assert p["screened"] == len(smis)
        assert "z_prime" in p
        hits = [r["smiles"] for r in p["results"] if r["is_hit"]] or smis[:1]
        c = client.post("/screen/confirm", json={"smiles": hits}).json()
        assert c["results"][0]["ki_M"] is not None
