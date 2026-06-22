"""Generator — Boltz `small_molecule.design` (spec §2 stage 4).

Calls boltz_client.design(target, num_molecules) for the demo Target,
canonicalizes returned SMILES through identity, and dedups on InChIKey. Runs
once per DMTA round; `num_molecules` is small in the demo (cost).

All Boltz access goes through boltz_client — never elsewhere.

GENERATOR_ENGINE selects the generator: "boltz" (BoltzMol, the default) or
"molmim" (the NVIDIA NIM, via nim_client). BoltzMol stays the default so the
existing pipeline is unchanged unless explicitly opted in.
"""
from __future__ import annotations

import os

from . import identity
from .boltz_client import get_client
from .nim_client import get_nim_client


def design(target, num_molecules: int = 12) -> list[dict]:
    """Return deduped candidates [{smiles, inchikey, design_run_id}]."""
    engine = os.environ.get("GENERATOR_ENGINE", "boltz").strip().lower()
    if engine == "molmim":
        raw = [
            {"smiles": m["smiles"], "design_run_id": "molmim"}
            for m in get_nim_client().generate(target, num_molecules)
        ]
    else:
        raw = get_client().design(target, num_molecules)  # BoltzMol (default)
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
