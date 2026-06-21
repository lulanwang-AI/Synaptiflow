"""The ONLY path to the Boltz API.

Interface is FROZEN after Session 1:
    design(target, num_molecules) -> [candidates]
    screen(target, smiles[])      -> [affinity]
    adme(smiles[])                -> [flags]

Every call is gated by:
  * BOLTZ_MOCK=1  -> deterministic canned outputs, no network, no spend.
  * a cache keyed on (target_hash, inchikey, endpoint).
  * a credit guard that estimates per-call cost, tracks cumulative spend, and
    refuses calls past BOLTZ_MAX_SPEND_USD.

The $2,000 launch credit is finite and metered; an ungated inner loop will
exhaust it. Mock mode is fully functional with BOLTZ_API_KEY unset.

NOTE on the live path: the Boltz SDK surface (small_molecule.design / screen /
adme, async start/poll/download) is new and must be confirmed against
api.boltz.bio/docs and pinned before relying on it. The live methods here are
written against the documented shape but are guarded so that, without a key or
SDK, the client raises a clear error rather than spending or crashing. Tests and
CI always run with BOLTZ_MOCK=1.
"""
from __future__ import annotations

import hashlib
import json
import os
import random
from dataclasses import dataclass, field
from typing import Optional

# Per-call cost estimates (USD). Conservative placeholders; confirm live pricing
# at api.boltz.bio. The credit guard is load-bearing, not cosmetic.
COST_DESIGN_PER_MOL = 0.50
COST_SCREEN_PER_MOL = 0.20
COST_ADME_PER_MOL = 0.10


class CreditCapExceeded(RuntimeError):
    """Raised when a Boltz call would push cumulative spend past the cap."""


class BoltzLiveUnavailable(RuntimeError):
    """Raised when a live call is attempted without a key/SDK configured."""


def _env_flag(name: str, default: bool = False) -> bool:
    val = os.environ.get(name)
    if val is None:
        return default
    return val.strip().lower() in {"1", "true", "yes", "on"}


def _target_hash(target) -> str:
    seq = getattr(target, "protein_sequence", "") or ""
    pocket = ",".join(str(r) for r in (getattr(target, "pocket_residues", []) or []))
    return hashlib.sha1(f"{seq}|{pocket}".encode()).hexdigest()[:12]


def _seed_from(*parts: str) -> int:
    return int(hashlib.sha1("|".join(parts).encode()).hexdigest()[:8], 16)


# A small canned library of drug-like SMILES for deterministic mock design.
_MOCK_LIBRARY = [
    "Cc1ccc(cc1)S(=O)(=O)N",
    "CC(=O)Oc1ccccc1C(=O)O",
    "CC(C)Cc1ccc(cc1)C(C)C(=O)O",
    "Clc1ccccc1C2=NCC(=O)Nc3ccc(cc23)N(=O)=O",
    "COc1ccc2cc(ccc2c1)C(C)C(=O)O",
    "CN1C=NC2=C1C(=O)N(C(=O)N2C)C",
    "CC(C)(C)NCC(O)c1ccc(O)c(O)c1",
    "OC(=O)c1ccccc1Nc1ccccc1",
    "CC(=O)Nc1ccc(O)cc1",
    "Cn1cnc2c1c(=O)n(C)c(=O)n2C",
    "CCN(CC)CCNC(=O)c1ccc(N)cc1",
    "Clc1ccc2Sc3ccccc3N(CCCN4CCN(C)CC4)c2c1",
    "CC1(C)SC2C(NC(=O)Cc3ccccc3)C(=O)N2C1C(=O)O",
    "Fc1ccc(cc1)C(=O)CCCN1CCC(O)(CC1)c1ccc(Cl)cc1",
    "CN1CCC[C@H]1c1cccnc1",
    "CC(C)NCC(O)COc1cccc2ccccc12",
    "Nc1ncnc2n(cnc12)[C@@H]1O[C@H](CO)[C@@H](O)[C@H]1O",
    "OCC1OC(O)C(O)C(O)C1O",
    "CC1=C(C(=O)Nc2ccccc2)Sc2ccccc21",
    "COc1cc2c(cc1OC)C(=O)C(CC2)Cc1ccccc1",
]

_ADME_FLAG_POOL = [
    "hERG_risk",
    "CYP3A4_inhibition",
    "low_solubility",
    "high_clearance",
    "PAINS_alert",
    "high_logP",
]


@dataclass
class BoltzClient:
    api_key: Optional[str] = None
    mock: bool = False
    max_spend_usd: float = 50.0
    spent_usd: float = 0.0
    _cache: dict = field(default_factory=dict)

    @classmethod
    def from_env(cls) -> "BoltzClient":
        return cls(
            api_key=os.environ.get("BOLTZ_API_KEY"),
            mock=_env_flag("BOLTZ_MOCK", default=False),
            max_spend_usd=float(os.environ.get("BOLTZ_MAX_SPEND_USD", "50")),
        )

    # ------------------------------------------------------------------ #
    # Credit guard
    # ------------------------------------------------------------------ #
    def _guard(self, estimated_cost: float) -> None:
        """Refuse the call if it would push spend past the cap. Mock = free."""
        if self.mock:
            return
        if self.spent_usd + estimated_cost > self.max_spend_usd:
            raise CreditCapExceeded(
                f"Boltz call (~${estimated_cost:.2f}) would exceed cap "
                f"${self.max_spend_usd:.2f} (spent ${self.spent_usd:.2f}). "
                f"Refusing to spend."
            )

    def _charge(self, cost: float) -> None:
        if not self.mock:
            self.spent_usd += cost

    # ------------------------------------------------------------------ #
    # FROZEN interface
    # ------------------------------------------------------------------ #
    def design(self, target, num_molecules: int) -> list[dict]:
        """Propose `num_molecules` candidate SMILES against the target pocket.

        Returns: [{smiles, design_run_id}, ...]
        """
        th = _target_hash(target)
        cache_key = ("design", th, num_molecules)
        if cache_key in self._cache:
            return self._cache[cache_key]

        est = COST_DESIGN_PER_MOL * num_molecules
        self._guard(est)

        if self.mock:
            out = self._mock_design(target, num_molecules, th)
        else:
            out = self._live_design(target, num_molecules, th)
            self._charge(est)

        self._cache[cache_key] = out
        return out

    @staticmethod
    def _ik_or_self(smi: str) -> str:
        from .identity import inchikey as _ik

        try:
            return _ik(smi)
        except Exception:
            return smi

    def screen(self, target, smiles: list[str]) -> list[dict]:
        """Affinity proxy (log-µM) per SMILES. Cached per (target, inchikey).

        Returns one result per input SMILES, aligned to input order.
        """
        th = _target_hash(target)
        keys = [("screen", th, self._ik_or_self(smi)) for smi in smiles]
        to_compute = [smi for smi, k in zip(smiles, keys) if k not in self._cache]

        if to_compute:
            est = COST_SCREEN_PER_MOL * len(to_compute)
            self._guard(est)
            if self.mock:
                computed = self._mock_screen(target, to_compute, th)
            else:
                computed = self._live_screen(target, to_compute, th)
                self._charge(est)
            for smi, res in zip(to_compute, computed):
                self._cache[("screen", th, self._ik_or_self(smi))] = res

        return [self._cache[k] for k in keys]

    def adme(self, smiles: list[str]) -> list[dict]:
        """ADMET flags per SMILES. Cached per inchikey (target-independent).

        Returns one result per input SMILES, aligned to input order.
        """
        keys = [("adme", self._ik_or_self(smi)) for smi in smiles]
        to_compute = [smi for smi, k in zip(smiles, keys) if k not in self._cache]

        if to_compute:
            est = COST_ADME_PER_MOL * len(to_compute)
            self._guard(est)
            if self.mock:
                computed = self._mock_adme(to_compute)
            else:
                computed = self._live_adme(to_compute)
                self._charge(est)
            for smi, res in zip(to_compute, computed):
                self._cache[("adme", self._ik_or_self(smi))] = res

        return [self._cache[k] for k in keys]
        return results

    # ------------------------------------------------------------------ #
    # Deterministic mock implementations
    # ------------------------------------------------------------------ #
    def _mock_design(self, target, num_molecules: int, th: str) -> list[dict]:
        rng = random.Random(_seed_from("design", th, str(num_molecules)))
        pool = list(_MOCK_LIBRARY)
        rng.shuffle(pool)
        n = min(num_molecules, len(pool))
        run_id = f"design-{th}-{num_molecules}"
        return [{"smiles": pool[i], "design_run_id": run_id} for i in range(n)]

    def _mock_screen(self, target, smiles: list[str], th: str) -> list[dict]:
        out = []
        for smi in smiles:
            rng = random.Random(_seed_from("screen", th, smi))
            # log-µM affinity proxy; lower = stronger binding. Range ~ [-3, 3].
            aff = round(rng.uniform(-3.0, 2.5), 3)
            out.append({"smiles": smi, "boltz_affinity_loguM": aff})
        return out

    def _mock_adme(self, smiles: list[str]) -> list[dict]:
        out = []
        for smi in smiles:
            rng = random.Random(_seed_from("adme", smi))
            flags = [f for f in _ADME_FLAG_POOL if rng.random() < 0.18]
            out.append({"smiles": smi, "adme_flags": flags})
        return out

    # ------------------------------------------------------------------ #
    # Live implementations (guarded; confirm signatures at api.boltz.bio/docs)
    # ------------------------------------------------------------------ #
    def _client(self):
        if not self.api_key:
            raise BoltzLiveUnavailable(
                "BOLTZ_API_KEY is not set and BOLTZ_MOCK is off. Set BOLTZ_MOCK=1 "
                "to run without spending, or provide a key for live calls."
            )
        try:
            from boltz_api import Boltz  # type: ignore
        except Exception as exc:  # pragma: no cover - depends on optional SDK
            raise BoltzLiveUnavailable(
                "boltz_api SDK not installed. `pip install boltz_api` and confirm "
                "the design/screen/adme signatures at api.boltz.bio/docs."
            ) from exc
        return Boltz(api_key=self.api_key)

    def _live_design(self, target, num_molecules: int, th: str) -> list[dict]:  # pragma: no cover
        client = self._client()
        job = client.small_molecule.design.start(
            target={
                "protein_sequence": target.protein_sequence,
                "chain_ids": target.chain_ids,
                "pocket_residues": target.pocket_residues,
            },
            num_molecules=num_molecules,
        )
        res = job.download_results()
        return [
            {"smiles": m["smiles"], "design_run_id": getattr(job, "run_id", f"design-{th}")}
            for m in res
        ]

    def _live_screen(self, target, smiles: list[str], th: str) -> list[dict]:  # pragma: no cover
        client = self._client()
        job = client.small_molecule.screen.start(
            target={
                "protein_sequence": target.protein_sequence,
                "chain_ids": target.chain_ids,
                "pocket_residues": target.pocket_residues,
            },
            smiles=smiles,
        )
        res = job.download_results()
        return [
            {"smiles": r["smiles"], "boltz_affinity_loguM": r["affinity_loguM"]}
            for r in res
        ]

    def _live_adme(self, smiles: list[str]) -> list[dict]:  # pragma: no cover
        client = self._client()
        job = client.small_molecule.adme.start(smiles=smiles)
        res = job.download_results()
        return [{"smiles": r["smiles"], "adme_flags": r.get("flags", [])} for r in res]


# Process-wide singleton so cache and cumulative spend persist across requests.
_CLIENT: Optional[BoltzClient] = None


def get_client() -> BoltzClient:
    global _CLIENT
    if _CLIENT is None:
        _CLIENT = BoltzClient.from_env()
    return _CLIENT


def reset_client() -> None:
    """Reset the singleton (used by tests / seed reset)."""
    global _CLIENT
    _CLIENT = None
