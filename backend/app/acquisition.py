"""Acquisition + Boltz oracle re-rank (spec §2 stage 6).

Two-tier gate:
  (a) cheap-surrogate UCB  alpha = mu + beta*sigma  → shortlist of top-m
  (b) boltz_client.screen + adme score the shortlist ONLY (cached, credit-guarded);
      outputs written to the PREDICTIONS lane (never assay records)
  (c) final batch = top-k by combined affinity + ADMET, each tagged
      exploit/explore with an OOD flag and a rationale.

REWARD-HACKING GUARD: the generator is never optimized against raw Boltz
affinity. Boltz only ranks for acquisition; the OOD flag warns when a candidate
is far from the training manifold.
"""
from __future__ import annotations

from typing import Optional

from .boltz_client import get_client
from .generator import design
from .schema import (
    AcquisitionBatch,
    AcquisitionCandidate,
    Prediction,
    PredictionProvenance,
)
from .store import get_store
from .surrogate import get_surrogate, train_from_store

BETA = 1.0  # UCB exploration weight


def _combined(boltz_affinity: Optional[float], adme_flags: list[str]) -> float:
    """Higher is better. Lower (more negative) log-µM affinity = stronger binding;
    each ADMET liability subtracts."""
    aff_term = -(boltz_affinity if boltz_affinity is not None else 0.0)
    return aff_term - 0.5 * len(adme_flags)


def build_batch(
    target,
    num_molecules: int = 12,
    shortlist_m: int = 6,
    final_k: int = 4,
) -> AcquisitionBatch:
    store = get_store()
    surrogate = train_from_store(store)

    # ---- generate ---- #
    candidates = design(target, num_molecules)
    store.set_counter("generated", len(candidates))

    # ---- cheap surrogate scores every candidate (free) ---- #
    scored = []
    for c in candidates:
        s = surrogate.predict(c["smiles"])
        scored.append((c, s))
    store.set_counter("scored", len(scored))

    # ---- UCB shortlist (cheap tier) ---- #
    scored.sort(key=lambda cs: cs[1].mu + BETA * cs[1].sigma, reverse=True)
    shortlist = scored[:shortlist_m]

    # ---- Boltz re-rank on the shortlist ONLY (metered, cached) ---- #
    smis = [c["smiles"] for c, _ in shortlist]
    client = get_client()
    affinities = {r["smiles"]: r["boltz_affinity_loguM"] for r in client.screen(target, smis)}
    admes = {r["smiles"]: r["adme_flags"] for r in client.adme(smis)}

    sigmas = [s.sigma for _, s in shortlist]
    sigma_med = sorted(sigmas)[len(sigmas) // 2] if sigmas else 0.0

    enriched = []
    for c, s in shortlist:
        smi = c["smiles"]
        aff = affinities.get(smi)
        flags = admes.get(smi, [])

        # write to predictions lane (NEVER an assay record)
        store.upsert_prediction(
            Prediction(
                smiles=smi,
                inchikey=c["inchikey"],
                boltz_affinity_loguM=aff if aff is not None else 0.0,
                adme_flags=flags,
                ood_flag=s.ood_flag,
                provenance=PredictionProvenance(run_id=c.get("design_run_id")),
            )
        )

        tag = "explore" if (s.ood_flag or s.sigma >= sigma_med) else "exploit"
        rationale = (
            f"surrogate pKi {s.mu:.2f}±{s.sigma:.2f}; "
            f"Boltz affinity {aff:.2f} log-µM; "
            f"{len(flags)} ADMET flag(s); "
            f"NN Tanimoto {s.nn_tanimoto:.2f}"
            + (" — OOD: far from training manifold, treat affinity with caution"
               if s.ood_flag else "")
            + (f" — {tag} (high uncertainty)" if tag == "explore"
               else f" — {tag} (high predicted potency)")
        )
        enriched.append(
            (
                AcquisitionCandidate(
                    smiles=smi,
                    inchikey=c["inchikey"],
                    mu=s.mu,
                    sigma=s.sigma,
                    boltz_affinity=aff,
                    adme_flags=flags,
                    ood_flag=s.ood_flag,
                    tag=tag,
                    rationale=rationale,
                    design_run_id=c.get("design_run_id"),
                ),
                _combined(aff, flags),
            )
        )

    enriched.sort(key=lambda ec: ec[1], reverse=True)
    final = [ec[0] for ec in enriched[:final_k]]

    return AcquisitionBatch(
        target_name=getattr(target, "name", None),
        generated=len(candidates),
        scored=len(scored),
        shortlisted=len(shortlist),
        candidates=final,
    )
