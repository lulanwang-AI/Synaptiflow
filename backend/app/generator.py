"""Generator — Boltz `small_molecule.design` (spec §2 stage 4).

Calls boltz_client.design(target, num_molecules) for the demo Target,
canonicalizes returned SMILES through identity, and dedups on InChIKey. Runs
once per DMTA round; `num_molecules` is small in the demo (cost).

All Boltz access goes through boltz_client — never elsewhere.
"""
from __future__ import annotations

from . import identity
from .boltz_client import get_client


def design(target, num_molecules: int = 12) -> list[dict]:
    """Return deduped candidates [{smiles, inchikey, design_run_id}]."""
    raw = get_client().design(target, num_molecules)
    seen: set[str] = set()
    out: list[dict] = []
    for cand in raw:
        smi = cand["smiles"]
        try:
            ident = identity.resolve(smi)
        except identity.InvalidSmilesError:
            continue
        if ident.inchikey in seen:
            continue
        seen.add(ident.inchikey)
        out.append(
            {
                "smiles": ident.smiles_canonical,
                "inchikey": ident.inchikey,
                "design_run_id": cand.get("design_run_id"),
            }
        )
    return out
