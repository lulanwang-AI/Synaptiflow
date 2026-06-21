import math

from app.ingest import cheng_prusoff_enzyme, ingest
from app.schema import (
    Assay,
    AssayRecordIn,
    BlockedReason,
    Compound,
    Conditions,
    Measurement,
    RecordStatus,
)


def _record(**assay_kw):
    base = dict(
        assay_type="SPR", readout="Ki", target_construct="C1", value=1e-7, unit="M"
    )
    base.update(assay_kw)
    return AssayRecordIn(compound=Compound(smiles="c1ccccc1O"), assay=Assay(**base))


def test_model_ready_native_ki():
    rec = ingest(_record(readout="Ki", value=8e-8, unit="M"))
    assert rec.status == RecordStatus.model_ready
    assert rec.ki_M == 8e-8


def test_blocked_missing_construct():
    rec = ingest(_record(target_construct=None))
    assert rec.status == RecordStatus.blocked
    assert rec.blocked_reason == BlockedReason.missing_construct
    assert "assay.target_construct" in rec.missing_fields


def test_blocked_missing_unit():
    rec = ingest(_record(unit=None))
    assert rec.status == RecordStatus.blocked
    assert rec.blocked_reason == BlockedReason.missing_unit


def test_blocked_invalid_identity():
    raw = AssayRecordIn(
        compound=Compound(smiles="garbage_%%%"),
        assay=Assay(assay_type="SPR", readout="Ki", target_construct="C1", value=1e-7, unit="M"),
    )
    rec = ingest(raw)
    assert rec.status == RecordStatus.blocked
    assert rec.blocked_reason == BlockedReason.missing_identity


def test_blocked_qc_fail():
    raw = AssayRecordIn(
        compound=Compound(smiles="c1ccccc1O"),
        assay=Assay(assay_type="SPR", readout="Ki", target_construct="C1", value=1e-7, unit="M"),
        measurement=Measurement(qc_flag="fail"),
    )
    rec = ingest(raw)
    assert rec.status == RecordStatus.blocked
    assert rec.blocked_reason == BlockedReason.qc_fail


def test_ic50_blocked_without_conditions():
    rec = ingest(_record(assay_type="enzymatic_IC50", readout="IC50", value=5e-7, unit="M"))
    assert rec.status == RecordStatus.blocked
    assert rec.blocked_reason == BlockedReason.missing_conditions
    assert "conditions.substrate_conc_M" in rec.missing_fields


def test_ic50_normalized_with_conditions():
    raw = AssayRecordIn(
        compound=Compound(smiles="c1ccccc1O"),
        assay=Assay(
            assay_type="enzymatic_IC50", readout="IC50",
            target_construct="C1", value=1e-6, unit="M",
        ),
        conditions=Conditions(substrate_conc_M=1e-5, km_M=2e-5),
    )
    rec = ingest(raw)
    # Ki = 1e-6 / (1 + 1e-5/2e-5) = 1e-6 / 1.5 = 6.667e-7
    assert rec.status == RecordStatus.model_ready
    assert math.isclose(rec.ki_M, 1e-6 / 1.5, rel_tol=1e-9)


def test_cheng_prusoff_known_value():
    # IC50 = 1e-6, [S] = 1e-5, Km = 2e-5 -> Ki = 6.666...e-7
    ki = cheng_prusoff_enzyme(1e-6, 1e-5, 2e-5)
    assert math.isclose(ki, 6.6666666e-7, rel_tol=1e-6)


def test_soft_qc_is_normalizable():
    raw = AssayRecordIn(
        compound=Compound(smiles="c1ccccc1O"),
        assay=Assay(assay_type="FP", readout="Ki", target_construct="C1", value=1e-7, unit="M"),
        measurement=Measurement(qc_flag="aggregator"),
    )
    rec = ingest(raw)
    assert rec.status == RecordStatus.normalizable
    assert rec.ki_M == 1e-7


def test_unit_normalization_nM():
    rec = ingest(_record(value=100, unit="nM"))
    assert math.isclose(rec.value_M, 1e-7, rel_tol=1e-9)
