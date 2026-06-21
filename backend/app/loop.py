"""Synthesis queue + replay — closing the loop (spec §2 stage 7).

approve(batch)  → moves the selected batch into the synthesis queue.
replay_results  → turns queued candidates into MOCKED assay records and feeds
                  them back through ingest, closing the loop. Each returned
                  ground-truth value is diffed against the cached Boltz
                  prediction → calibration_error surfaced in /metrics.

The replayed values are synthetic ground truth (spec §6: wet-lab results are
mocked). They are correlated with the Boltz prediction but deliberately offset
and noised, so the predicted-vs-measured delta is meaningful, not zero.
"""
from __future__ import annotations

import hashlib
import random
import time
from typing import Optional

from .ingest import ingest
from .schema import (
    Assay,
    AssayRecordIn,
    Compound,
    Conditions,
    Measurement,
    Provenance,
    QueueItem,
    QueueView,
    ReplayResponse,
)
from .store import get_store

# In-process synthesis queue: list of {smiles, inchikey, design_run_id,
# boltz_affinity_loguM, selected_at}.
_QUEUE: list[dict] = []


def reset_queue() -> None:
    _QUEUE.clear()


def queue_depth() -> int:
    return len(_QUEUE)


def queue_view() -> QueueView:
    """Snapshot of the synthesis queue (candidates awaiting wet-lab results)."""
    items = [
        QueueItem(
            smiles=q["smiles"],
            inchikey=q["inchikey"],
            target_construct=q.get("construct"),
            boltz_affinity_loguM=q.get("boltz_affinity_loguM"),
            design_run_id=q.get("design_run_id"),
            selected_at=q.get("selected_at"),
        )
        for q in _QUEUE
    ]
    return QueueView(depth=len(_QUEUE), items=items)


def approve(batch, construct: str = "KINASE_X_1-320_His") -> int:
    """Move an AcquisitionBatch's candidates into the synthesis queue."""
    store = get_store()
    now = time.time()
    for c in batch.candidates:
        _QUEUE.append(
            {
                "smiles": c.smiles,
                "inchikey": c.inchikey,
                "design_run_id": c.design_run_id,
                "boltz_affinity_loguM": c.boltz_affinity,
                "construct": construct,
                "selected_at": now,
            }
        )
    store.set_counter("selected", store.get_counter("selected") + len(batch.candidates))
    store.set_counter("in_synthesis", len(_QUEUE))
    return len(_QUEUE)


def _mocked_measurement(item: dict) -> tuple[float, float]:
    """Return (measured_ki_M, measured_loguM) — synthetic but deterministic."""
    seed = int(hashlib.sha1(item["inchikey"].encode()).hexdigest()[:8], 16)
    rng = random.Random(seed)
    pred_loguM = item.get("boltz_affinity_loguM") or 0.0
    # measured = prediction + systematic bias + noise (the fidelity gap)
    measured_loguM = pred_loguM + rng.uniform(-0.8, 1.2)
    ki_M = 10 ** (measured_loguM - 6.0)  # log µM -> M
    return ki_M, measured_loguM


def replay_results(inchikeys: Optional[list[str]] = None) -> ReplayResponse:
    """Replay queued (or specified) candidates as mocked assay results."""
    store = get_store()
    items = _QUEUE if inchikeys is None else [i for i in _QUEUE if i["inchikey"] in inchikeys]

    records = []
    for item in items:
        ki_M, measured_loguM = _mocked_measurement(item)
        raw = AssayRecordIn(
            compound=Compound(smiles=item["smiles"]),
            assay=Assay(
                assay_id="ASY-REPLAY",
                assay_type="SPR",
                readout="Ki",
                target_construct=item["construct"],
                value=ki_M,
                unit="M",
            ),
            conditions=Conditions(temperature_c=25, ph=7.4),
            measurement=Measurement(replicates=3, qc_flag="pass", operator="loop", date="2026-06-20"),
            provenance=Provenance(source_system="replayed-synthesis", run_id="RUN-REPLAY"),
        )
        rec = ingest(raw)
        store.upsert(rec)
        records.append(rec)
        store.bump_counter("assayed", 1)

        # calibration: diff cached Boltz prediction vs returned ground truth
        pred = store.get_prediction(item["inchikey"])
        if pred is not None:
            store.record_calibration(item["inchikey"], pred.boltz_affinity_loguM, measured_loguM)

        # cycle time: selection -> result
        ct = time.time() - item.get("selected_at", time.time())
        store.set_counter("cycle_time_s", round(ct, 3))

    # drain the queue of replayed items
    replayed_keys = {i["inchikey"] for i in items}
    _QUEUE[:] = [i for i in _QUEUE if i["inchikey"] not in replayed_keys]
    store.set_counter("in_synthesis", len(_QUEUE))

    cal_err, _ = store.calibration_error()
    return ReplayResponse(
        replayed=len(records),
        records=records,
        calibration_error=round(cal_err, 4) if cal_err is not None else None,
    )
