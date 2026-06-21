"""Cheap surrogate — the free inner-loop ranker (spec §2 stage 5).

ECFP4 fingerprints + a RandomForest ensemble → (mu, sigma) per SMILES, where
sigma is the std across trees (real ensemble variance), NOT a constant. Trained
on model-ready Ki/Kd data (as pKi). Falls back to a clearly-documented mock when
training points are below threshold.

Honest extrapolation: sigma genuinely grows for candidates far from the training
manifold (forest disagreement), and a separate nearest-neighbour Tanimoto gives
the OOD flag used by acquisition.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Optional

import numpy as np
from rdkit import Chem, DataStructs
from rdkit.Chem import AllChem

MIN_TRAIN_POINTS = 8
N_BITS = 2048
RADIUS = 2  # ECFP4
OOD_TANIMOTO_THRESHOLD = 0.30

_morgan = AllChem.GetMorganGenerator(radius=RADIUS, fpSize=N_BITS)


def fingerprint(smiles: str):
    """Return an RDKit ExplicitBitVect ECFP4 fingerprint, or None if invalid."""
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return None
    return _morgan.GetFingerprint(mol)


def _fp_array(fp) -> np.ndarray:
    arr = np.zeros((N_BITS,), dtype=np.int8)
    DataStructs.ConvertToNumpyArray(fp, arr)
    return arr


def max_tanimoto(fp, train_fps: list) -> float:
    if not train_fps:
        return 0.0
    sims = DataStructs.BulkTanimotoSimilarity(fp, train_fps)
    return max(sims) if sims else 0.0


@dataclass
class Score:
    smiles: str
    mu: float
    sigma: float
    ood_flag: bool
    nn_tanimoto: float


class Surrogate:
    """RandomForest ensemble over ECFP4. mu = mean tree pred, sigma = tree std."""

    def __init__(self):
        self.model = None
        self.train_fps: list = []
        self.is_mock = True
        self.n_train = 0

    def fit(self, data: list[tuple[str, float]]) -> None:
        """data = [(canonical_smiles, pKi), ...]."""
        X, y, fps = [], [], []
        for smi, target in data:
            fp = fingerprint(smi)
            if fp is None:
                continue
            X.append(_fp_array(fp))
            y.append(target)
            fps.append(fp)

        self.train_fps = fps
        self.n_train = len(X)

        if len(X) < MIN_TRAIN_POINTS:
            self.model = None
            self.is_mock = True
            return

        from sklearn.ensemble import RandomForestRegressor

        self.model = RandomForestRegressor(
            n_estimators=200, max_features="sqrt", random_state=0, n_jobs=-1
        )
        self.model.fit(np.array(X), np.array(y))
        self.is_mock = False

    def predict(self, smiles: str) -> Score:
        fp = fingerprint(smiles)
        if fp is None:
            return Score(smiles=smiles, mu=0.0, sigma=99.0, ood_flag=True, nn_tanimoto=0.0)

        nn = max_tanimoto(fp, self.train_fps)
        ood = nn < OOD_TANIMOTO_THRESHOLD

        if self.is_mock or self.model is None:
            return self._mock_predict(smiles, nn, ood)

        x = _fp_array(fp).reshape(1, -1)
        preds = np.array([t.predict(x)[0] for t in self.model.estimators_])
        mu = float(preds.mean())
        sigma = float(preds.std())
        # Far-from-manifold candidates: inflate sigma so honesty about
        # extrapolation survives even when trees happen to agree.
        sigma = sigma + (1.0 - nn) * 0.5
        return Score(smiles=smiles, mu=round(mu, 3), sigma=round(sigma, 3),
                     ood_flag=ood, nn_tanimoto=round(nn, 3))

    def _mock_predict(self, smiles: str, nn: float, ood: bool) -> Score:
        """Deterministic fallback when training data is too sparse."""
        h = int(hashlib.sha1(smiles.encode()).hexdigest()[:8], 16)
        mu = 5.0 + (h % 1000) / 1000.0 * 4.0  # pKi in [5, 9]
        sigma = 1.5 + (1.0 - nn) * 0.5  # deliberately wide: we don't really know
        return Score(smiles=smiles, mu=round(mu, 3), sigma=round(sigma, 3),
                     ood_flag=ood, nn_tanimoto=round(nn, 3))


# Process-wide singleton, refit on demand from the store.
_SURROGATE: Optional[Surrogate] = None


def get_surrogate() -> Surrogate:
    global _SURROGATE
    if _SURROGATE is None:
        _SURROGATE = Surrogate()
    return _SURROGATE


def train_from_store(store) -> Surrogate:
    sur = get_surrogate()
    sur.fit(store.model_ready_dataset())
    return sur


def reset_surrogate() -> None:
    global _SURROGATE
    _SURROGATE = None
