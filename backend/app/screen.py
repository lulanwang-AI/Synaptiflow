"""UHTS screening campaign mimic — Aaron's workflow, made runnable.

The loop from the assay side:
    predicted candidates
      → PRIMARY screen (large-scale, single-conc % inhibition, hit-called)
      → CONFIRM (dose-response IC50/EC50) + CHARACTERIZE (SPR Kd / Ki)
      → those measured affinities become GROUND TRUTH: ingested as model-ready
        records and diffed against the cached prediction (calibration), which is
        what re-trains the surrogate and grades the Boltz prediction.

Deterministic mock (no spend, no network). Stronger predicted binders screen
hotter, so the funnel behaves sensibly end-to-end.
"""
from __future__ import annotations

import hashlib
import random
from typing import Optional

from .identity import InvalidSmilesError, resolve
from .ingest import ingest
from .schema import (
    Assay,
    AssayRecordIn,
    Compound,
    Conditions,
    ConfirmHit,
    ConfirmResult,
    Measurement,
    PrimaryHit,
    PrimaryResult,
    Provenance,
)
from .store import get_store

CONSTRUCT = "KINASE_X_1-320_His"
HIT_THRESHOLD = 40.0  # % inhibition to be called a primary hit


def _seed(*parts: str) -> int:
    return int(hashlib.sha1("|".join(parts).encode()).hexdigest()[:8], 16)


def _predicted_loguM(inchikey: str) -> Optional[float]:
    pred = get_store().get_prediction(inchikey)
    return pred.boltz_affinity_loguM if pred is not None else None


def _strength(inchikey: str, predicted: Optional[float]) -> float:
    """Higher = a hotter screen. Predicted log-µM: lower = stronger binder."""
    if predicted is not None:
        return max(0.0, 2.6 - predicted)
    rng = random.Random(_seed("strength", inchikey))
    return rng.uniform(0.2, 4.0)


def run_primary(smiles_list: list[str], target=None) -> PrimaryResult:
    """Mimic a 1536-well primary screen: % inhibition + hit calls + plate QC.

    Each candidate's % inhibition is ingested as a first-class primary record.
    """
    store = get_store()
    results: list[PrimaryHit] = []
    for smi in smiles_list:
        try:
            ident = resolve(smi)
        except InvalidSmilesError:
            continue
        ik = ident.inchikey
        strength = _strength(ik, _predicted_loguM(ik))
        rng = random.Random(_seed("primary", ik))
        pct = round(max(-8.0, min(99.0, strength * 17.0 + rng.uniform(-10.0, 12.0) + 12.0)), 1)
        is_hit = pct >= HIT_THRESHOLD
        results.append(PrimaryHit(smiles=ident.smiles_canonical, inchikey=ik, pct_inhibition=pct, is_hit=is_hit))

        rec = ingest(
            AssayRecordIn(
                compound=Compound(smiles=smi),
                assay=Assay(
                    assay_id="UHTS-PRIMARY",
                    assay_type="primary_screen",
                    readout="pct_inhibition",
                    target_construct=CONSTRUCT,
                    value=pct,
                    unit="%",
                ),
                conditions=Conditions(temperature_c=25),
                measurement=Measurement(replicates=1, qc_flag="pass", operator="uhts"),
                provenance=Provenance(source_system="1536-UHTS", run_id="RUN-UHTS"),
            )
        )
        store.upsert(rec)

    n = len(results)
    hits = sum(1 for r in results if r.is_hit)
    z_prime = round(0.72 + (_seed("zprime", CONSTRUCT) % 900) / 10000.0, 3)  # ~0.72–0.81
    return PrimaryResult(
        screened=n,
        plate_wells=1536,
        z_prime=z_prime,
        hit_threshold=HIT_THRESHOLD,
        hits=hits,
        hit_rate=round(hits / n, 3) if n else 0.0,
        results=results,
    )


def run_confirm(smiles_list: list[str], target=None) -> ConfirmResult:
    """Confirm hits (dose-response) + characterize (SPR). The measured Ki is
    ingested as ground truth and calibrated against the cached prediction."""
    store = get_store()
    out: list[ConfirmHit] = []
    for smi in smiles_list:
        try:
            ident = resolve(smi)
        except InvalidSmilesError:
            continue
        ik = ident.inchikey
        predicted = _predicted_loguM(ik)
        rng = random.Random(_seed("confirm", ik))
        base = predicted if predicted is not None else rng.uniform(-2.0, 1.5)
        measured_loguM = base + rng.uniform(-0.6, 1.0)  # bias + noise = fidelity gap
        ki = 10 ** (measured_loguM - 6.0)  # log-µM → M
        ic50 = ki * (1.4 + rng.random())
        kd = ki * (0.7 + rng.random() * 0.5)
        qc = "aggregator" if rng.random() < 0.18 else "pass"
        confirmed = ic50 < 1e-5 and qc != "fail"

        rec = ingest(
            AssayRecordIn(
                compound=Compound(smiles=smi),
                assay=Assay(
                    assay_id="CONF-SPR",
                    assay_type="SPR",
                    readout="Ki",
                    target_construct=CONSTRUCT,
                    value=ki,
                    unit="M",
                ),
                conditions=Conditions(temperature_c=25, ph=7.4),
                measurement=Measurement(replicates=3, qc_flag=qc, operator="confirm"),
                provenance=Provenance(source_system="confirmation", run_id="RUN-CONF"),
            )
        )
        store.upsert(rec)
        store.bump_counter("assayed", 1)
        if predicted is not None:
            store.record_calibration(ik, predicted, measured_loguM)

        out.append(
            ConfirmHit(
                smiles=ident.smiles_canonical,
                inchikey=ik,
                ic50_M=ic50,
                ec50_M=ic50 * 1.1,
                kd_M=kd,
                ki_M=ki,
                predicted_loguM=predicted,
                measured_loguM=round(measured_loguM, 3),
                delta_loguM=round(predicted - measured_loguM, 3) if predicted is not None else None,
                qc_flag=qc,
                confirmed=confirmed,
            )
        )

    cal, _ = store.calibration_error()
    return ConfirmResult(
        confirmed=sum(1 for r in out if r.confirmed),
        results=out,
        calibration_error=round(cal, 4) if cal is not None else None,
    )
