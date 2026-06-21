import os

import pytest

from app.boltz_client import BoltzClient, CreditCapExceeded
from app.schema import Target

TARGET = Target(protein_sequence="MKELRDLL", chain_ids=["A"], pocket_residues=[1, 2, 3])


def _mock_client():
    return BoltzClient(api_key=None, mock=True, max_spend_usd=50.0)


def test_mock_design_deterministic():
    c1 = _mock_client()
    c2 = _mock_client()
    a = c1.design(TARGET, 5)
    b = c2.design(TARGET, 5)
    assert len(a) == 5
    assert [x["smiles"] for x in a] == [x["smiles"] for x in b]
    assert all("design_run_id" in x for x in a)


def test_mock_screen_and_adme():
    c = _mock_client()
    smis = [x["smiles"] for x in c.design(TARGET, 3)]
    aff = c.screen(TARGET, smis)
    adme = c.adme(smis)
    assert len(aff) == 3 and all("boltz_affinity_loguM" in r for r in aff)
    assert len(adme) == 3 and all("adme_flags" in r for r in adme)


def test_mock_spends_nothing():
    c = _mock_client()
    c.design(TARGET, 10)
    c.screen(TARGET, [x["smiles"] for x in c.design(TARGET, 10)])
    assert c.spent_usd == 0.0


def test_cache_avoids_recompute():
    c = _mock_client()
    smis = [x["smiles"] for x in c.design(TARGET, 3)]
    c.screen(TARGET, smis)
    # second call hits cache; should not error and returns same shape
    again = c.screen(TARGET, smis)
    assert len(again) == 3


def test_screen_results_aligned_to_input_order_with_partial_cache():
    c = _mock_client()
    smis = [x["smiles"] for x in c.design(TARGET, 5)]
    # prime the cache with a middle subset, then screen the full list
    c.screen(TARGET, [smis[2]])
    out = c.screen(TARGET, smis)
    assert [r["smiles"] for r in out] == smis  # one per input, in order


def test_credit_guard_refuses_when_no_key_and_not_mock():
    # not mock, would attempt to charge; small cap -> refuse before spending
    c = BoltzClient(api_key="fake", mock=False, max_spend_usd=0.0)
    with pytest.raises(CreditCapExceeded):
        c.design(TARGET, 1)
    assert c.spent_usd == 0.0
