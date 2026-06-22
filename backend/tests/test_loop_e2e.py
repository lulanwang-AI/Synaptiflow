"""End-to-end loop test (BOLTZ_MOCK=1): the full closed loop in code + via API."""
from fastapi.testclient import TestClient

from app import acquisition, loop, seed_loader
from app.main import app
from app.schema import RecordStatus
from app.store import get_store


def test_schema_status_paths_present_in_seed():
    store = get_store()
    statuses = {r.status for r in store.all_records()}
    assert RecordStatus.model_ready in statuses
    assert RecordStatus.normalizable in statuses
    assert RecordStatus.blocked in statuses


def test_full_loop_in_code():
    store = get_store()
    target = seed_loader.load_target()

    batch = acquisition.build_batch(target)
    assert batch.generated > 0
    assert batch.scored >= batch.shortlisted
    assert len(batch.candidates) > 0
    # predictions lane populated, never as assay records
    assert len(store.all_predictions()) > 0

    before = store.loop_summary().model_ready
    loop.approve(batch)
    assert loop.queue_depth() == len(batch.candidates)

    resp = loop.replay_results()
    assert resp.replayed == len(batch.candidates)
    assert resp.calibration_error is not None
    after = store.loop_summary().model_ready
    assert after >= before  # replayed Ki records are model_ready


def test_api_blocked_ic50_patch_to_model_ready():
    client = TestClient(app)
    with client:
        # find the blocked IC50 (caffeine, missing conditions)
        records = client.get("/records", params={"status": "blocked"}).json()
        ic50 = next(r for r in records if r["assay"]["readout"] == "IC50")
        rid = ic50["record_id"]
        assert ic50["blocked_reason"] == "missing_conditions"

        summary_before = client.get("/loop/summary").json()["model_ready"]

        patched = client.patch(
            f"/records/{rid}",
            json={"conditions": {"substrate_conc_M": 1e-5, "km_M": 2e-5}},
        ).json()["record"]
        assert patched["status"] == "model_ready"
        assert patched["ki_M"] is not None

        summary_after = client.get("/loop/summary").json()["model_ready"]
        assert summary_after == summary_before + 1


def test_api_acquisition_has_boltz_fields():
    client = TestClient(app)
    with client:
        batch = client.get("/acquisition/batch").json()
        assert batch["candidates"]
        c = batch["candidates"][0]
        for key in ("mu", "sigma", "boltz_affinity", "adme_flags", "ood_flag", "tag", "rationale"):
            assert key in c


def test_api_loop_queue_fills_on_approve_and_drains_on_replay():
    client = TestClient(app)
    with client:
        # empty to start
        q0 = client.get("/loop/queue").json()
        assert q0["depth"] == 0
        assert q0["items"] == []

        # build + approve a batch -> the synthesis queue fills
        batch = client.get("/acquisition/batch").json()
        client.post("/acquisition/approve")
        q1 = client.get("/loop/queue").json()
        assert q1["depth"] == len(batch["candidates"])
        item = q1["items"][0]
        for key in ("smiles", "inchikey", "target_construct", "boltz_affinity_loguM", "design_run_id"):
            assert key in item

        # replay -> queue drains back to empty
        client.post("/loop/replay", json={})
        q2 = client.get("/loop/queue").json()
        assert q2["depth"] == 0


def test_api_acquisition_run_with_custom_target():
    client = TestClient(app)
    with client:
        target = {
            "name": "CUSTOM",
            "protein_sequence": "MKTAYIAKQRQISFVKSHFSRQLEERLGLIEVQAPILSRVGDGTQDNLSGAEKAVQVKVKALPDAQFEVVHSLAKWKR",
            "chain_ids": ["A"],
            "pocket_residues": [10, 12, 30],
        }
        batch = client.post("/acquisition/run", json=target).json()
        assert batch["candidates"]
        c = batch["candidates"][0]
        for key in ("smiles", "inchikey", "mu", "sigma", "boltz_affinity", "tag", "rationale"):
            assert key in c
        # the cached batch can then be approved + replayed (human-in-the-loop)
        client.post("/acquisition/approve")
        q = client.get("/loop/queue").json()
        assert q["depth"] == len(batch["candidates"])


def test_api_metrics_has_credit_and_calibration_fields():
    client = TestClient(app)
    with client:
        m = client.get("/metrics").json()
        for key in ("credit_spent_usd", "credit_cap_usd", "calibration_error"):
            assert key in m
        # mock mode spends nothing
        assert m["credit_spent_usd"] == 0.0
