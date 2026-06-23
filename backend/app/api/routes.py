"""API surface — FROZEN after Session 1.

Every endpoint the frontend needs. Request/response bodies are Pydantic models
from app.schema. Internals may change; these signatures and response shapes must
not.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .. import acquisition, loop, seed_loader
from ..boltz_client import get_client
from ..schema import (
    AcquisitionBatch,
    AssayRecord,
    AssayRecordIn,
    CompoundView,
    DockRequest,
    DockResponse,
    DockResult,
    FoldResult,
    IngestResponse,
    PoseRequest,
    PoseResult,
    LoopSummary,
    Metrics,
    QueueView,
    RecordPatch,
    ReplayRequest,
    ReplayResponse,
    ResetResponse,
    Target,
)
from ..nim_client import get_nim_client
from ..store import get_store

router = APIRouter()

# Last computed acquisition batch (for approve). Per-process.
_LAST_BATCH: dict = {"batch": None}


# --------------------------------------------------------------------------- #
# Loop / overview
# --------------------------------------------------------------------------- #
@router.get("/loop/summary", response_model=LoopSummary, tags=["loop"])
def loop_summary() -> LoopSummary:
    return get_store().loop_summary()


@router.get("/loop/queue", response_model=QueueView, tags=["loop"])
def loop_queue() -> QueueView:
    return loop.queue_view()


@router.post("/loop/replay", response_model=ReplayResponse, tags=["loop"])
def loop_replay(req: ReplayRequest | None = None) -> ReplayResponse:
    inchikeys = req.inchikeys if req else None
    return loop.replay_results(inchikeys)


# --------------------------------------------------------------------------- #
# Records
# --------------------------------------------------------------------------- #
@router.get("/records", response_model=list[AssayRecord], tags=["records"])
def list_records(status: str | None = None) -> list[AssayRecord]:
    records = get_store().all_records()
    if status:
        records = [r for r in records if r.status.value == status]
    return records


@router.get("/records/{record_id}", response_model=AssayRecord, tags=["records"])
def get_record(record_id: str) -> AssayRecord:
    rec = get_store().get(record_id)
    if rec is None:
        raise HTTPException(status_code=404, detail=f"No record {record_id}")
    return rec


@router.post("/records", response_model=IngestResponse, tags=["records"])
def post_record(raw: AssayRecordIn) -> IngestResponse:
    from ..ingest import ingest

    rec = ingest(raw)
    get_store().upsert(rec)
    return IngestResponse(record=rec)


@router.patch("/records/{record_id}", response_model=IngestResponse, tags=["records"])
def patch_record(record_id: str, patch: RecordPatch) -> IngestResponse:
    from ..ingest import ingest

    store = get_store()
    existing = store.get(record_id)
    if existing is None:
        raise HTTPException(status_code=404, detail=f"No record {record_id}")

    # Reconstruct the raw record and merge the patch field-by-field.
    raw = existing.model_dump()
    patch_data = patch.model_dump(exclude_none=True)
    for section, values in patch_data.items():
        if section in raw and isinstance(values, dict):
            raw[section] = {**(raw[section] or {}), **values}

    new_raw = AssayRecordIn(
        compound=raw["compound"],
        assay=raw["assay"],
        conditions=raw["conditions"],
        measurement=raw["measurement"],
        provenance=raw["provenance"],
    )
    rec = ingest(new_raw, record_id=record_id)
    store.upsert(rec)
    return IngestResponse(record=rec)


# --------------------------------------------------------------------------- #
# Compound
# --------------------------------------------------------------------------- #
@router.get("/compound/{inchikey}", response_model=CompoundView, tags=["compound"])
def get_compound(inchikey: str) -> CompoundView:
    view = get_store().compound_measurements(inchikey)
    if not view.groups and view.prediction is None:
        raise HTTPException(status_code=404, detail=f"No data for {inchikey}")
    return view


# --------------------------------------------------------------------------- #
# Acquisition
# --------------------------------------------------------------------------- #
@router.get("/acquisition/batch", response_model=AcquisitionBatch, tags=["acquisition"])
def acquisition_batch() -> AcquisitionBatch:
    target = seed_loader.load_target()
    batch = acquisition.build_batch(target)
    _LAST_BATCH["batch"] = batch
    return batch


@router.post("/acquisition/run", response_model=AcquisitionBatch, tags=["acquisition"])
def acquisition_run(
    target: Target,
    num_molecules: int = 12,
    reference_smiles: str | None = None,
) -> AcquisitionBatch:
    """Generate hits against a user-supplied target (protein/peptide pocket).

    Drives the same pipeline as /acquisition/batch but with the inserted target,
    so the proposed hits respond to the input. `num_molecules` sizes the
    generation step; `reference_smiles` seeds MolMIM optimization when
    GENERATOR_ENGINE=molmim. The result is cached for approve.
    """
    n = max(1, min(int(num_molecules), 40))
    ref = reference_smiles.strip() if reference_smiles and reference_smiles.strip() else None
    batch = acquisition.build_batch(target, num_molecules=n, reference_smiles=ref)
    _LAST_BATCH["batch"] = batch
    return batch


@router.post("/acquisition/approve", response_model=LoopSummary, tags=["acquisition"])
def acquisition_approve() -> LoopSummary:
    batch = _LAST_BATCH["batch"]
    if batch is None:
        target = seed_loader.load_target()
        batch = acquisition.build_batch(target)
        _LAST_BATCH["batch"] = batch
    loop.approve(batch)
    return get_store().loop_summary()


# --------------------------------------------------------------------------- #
# Structure tier — AlphaFold2 fold + DiffDock dock (via nim_client)
# --------------------------------------------------------------------------- #
@router.post("/structure/fold", response_model=FoldResult, tags=["structure"])
def structure_fold(target: Target) -> FoldResult:
    r = get_nim_client().fold(target)
    return FoldResult(
        plddt=r["plddt"], pocket_residues=r["pocket_residues"], model=r["model"]
    )


@router.post("/dock", response_model=DockResponse, tags=["structure"])
def dock(req: DockRequest) -> DockResponse:
    results = get_nim_client().dock(req.target, req.smiles)
    return DockResponse(results=[DockResult(**x) for x in results])


@router.post("/structure/pose", response_model=PoseResult, tags=["structure"])
def structure_pose(req: PoseRequest) -> PoseResult:
    client = get_nim_client()
    r = client.pose(req.target, req.smiles)
    # Overlay the folded receptor structure when a target is supplied.
    receptor_pdb = client.fold(req.target).get("pdb") if req.target is not None else None
    return PoseResult(
        smiles=r["smiles"],
        sdf=r.get("sdf"),
        receptor_pdb=receptor_pdb,
        model=r["model"],
    )


# --------------------------------------------------------------------------- #
# Metrics / target / reset
# --------------------------------------------------------------------------- #
@router.get("/metrics", response_model=Metrics, tags=["metrics"])
def metrics() -> Metrics:
    client = get_client()
    return get_store().metrics(client.spent_usd, client.max_spend_usd)


@router.get("/target", response_model=Target, tags=["target"])
def get_target() -> Target:
    return seed_loader.load_target()


@router.post("/reset", response_model=ResetResponse, tags=["loop"])
def reset() -> ResetResponse:
    from ..boltz_client import reset_client
    from ..nim_client import reset_nim_client
    from ..surrogate import reset_surrogate

    n = seed_loader.seed_store()
    reset_surrogate()
    reset_client()
    reset_nim_client()
    _LAST_BATCH["batch"] = None
    return ResetResponse(ok=True, records=n)
