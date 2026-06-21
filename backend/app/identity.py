"""Real RDKit identity layer.

Canonical SMILES and InChIKey are the stable join/dedup keys. Invalid SMILES
must fail gracefully with a typed error, never crash the ingest path.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from rdkit import Chem, RDLogger

# RDKit is noisy on parse failures; we handle errors ourselves.
RDLogger.DisableLog("rdApp.*")


class InvalidSmilesError(ValueError):
    """Raised when a SMILES string cannot be parsed by RDKit."""

    def __init__(self, smiles: str):
        self.smiles = smiles
        super().__init__(f"Invalid SMILES: {smiles!r}")


def _mol(smiles: str) -> Chem.Mol:
    if smiles is None or not str(smiles).strip():
        raise InvalidSmilesError(smiles)
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        raise InvalidSmilesError(smiles)
    return mol


def canonicalize(smiles: str) -> str:
    """Return RDKit canonical SMILES. Idempotent."""
    return Chem.MolToSmiles(_mol(smiles))


def inchikey(smiles: str) -> str:
    """Return the InChIKey — the stable cross-toolkit join/dedup key."""
    return Chem.MolToInchiKey(_mol(smiles))


@dataclass
class Identity:
    smiles_canonical: str
    inchikey: str
    compound_id: str


# In-process registry mapping InChIKey -> assigned compound_id, so the same
# structure always dedups to one id regardless of input SMILES spelling.
_registry: dict[str, str] = {}
_counter = {"n": 0}


def _next_compound_id() -> str:
    _counter["n"] += 1
    return f"CMP-{_counter['n']:06d}"


def reset_registry() -> None:
    """Clear the in-process identity registry (used by tests / seed reset)."""
    _registry.clear()
    _counter["n"] = 0


def resolve(smiles: str, compound_id: Optional[str] = None) -> Identity:
    """Canonicalize, derive InChIKey, dedup on InChIKey, assign a compound_id.

    If a compound_id is supplied for a new InChIKey it is honoured; otherwise a
    new id is minted. The same InChIKey always maps to the same id.
    """
    key = inchikey(smiles)
    canon = canonicalize(smiles)

    if key in _registry:
        cid = _registry[key]
    else:
        cid = compound_id or _next_compound_id()
        _registry[key] = cid

    return Identity(smiles_canonical=canon, inchikey=key, compound_id=cid)
