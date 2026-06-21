"""End-to-end loop smoke test (BOLTZ_MOCK=1) — a fresh clone is known-good
without credits. Run: BOLTZ_MOCK=1 python smoke_loop.py

Walks the spec §5 demo cycle in code and asserts each stage advances.
"""
import os
import sys

os.environ.setdefault("BOLTZ_MOCK", "1")

from app import acquisition, loop, seed_loader
from app.ingest import ingest
from app.schema import Assay, AssayRecordIn, Compound, Conditions, RecordStatus
from app.store import get_store


def main() -> int:
    store = get_store()
    n = seed_loader.seed_store()
    s0 = store.loop_summary()
    print(f"[seed]        {n} records  | model_ready={s0.model_ready} "
          f"normalizable={s0.normalizable} blocked={s0.blocked}")
    assert s0.blocked > 0 and s0.model_ready > 0

    # 1) blocked IC50 -> add conditions -> model_ready with ki_M
    blocked_ic50 = next(
        r for r in store.blocked_records() if r.assay.readout == "IC50"
    )
    raw = AssayRecordIn(
        compound=Compound(smiles=blocked_ic50.compound.smiles),
        assay=Assay(**blocked_ic50.assay.model_dump()),
        conditions=Conditions(substrate_conc_M=1e-5, km_M=2e-5),
    )
    fixed = ingest(raw, record_id=blocked_ic50.record_id)
    store.upsert(fixed)
    print(f"[fix-block]   {blocked_ic50.record_id} IC50 + [S]/Km -> "
          f"{fixed.status.value}  ki_M={fixed.ki_M:.3e}")
    assert fixed.status == RecordStatus.model_ready and fixed.ki_M is not None

    # 2) train surrogate + design + screen + rank
    target = seed_loader.load_target()
    batch = acquisition.build_batch(target)
    print(f"[acquire]     generated={batch.generated} scored={batch.scored} "
          f"shortlisted={batch.shortlisted} final={len(batch.candidates)}")
    assert batch.candidates
    assert store.all_predictions(), "predictions lane must be populated"
    print(f"[predict]     {len(store.all_predictions())} Boltz predictions "
          f"(separate lane, never assay records)")

    # 3) approve -> synthesis queue -> replay -> calibration
    loop.approve(batch)
    print(f"[approve]     synthesis queue depth = {loop.queue_depth()}")
    resp = loop.replay_results()
    print(f"[replay]      replayed={resp.replayed}  "
          f"calibration_error={resp.calibration_error}")
    assert resp.replayed == len(batch.candidates)
    assert resp.calibration_error is not None

    # 4) credit guard: mock spends nothing
    from app.boltz_client import get_client

    spent = get_client().spent_usd
    print(f"[credit]      spent_usd={spent} (mock mode spends nothing)")
    assert spent == 0.0

    print("\nSMOKE OK — closed loop ran end-to-end in mock mode, zero spend.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
