"""NVIDIA NIM client — the structure-based generative-screening tier.

Wraps the three NIM microservices behind ONE interface (same shape as
boltz_client.py):

    fold(target)               -> {plddt, pocket_residues, model}      (AlphaFold2)
    generate(target, n, ref?)  -> [{smiles}, ...]                      (MolMIM)
    dock(target, smiles[])     -> [{smiles, dock_confidence, model}]   (DiffDock)

Every call is gated by:
  * NIM_MOCK=1 (DEFAULT) -> deterministic canned outputs, no network.
  * a cache keyed on (endpoint, target_hash, payload).
  * a live path guarded so that, without NVIDIA_API_KEY, it raises a clear
    error rather than crashing or hanging.

This is the fold -> generate -> dock tier. The Boltz oracle (BoltzMol) is a
separate, complementary tier and is unchanged — see boltz_client.py. By default
the generator still uses BoltzMol; MolMIM is opt-in via GENERATOR_ENGINE=molmim.

NOTE: the exact NIM endpoints and request/response schemas must be confirmed at
build.nvidia.com and pinned before relying on the live path. The live methods
here target a plausible shape, are guarded, and are marked no-cover; tests and
CI always run in mock mode.
"""
from __future__ import annotations

import hashlib
import os
import random
from dataclasses import dataclass, field
from typing import Optional


class NimLiveUnavailable(RuntimeError):
    """Raised when a live NIM call is attempted without an API key configured."""


def _env_flag(name: str, default: bool = False) -> bool:
    val = os.environ.get(name)
    if val is None:
        return default
    return val.strip().lower() in {"1", "true", "yes", "on"}


def _target_hash(target) -> str:
    seq = getattr(target, "protein_sequence", "") or ""
    pocket = ",".join(str(r) for r in (getattr(target, "pocket_residues", []) or []))
    return hashlib.sha1(f"{seq}|{pocket}".encode()).hexdigest()[:12]


def _seed(*parts: str) -> int:
    return int(hashlib.sha1("|".join(parts).encode()).hexdigest()[:8], 16)


# Small canned library for deterministic mock generation (MolMIM stand-in).
_MOCK_GEN_LIBRARY = [
    "Cc1ccc(cc1)S(=O)(=O)Nc1ncccn1",
    "O=C(Nc1ccc(F)cc1)c1cncc(c1)C#N",
    "COc1ccc(cc1)CNc1nccc(n1)c1ccccc1",
    "Clc1ccc(cc1)C2=NN=C(S2)c3ccccc3N",
    "CC1(C)Cc2c(O1)ccc(c2)C(=O)Nc1ccncc1",
    "Cc1ccc(cc1)S(=O)(=O)N",
    "CC(=O)Oc1ccccc1C(=O)O",
    "CC(C)Cc1ccc(cc1)C(C)C(=O)O",
    "COc1ccc2cc(ccc2c1)C(C)C(=O)O",
    "CN1C=NC2=C1C(=O)N(C(=O)N2C)C",
    "OC(=O)c1ccccc1Nc1ccccc1",
    "CC(=O)Nc1ccc(O)cc1",
]

# Hosted-NIM base endpoints (override via env). Confirm/pin at build.nvidia.com.
DEFAULT_URLS = {
    "alphafold2": "https://health.api.nvidia.com/v1/biology/deepmind/alphafold2",
    "molmim": "https://health.api.nvidia.com/v1/biology/nvidia/molmim/generate",
    "diffdock": "https://health.api.nvidia.com/v1/biology/mit/diffdock",
}


@dataclass
class NimClient:
    api_key: Optional[str] = None
    mock: bool = True
    urls: dict = field(default_factory=lambda: dict(DEFAULT_URLS))
    _cache: dict = field(default_factory=dict)

    @classmethod
    def from_env(cls) -> "NimClient":
        return cls(
            api_key=os.environ.get("NVIDIA_API_KEY") or os.environ.get("NIM_API_KEY"),
            mock=_env_flag("NIM_MOCK", default=True),
            urls={
                "alphafold2": os.environ.get("NIM_ALPHAFOLD2_URL", DEFAULT_URLS["alphafold2"]),
                "molmim": os.environ.get("NIM_MOLMIM_URL", DEFAULT_URLS["molmim"]),
                "diffdock": os.environ.get("NIM_DIFFDOCK_URL", DEFAULT_URLS["diffdock"]),
            },
        )

    # ------------------------------------------------------------------ #
    # Interface
    # ------------------------------------------------------------------ #
    def fold(self, target) -> dict:
        """Predict structure (AlphaFold2). Returns {plddt, pocket_residues, model}."""
        th = _target_hash(target)
        key = ("fold", th)
        if key not in self._cache:
            self._cache[key] = self._mock_fold(target, th) if self.mock else self._live_fold(target)
        return self._cache[key]

    def generate(self, target, num_molecules: int, reference_smiles: Optional[str] = None) -> list[dict]:
        """Generate candidate SMILES (MolMIM). Returns [{smiles}, ...]."""
        th = _target_hash(target)
        key = ("generate", th, num_molecules, reference_smiles or "")
        if key not in self._cache:
            self._cache[key] = (
                self._mock_generate(target, num_molecules, th)
                if self.mock
                else self._live_generate(target, num_molecules, reference_smiles)
            )
        return self._cache[key]

    def dock(self, target, smiles: list[str]) -> list[dict]:
        """Dock each SMILES (DiffDock). Returns one result per input, aligned."""
        th = _target_hash(target)
        keys = [("dock", th, s) for s in smiles]
        todo = [s for s, k in zip(smiles, keys) if k not in self._cache]
        if todo:
            computed = self._mock_dock(target, todo, th) if self.mock else self._live_dock(target, todo)
            for s, r in zip(todo, computed):
                self._cache[("dock", th, s)] = r
        return [self._cache[k] for k in keys]

    def pose(self, target, smiles: str) -> dict:
        """3-D docked pose for one ligand (DiffDock). Returns {smiles, sdf, model}.

        Mock generates a real RDKit 3-D conformer (the ligand pose); the live
        path returns the DiffDock-docked pose.
        """
        key = ("pose", smiles)
        if key not in self._cache:
            self._cache[key] = (
                self._mock_pose(smiles) if self.mock else self._live_pose(target, smiles)
            )
        return self._cache[key]

    # ------------------------------------------------------------------ #
    # Deterministic mock implementations
    # ------------------------------------------------------------------ #
    def _mock_fold(self, target, th: str) -> dict:
        rng = random.Random(_seed("fold", th))
        plddt = round(72.0 + rng.random() * 23.0, 1)  # 72.0–95.0
        pocket = list(getattr(target, "pocket_residues", []) or [])
        if not pocket:
            length = len(getattr(target, "protein_sequence", "") or "") or 320
            pocket = sorted({rng.randint(1, max(2, length - 1)) for _ in range(8)})
        pdb = self._mock_receptor_pdb(getattr(target, "protein_sequence", "") or "")
        return {"plddt": plddt, "pocket_residues": pocket, "model": "alphafold2", "pdb": pdb}

    def _mock_receptor_pdb(self, sequence: str) -> Optional[str]:
        """An illustrative 3-D receptor fragment (first residues) via RDKit.

        Real AlphaFold2 returns the full predicted structure; in mock mode we
        build a short, real 3-D peptide fragment so the pose viewer has receptor
        context. Long proteins are truncated for speed; returns None on failure.
        """
        frag = "".join(c for c in sequence.upper() if c in "ACDEFGHIKLMNPQRSTVWY")[:14]
        if len(frag) < 4:
            return None
        try:
            from rdkit import Chem
            from rdkit.Chem import AllChem

            mol = Chem.MolFromSequence(frag)
            if mol is None:
                return None
            mol = Chem.AddHs(mol)
            params = AllChem.ETKDGv3()
            params.randomSeed = _seed("fold-pdb", frag) % (2**31)
            if AllChem.EmbedMolecule(mol, params) != 0:
                if AllChem.EmbedMolecule(mol, useRandomCoords=True, randomSeed=params.randomSeed) != 0:
                    return None
            mol = Chem.RemoveHs(mol)
            return Chem.MolToPDBBlock(mol)
        except Exception:  # pragma: no cover - defensive
            return None

    def _mock_generate(self, target, num_molecules: int, th: str) -> list[dict]:
        rng = random.Random(_seed("molmim", th, str(num_molecules)))
        pool = list(_MOCK_GEN_LIBRARY)
        rng.shuffle(pool)
        return [{"smiles": pool[i]} for i in range(min(num_molecules, len(pool)))]

    def _mock_dock(self, target, smiles: list[str], th: str) -> list[dict]:
        out = []
        for s in smiles:
            rng = random.Random(_seed("diffdock", th, s))
            conf = round(0.40 + rng.random() * 0.55, 3)  # 0.40–0.95
            out.append({"smiles": s, "dock_confidence": conf, "model": "diffdock"})
        return out

    def _mock_pose(self, smiles: str) -> dict:
        """Real 3-D ligand conformer via RDKit (deterministic), as an SDF molblock."""
        try:
            from rdkit import Chem
            from rdkit.Chem import AllChem
        except Exception:  # pragma: no cover - rdkit is a backend dependency
            return {"smiles": smiles, "sdf": None, "model": "diffdock"}
        mol = Chem.MolFromSmiles(smiles)
        if mol is None:
            return {"smiles": smiles, "sdf": None, "model": "diffdock"}
        mol = Chem.AddHs(mol)
        params = AllChem.ETKDGv3()
        params.randomSeed = _seed("pose", smiles) % (2**31)
        if AllChem.EmbedMolecule(mol, params) != 0:
            if AllChem.EmbedMolecule(mol, useRandomCoords=True, randomSeed=params.randomSeed) != 0:
                return {"smiles": smiles, "sdf": None, "model": "diffdock"}
        try:
            AllChem.MMFFOptimizeMolecule(mol)
        except Exception:  # pragma: no cover - optimizer can fail for exotic atoms
            pass
        return {"smiles": smiles, "sdf": Chem.MolToMolBlock(mol), "model": "diffdock"}

    # ------------------------------------------------------------------ #
    # Live implementations (guarded; confirm schemas at build.nvidia.com)
    # ------------------------------------------------------------------ #
    def _client(self):
        if not self.api_key:
            raise NimLiveUnavailable(
                "NVIDIA_API_KEY is not set and NIM_MOCK is off. Set NIM_MOCK=1 to "
                "run without network, or provide a key for live NIM calls."
            )
        import httpx  # httpx is a backend dependency

        return httpx.Client(
            timeout=120.0, headers={"Authorization": f"Bearer {self.api_key}"}
        )

    def _live_fold(self, target) -> dict:  # pragma: no cover - needs key + network
        with self._client() as c:
            resp = c.post(self.urls["alphafold2"], json={"sequence": target.protein_sequence})
            resp.raise_for_status()
            data = resp.json()
        plddt = float(data.get("plddt") or data.get("mean_plddt") or 0.0)
        return {
            "plddt": round(plddt, 1),
            "pocket_residues": list(getattr(target, "pocket_residues", []) or []),
            "model": "alphafold2",
            "pdb": data.get("pdb") or data.get("structure"),
        }

    def _live_generate(self, target, num_molecules, reference_smiles) -> list[dict]:  # pragma: no cover
        payload: dict = {"num_molecules": int(num_molecules)}
        if reference_smiles:
            payload["smi"] = reference_smiles
        with self._client() as c:
            resp = c.post(self.urls["molmim"], json=payload)
            resp.raise_for_status()
            data = resp.json()
        mols = data.get("molecules") or data.get("generated") or []
        out = []
        for m in mols:
            smi = m.get("smiles") if isinstance(m, dict) else m
            if smi:
                out.append({"smiles": smi})
        return out

    def _live_dock(self, target, smiles: list[str]) -> list[dict]:  # pragma: no cover
        out = []
        with self._client() as c:
            for s in smiles:
                resp = c.post(
                    self.urls["diffdock"],
                    json={"protein_sequence": target.protein_sequence, "ligand": s},
                )
                resp.raise_for_status()
                data = resp.json()
                conf = data.get("confidence", 0.0)
                if isinstance(conf, list):
                    conf = conf[0] if conf else 0.0
                out.append({"smiles": s, "dock_confidence": round(float(conf), 3), "model": "diffdock"})
        return out

    def _live_pose(self, target, smiles: str) -> dict:  # pragma: no cover
        seq = getattr(target, "protein_sequence", "") if target else ""
        with self._client() as c:
            resp = c.post(
                self.urls["diffdock"],
                json={"protein_sequence": seq, "ligand": smiles, "return_pose": True},
            )
            resp.raise_for_status()
            data = resp.json()
        sdf = data.get("pose_sdf") or data.get("sdf")
        return {"smiles": smiles, "sdf": sdf, "model": "diffdock"}


# Process-wide singleton so the cache persists across requests.
_NIM: Optional[NimClient] = None


def get_nim_client() -> NimClient:
    global _NIM
    if _NIM is None:
        _NIM = NimClient.from_env()
    return _NIM


def reset_nim_client() -> None:
    """Reset the singleton (used by tests / seed reset)."""
    global _NIM
    _NIM = None
