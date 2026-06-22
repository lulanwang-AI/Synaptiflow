"""NIM tier (AlphaFold2 / MolMIM / DiffDock) — mock mode, no network/spend.

Also asserts BoltzMol remains the default generator.
"""
import os

from fastapi.testclient import TestClient

from app import generator
from app.main import app
from app.nim_client import get_nim_client
from app.seed_loader import load_target


def test_nim_fold_mock_deterministic():
    c = get_nim_client()
    t = load_target()
    a = c.fold(t)
    b = c.fold(t)
    assert a == b
    assert 60.0 <= a["plddt"] <= 100.0
    assert a["model"] == "alphafold2"
    assert a["pocket_residues"]  # carries the target pocket


def test_nim_dock_mock_aligned_and_bounded():
    c = get_nim_client()
    t = load_target()
    res = c.dock(t, ["CCO", "c1ccccc1"])
    assert [r["smiles"] for r in res] == ["CCO", "c1ccccc1"]
    assert all(0.0 <= r["dock_confidence"] <= 1.0 for r in res)
    assert all(r["model"] == "diffdock" for r in res)


def test_nim_generate_mock_smiles():
    c = get_nim_client()
    t = load_target()
    mols = c.generate(t, 5)
    assert len(mols) == 5
    assert all("smiles" in m for m in mols)


def test_default_generator_is_boltzmol():
    # No GENERATOR_ENGINE set -> BoltzMol design path (design_run_id like design-*)
    os.environ.pop("GENERATOR_ENGINE", None)
    out = generator.design(load_target(), num_molecules=4)
    assert out
    assert all(c.get("design_run_id", "").startswith("design-") for c in out)


def test_api_fold_and_dock_endpoints():
    client = TestClient(app)
    with client:
        t = client.get("/target").json()
        f = client.post("/structure/fold", json=t).json()
        assert f["model"] == "alphafold2"
        assert 60.0 <= f["plddt"] <= 100.0

        d = client.post("/dock", json={"target": t, "smiles": ["CCO", "c1ccccc1"]}).json()
        smis = [r["smiles"] for r in d["results"]]
        assert smis == ["CCO", "c1ccccc1"]
        assert all(r["model"] == "diffdock" for r in d["results"])
