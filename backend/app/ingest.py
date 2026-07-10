"""Assay ingest + normalization — THE CORE (spec §1, §2 stage 2).

For a raw record we: validate, resolve identity, normalize units to molar,
apply Cheng-Prusoff where applicable, and compute RecordStatus + reason.

Guiding rule (spec §1): we NEVER silently coerce comparability. A missing Ki
beats a fabricated one — a wrong Ki poisons the surrogate more quietly than a
missing one. Records that cannot be normalized are `blocked` with a
machine-readable reason and the exact list of missing fields.

Status policy (documented in CLAUDE.md):
  * blocked      — missing identity | target_construct | unit |
                   (IC50 without the conditions to derive Ki) | qc_flag == "fail"
  * normalizable — would be model_ready but carries a SOFT qc warning
                   (aggregator / fluorescence_interference): usable with caution.
  * model_ready  — identity resolved, (assay_type, readout, construct, unit)
                   present, qc pass, and the readout is condition-light (Kd/Ki)
                   OR an IC50 that was normalized to Ki using present conditions.
"Model-ready is a policy, not a fact" (spec §8) — this is the encoded policy.
"""
from __future__ import annotations

import math
import uuid
from typing import Optional

from . import identity
from .schema import AssayRecord, AssayRecordIn, BlockedReason, RecordStatus

# Unit -> molar multiplier.
_UNIT_TO_M = {
    "M": 1.0,
    "mM": 1e-3,
    "uM": 1e-6,
    "µM": 1e-6,
    "μM": 1e-6,
    "nM": 1e-9,
    "pM": 1e-12,
}

_CONDITION_LIGHT = {"Kd", "Ki"}
_SOFT_QC = {"aggregator", "fluorescence_interference"}
# Functional / primary-screen readouts (Aaron's UHTS workflow). First-class and
# model-ready in their OWN comparability space — usable, but never silently
# pooled with Ki.
_PRIMARY = {"pct_inhibition", "pct_activity"}   # single-concentration % readout
_POTENCY = {"EC50"}                             # functional potency (molar)
_PERCENT_UNITS = {"%", "pct", "percent"}


def normalize_to_molar(value: Optional[float], unit: Optional[str]) -> Optional[float]:
    """Convert a concentration value to molar. Returns None if not convertible."""
    if value is None or unit is None:
        return None
    mult = _UNIT_TO_M.get(unit.strip())
    if mult is None:
        return None
    return value * mult


def cheng_prusoff_enzyme(ic50_M: float, substrate_conc_M: float, km_M: float) -> float:
    """Ki = IC50 / (1 + [S]/Km) — competitive enzymatic inhibition."""
    return ic50_M / (1.0 + substrate_conc_M / km_M)


def cheng_prusoff_radioligand(ic50_M: float, ligand_conc_M: float, probe_kd_M: float) -> float:
    """Ki = IC50 / (1 + [L]/Kd_probe) — radioligand displacement."""
    return ic50_M / (1.0 + ligand_conc_M / probe_kd_M)


def _affinity_space(readout: str, has_ki: bool) -> str:
    if has_ki:
        return "Ki"  # native Ki or normalized IC50 -> Ki are poolable
    if readout == "Kd":
        return "Kd"
    return readout


def ingest(raw: AssayRecordIn, record_id: Optional[str] = None) -> AssayRecord:
    """Validate, normalize, and classify a single raw assay record."""
    rid = record_id or f"REC-{uuid.uuid4().hex[:8]}"
    missing: list[str] = []

    data = raw.model_dump()
    compound = data["compound"]
    assay = data["assay"]
    cond = data["conditions"]
    meas = data["measurement"]

    # ---- identity -------------------------------------------------------- #
    inchikey = None
    smiles_canonical = None
    compound_id = compound.get("compound_id")
    try:
        ident = identity.resolve(compound["smiles"], compound_id)
        inchikey = ident.inchikey
        smiles_canonical = ident.smiles_canonical
        compound_id = ident.compound_id
    except identity.InvalidSmilesError:
        return _blocked(
            raw, rid, BlockedReason.missing_identity,
            f"Invalid or unparseable SMILES: {compound.get('smiles')!r}",
            ["compound.smiles"],
            smiles_canonical=None, inchikey=None, compound_id=compound_id,
        )

    readout = assay.get("readout")
    unit = assay.get("unit")
    value = assay.get("value")
    construct = assay.get("target_construct")
    qc = (meas.get("qc_flag") or "pass").strip()
    is_primary = readout in _PRIMARY

    # ---- normalize unit -------------------------------------------------- #
    # Primary % readouts are not concentrations; everything else is molar.
    value_M = None if is_primary else normalize_to_molar(value, unit)

    # ---- hard blockers --------------------------------------------------- #
    if not construct:
        missing.append("assay.target_construct")
    if is_primary:
        if not unit or unit.strip() not in _PERCENT_UNITS:
            missing.append("assay.unit")  # a % readout needs a percent unit
    elif not unit:
        missing.append("assay.unit")
    elif value is not None and value_M is None:
        # unit present but unrecognized for a concentration readout
        missing.append("assay.unit")

    if qc == "fail":
        return _blocked(
            raw, rid, BlockedReason.qc_fail,
            "QC failed (qc_flag == 'fail'); measurement is not trustworthy.",
            ["measurement.qc_flag"],
            smiles_canonical=smiles_canonical, inchikey=inchikey, compound_id=compound_id,
        )

    if missing:
        reason = (
            BlockedReason.missing_construct
            if "assay.target_construct" in missing
            else BlockedReason.missing_unit
        )
        detail = "Missing required field(s): " + ", ".join(missing)
        return _blocked(
            raw, rid, reason, detail, missing,
            smiles_canonical=smiles_canonical, inchikey=inchikey, compound_id=compound_id,
        )

    # ---- normalization (Cheng-Prusoff for IC50) -------------------------- #
    ki_M: Optional[float] = None
    if readout == "Ki":
        ki_M = value_M
    elif readout == "IC50":
        ki_M, missing_cond = _derive_ki(assay, cond, value_M)
        if ki_M is None:
            detail = (
                "IC50 present but the conditions required to derive Ki "
                f"are missing: {', '.join(missing_cond)} → cannot derive Ki "
                "(refusing to fabricate a comparable value)."
            )
            return _blocked(
                raw, rid, BlockedReason.missing_conditions, detail, missing_cond,
                smiles_canonical=smiles_canonical, inchikey=inchikey, compound_id=compound_id,
            )
    # Recognized readouts are model-ready in their own comparability space:
    #   Kd/Ki (affinity) · IC50/EC50 (potency) · pct_inhibition/pct_activity
    #   (primary screen). An unrecognized readout can't be compared → blocked.
    _recognized = _CONDITION_LIGHT | _PRIMARY | _POTENCY | {"IC50"}
    if readout not in _recognized and ki_M is None:
        return _blocked(
            raw, rid, BlockedReason.missing_conditions,
            f"Readout {readout!r} is not a recognized comparable "
            "(expected Kd/Ki, IC50/EC50, or pct_inhibition/pct_activity).",
            ["assay.readout"],
            smiles_canonical=smiles_canonical, inchikey=inchikey, compound_id=compound_id,
        )

    # ---- status ---------------------------------------------------------- #
    space = _affinity_space(readout, ki_M is not None)
    comparability_key = f"{construct}::{space}"

    status = RecordStatus.model_ready
    blocked_reason = None
    reason_detail = (
        f"Model-ready: identity resolved, construct + unit present; "
        f"comparable in {space} space."
    )
    if qc in _SOFT_QC:
        status = RecordStatus.normalizable
        reason_detail = (
            f"Usable with caution: soft QC warning ({qc}); comparable in "
            f"{space} space, flagged for review."
        )

    data["compound"] = _with_identity(compound, smiles_canonical, inchikey, compound_id)
    return AssayRecord(
        **data,
        record_id=rid,
        status=status,
        blocked_reason=blocked_reason,
        reason_detail=reason_detail,
        missing_fields=[],
        value_M=value_M,
        ki_M=ki_M,
        comparability_key=comparability_key,
    )


def _derive_ki(assay: dict, cond: dict, value_M: Optional[float]):
    """Return (ki_M or None, missing_condition_fields)."""
    if value_M is None:
        return None, ["assay.value", "assay.unit"]

    assay_type = (assay.get("assay_type") or "").lower()
    s = cond.get("substrate_conc_M")
    km = cond.get("km_M")
    l = cond.get("ligand_conc_M")
    kd = cond.get("probe_kd_M")

    has_enzyme = s is not None and km is not None
    has_radio = l is not None and kd is not None

    # Prefer the mode implied by assay_type; otherwise use whatever is complete.
    if assay_type == "radioligand" or (not has_enzyme and has_radio):
        if has_radio:
            return cheng_prusoff_radioligand(value_M, l, kd), []
        return None, ["conditions.ligand_conc_M", "conditions.probe_kd_M"]

    if assay_type in ("enzymatic_ic50", "enzymatic") or has_enzyme:
        if has_enzyme:
            return cheng_prusoff_enzyme(value_M, s, km), []
        return None, ["conditions.substrate_conc_M", "conditions.km_M"]

    # Mode unknown and nothing complete: report the enzymatic pair as the need.
    return None, ["conditions.substrate_conc_M", "conditions.km_M"]


def _with_identity(compound: dict, canon, ik, cid) -> dict:
    c = dict(compound)
    c["smiles_canonical"] = canon
    c["inchikey"] = ik
    c["compound_id"] = cid
    return c


def _blocked(
    raw: AssayRecordIn,
    rid: str,
    reason: BlockedReason,
    detail: str,
    missing: list[str],
    *,
    smiles_canonical,
    inchikey,
    compound_id,
) -> AssayRecord:
    data = raw.model_dump()
    data["compound"] = _with_identity(data["compound"], smiles_canonical, inchikey, compound_id)
    return AssayRecord(
        **data,
        record_id=rid,
        status=RecordStatus.blocked,
        blocked_reason=reason,
        reason_detail=detail,
        missing_fields=missing,
        value_M=None,
        ki_M=None,
        comparability_key=None,
    )


def pki(ki_M: Optional[float]) -> Optional[float]:
    """pKi = -log10(Ki[M]). Higher = stronger binding. Surrogate target."""
    if ki_M is None or ki_M <= 0:
        return None
    return -math.log10(ki_M)
