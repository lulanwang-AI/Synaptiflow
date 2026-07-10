"""Pydantic v2 models — the frozen data contract.

These models are the spine of wet↔dry communication. The assay-record models
mirror spec §1 exactly. The Prediction model is a SEPARATE lane for Boltz
outputs and must never be conflated with an assay record. The Target model is
the generator input.

FROZEN after Session 1: field names and response shapes here are a contract the
frontend builds against. Change internals, not these signatures.
"""
from __future__ import annotations

from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


# --------------------------------------------------------------------------- #
# Enums
# --------------------------------------------------------------------------- #
class RecordStatus(str, Enum):
    model_ready = "model_ready"
    normalizable = "normalizable"
    blocked = "blocked"


class BlockedReason(str, Enum):
    missing_identity = "missing_identity"
    missing_construct = "missing_construct"
    missing_unit = "missing_unit"
    missing_conditions = "missing_conditions"
    qc_fail = "qc_fail"


class AssayType(str, Enum):
    SPR = "SPR"
    ITC = "ITC"
    DSF = "DSF"
    FP = "FP"
    enzymatic_IC50 = "enzymatic_IC50"
    radioligand = "radioligand"
    other = "other"


# --------------------------------------------------------------------------- #
# Assay-record sub-models (spec §1)
# --------------------------------------------------------------------------- #
class Compound(BaseModel):
    smiles: str = Field(..., description="Working representation (required)")
    smiles_canonical: Optional[str] = Field(
        None, description="Derived: RDKit canonicalization"
    )
    inchikey: Optional[str] = Field(None, description="Derived: stable join/dedup key")
    compound_id: Optional[str] = Field(None, description="Assigned on register")
    batch_id: Optional[str] = Field(None, description="Optional salt/batch metadata")


class Assay(BaseModel):
    assay_id: Optional[str] = None
    assay_type: str = Field(..., description="SPR | ITC | enzymatic_IC50 | radioligand | ...")
    readout: str = Field(..., description="Kd | IC50 | Ki | pct_inhibition | dTm | ...")
    target_construct: Optional[str] = Field(
        None, description="Exact construct matters (required for model_ready)"
    )
    value: Optional[float] = None
    unit: Optional[str] = Field(None, description="Required; normalized to molar")


class Conditions(BaseModel):
    temperature_c: Optional[float] = None
    buffer: Optional[str] = None
    ph: Optional[float] = None
    substrate_conc_M: Optional[float] = Field(None, description="[S], enzymatic IC50 -> Ki")
    km_M: Optional[float] = Field(None, description="Km, Cheng-Prusoff (enzyme)")
    ligand_conc_M: Optional[float] = Field(None, description="[L], radioligand IC50 -> Ki")
    probe_kd_M: Optional[float] = Field(None, description="Kd of probe (radioligand)")


class Measurement(BaseModel):
    replicates: Optional[int] = None
    std_error: Optional[float] = None
    qc_flag: Optional[str] = Field("pass", description="pass | aggregator | fluorescence_interference | fail")
    operator: Optional[str] = None
    date: Optional[str] = None


class Provenance(BaseModel):
    source_system: Optional[str] = None
    run_id: Optional[str] = None
    protocol_ref: Optional[str] = None


# --------------------------------------------------------------------------- #
# Assay record (ground-truth lane)
# --------------------------------------------------------------------------- #
class AssayRecordIn(BaseModel):
    """Raw assay record submitted for ingest (spec §1)."""

    compound: Compound
    assay: Assay
    conditions: Conditions = Field(default_factory=Conditions)
    measurement: Measurement = Field(default_factory=Measurement)
    provenance: Provenance = Field(default_factory=Provenance)


class AssayRecord(AssayRecordIn):
    """Stored assay record: raw record + computed status + derived fields."""

    record_id: str
    status: RecordStatus
    blocked_reason: Optional[BlockedReason] = None
    reason_detail: Optional[str] = Field(
        None, description="Human/machine-readable explanation, quoted verbatim in UI"
    )
    missing_fields: list[str] = Field(
        default_factory=list, description="Exact fields needed to unblock"
    )
    value_M: Optional[float] = Field(None, description="Reported value normalized to molar")
    ki_M: Optional[float] = Field(None, description="Derived Ki in molar (Cheng-Prusoff)")
    comparability_key: Optional[str] = Field(
        None, description="Records with the same key are poolable"
    )


class RecordPatch(BaseModel):
    """Partial edit to a record's metadata. Any sub-object provided is merged."""

    compound: Optional[Compound] = None
    assay: Optional[Assay] = None
    conditions: Optional[Conditions] = None
    measurement: Optional[Measurement] = None
    provenance: Optional[Provenance] = None


# --------------------------------------------------------------------------- #
# Predictions lane (Boltz outputs — NEVER assay records, spec §1)
# --------------------------------------------------------------------------- #
class PredictionProvenance(BaseModel):
    source: str = "boltz-api"
    model: str = "boltzmol-1"
    run_id: Optional[str] = None


class Prediction(BaseModel):
    smiles: str
    inchikey: str
    boltz_affinity_loguM: float = Field(
        ..., description="Assay-agnostic binding-strength proxy, log-µM. NOT a Ki."
    )
    adme_flags: list[str] = Field(default_factory=list)
    ood_flag: bool = False
    provenance: PredictionProvenance = Field(default_factory=PredictionProvenance)


# --------------------------------------------------------------------------- #
# Target (generator input)
# --------------------------------------------------------------------------- #
class Target(BaseModel):
    name: Optional[str] = None
    protein_sequence: str
    chain_ids: list[str] = Field(default_factory=list)
    pocket_residues: list[int] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# Acquisition / loop / metrics response models
# --------------------------------------------------------------------------- #
class AcquisitionCandidate(BaseModel):
    smiles: str
    inchikey: str
    mu: float = Field(..., description="Cheap-surrogate predicted pKi mean")
    sigma: float = Field(..., description="Cheap-surrogate ensemble std (uncertainty)")
    boltz_affinity: Optional[float] = Field(None, description="Boltz affinity proxy, log-µM")
    adme_flags: list[str] = Field(default_factory=list)
    ood_flag: bool = False
    tag: str = Field(..., description="exploit | explore")
    rationale: str
    design_run_id: Optional[str] = None


class AcquisitionBatch(BaseModel):
    target_name: Optional[str] = None
    generated: int = 0
    scored: int = 0
    shortlisted: int = 0
    candidates: list[AcquisitionCandidate] = Field(default_factory=list)


class LoopSummary(BaseModel):
    generated: int = 0
    scored: int = 0
    selected: int = 0
    in_synthesis: int = 0
    assayed: int = 0
    ingested: int = 0
    model_ready: int = 0
    normalizable: int = 0
    blocked: int = 0


class Metrics(BaseModel):
    total_records: int = 0
    pct_model_ready: float = 0.0
    blocked_by_reason: dict[str, int] = Field(default_factory=dict)
    queue_depths: dict[str, int] = Field(default_factory=dict)
    cycle_time_s: Optional[float] = None
    credit_spent_usd: float = 0.0
    credit_cap_usd: float = 0.0
    credit_remaining_usd: float = 0.0
    calibration_error: Optional[float] = Field(
        None, description="Mean |Boltz predicted - measured| over closed cycles"
    )
    calibration_n: int = 0


class CompoundMeasurement(BaseModel):
    record_id: str
    assay_type: str
    readout: str
    target_construct: Optional[str] = None
    value: Optional[float] = None
    unit: Optional[str] = None
    ki_M: Optional[float] = None
    status: RecordStatus
    comparability_key: Optional[str] = None


class ComparabilityGroup(BaseModel):
    comparability_key: str
    poolable: bool
    measurements: list[CompoundMeasurement] = Field(default_factory=list)


class CompoundView(BaseModel):
    inchikey: str
    smiles_canonical: Optional[str] = None
    compound_id: Optional[str] = None
    groups: list[ComparabilityGroup] = Field(default_factory=list)
    prediction: Optional[Prediction] = None
    measured_ki_M: Optional[float] = Field(
        None, description="Best/representative measured Ki for predicted-vs-measured delta"
    )
    delta_loguM: Optional[float] = Field(
        None, description="Boltz prediction minus measured (log-µM); calibration signal"
    )


# --------------------------------------------------------------------------- #
# Misc response models
# --------------------------------------------------------------------------- #
class IngestResponse(BaseModel):
    record: AssayRecord


class ReplayRequest(BaseModel):
    inchikeys: Optional[list[str]] = Field(
        None, description="Subset to replay; default = current acquisition batch"
    )


class ReplayResponse(BaseModel):
    replayed: int
    records: list[AssayRecord] = Field(default_factory=list)
    calibration_error: Optional[float] = None


class ResetResponse(BaseModel):
    ok: bool
    records: int


# --------------------------------------------------------------------------- #
# Synthesis queue (outer loop: selected batch -> synthesis -> assay)
# --------------------------------------------------------------------------- #
class QueueItem(BaseModel):
    smiles: str
    inchikey: str
    target_construct: Optional[str] = None
    boltz_affinity_loguM: Optional[float] = Field(
        None, description="Cached Boltz prediction (log-µM); the value replay calibrates against"
    )
    design_run_id: Optional[str] = None
    selected_at: Optional[float] = Field(None, description="Unix time the candidate was approved")


class QueueView(BaseModel):
    depth: int = 0
    items: list[QueueItem] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# NIM structure tier (AlphaFold2 fold + DiffDock dock)
# --------------------------------------------------------------------------- #
class FoldResult(BaseModel):
    plddt: float = Field(..., description="Mean predicted structure confidence (pLDDT)")
    pocket_residues: list[int] = Field(default_factory=list)
    model: str = "alphafold2"


class DockRequest(BaseModel):
    target: Target
    smiles: list[str] = Field(default_factory=list)


class DockResult(BaseModel):
    smiles: str
    dock_confidence: float = Field(..., description="DiffDock pose confidence (0–1)")
    model: str = "diffdock"


class DockResponse(BaseModel):
    results: list[DockResult] = Field(default_factory=list)


class PoseRequest(BaseModel):
    smiles: str
    target: Optional[Target] = None


class PoseResult(BaseModel):
    smiles: str
    sdf: Optional[str] = Field(None, description="3-D docked pose as an SDF/MOL block")
    receptor_pdb: Optional[str] = Field(
        None, description="Folded receptor structure (PDB) to overlay, when available"
    )
    model: str = "diffdock"


# --------------------------------------------------------------------------- #
# UHTS screening campaign (primary screen → confirmation → characterization)
# --------------------------------------------------------------------------- #
class ScreenRequest(BaseModel):
    smiles: list[str] = Field(default_factory=list)
    target: Optional[Target] = None


class PrimaryHit(BaseModel):
    smiles: str
    inchikey: str
    pct_inhibition: float
    is_hit: bool


class PrimaryResult(BaseModel):
    screened: int = 0
    plate_wells: int = 1536
    z_prime: float = 0.0
    hit_threshold: float = 40.0
    hits: int = 0
    hit_rate: float = 0.0
    results: list[PrimaryHit] = Field(default_factory=list)


class ConfirmHit(BaseModel):
    smiles: str
    inchikey: str
    ic50_M: Optional[float] = None
    ec50_M: Optional[float] = None
    kd_M: Optional[float] = None
    ki_M: Optional[float] = None
    predicted_loguM: Optional[float] = None
    measured_loguM: Optional[float] = None
    delta_loguM: Optional[float] = Field(None, description="Predicted − measured (log-µM)")
    qc_flag: str = "pass"
    confirmed: bool = True


class ConfirmResult(BaseModel):
    confirmed: int = 0
    results: list[ConfirmHit] = Field(default_factory=list)
    calibration_error: Optional[float] = None
