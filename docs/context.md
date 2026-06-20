# Context — Closed-Loop Discovery MVP

## The problem
Wet-lab assay data and dry-lab optimization models speak different languages. A
measurement is only useful to a model if it carries enough **semantic metadata**
to be compared and normalized: which construct, which assay, which conditions.
When that metadata is missing, the data is silently dropped or — worse — coerced
into a fabricated comparable value that quietly poisons the model. The bottleneck
is therefore **semantic, not computational**.

This MVP demonstrates a closed Design–Make–Test–Analyze (DMTA) loop in which
assay data, captured with proper semantics, flows cleanly from the wet lab into
the dry-lab optimization loop and is **visible end-to-end**.

## The two-loop architecture
```
                          ┌──────────── inner (compute) loop ────────────┐
                          │                                              │
   substrate ──▶ generator (Boltz design) ──▶ cheap surrogate (ECFP+RF) ─┤
       ▲                                                │                 │
       │                                       acquisition gate (UCB)     │
       │                                   + Boltz screen/ADME re-rank     │
       │                                                │                 │
       │                                                ▼                 │
   ingest/normalize ◀── assay ◀── synthesis queue  ◀── selected batch ◀───┘
       │                                                │
       └──────────── outer (wet-lab) loop ──────────────┘
```
- **Inner loop (compute, fast/cheap):** generator → cheap surrogate → acquisition.
  Runs many times per round, free.
- **Outer loop (wet-lab, slow/expensive):** synthesis → assay → ingest. Runs once
  per round, produces ground truth.
- **The activity store** is the single source of truth feeding both loops, and is
  also the surrogate's training set.

## The oracle ladder (cost tiers)
| Tier | Tool | Latency | Cost | Coverage |
|------|------|---------|------|----------|
| 1 | Local ECFP4 + RandomForest ensemble | ~ms | free | every candidate |
| 2 | Boltz co-folding affinity / ADMET | ~s | metered ($) | shortlist only |
| 3 | Wet-lab assay | days | $$$ | selected batch |

Cheap surrogate ranks everything; Boltz re-ranks only the shortlist that passes
the acquisition gate; the wet lab measures only the final batch. **Boltz affinity
is a ranking proxy (log-µM), never ground truth and never an assay record.**

## Personas
- **Bench scientist** — "Is my result usable? If not, what's missing?" Lives in
  `/records` and `/compound`.
- **ML engineer / comp chemist** — "What is the model trained on, and what does it
  want made next?" Lives in `/acquisition` and `/records`.
- **Engineering manager / project lead** — "Where is the loop stuck, and how fast
  is it turning?" Lives in `/` (overview) and `/metrics`.

## Load-bearing guardrails
1. **Never fabricate comparability.** A missing `Ki` beats a wrong one. Records
   that cannot be normalized are `blocked` with a machine-readable reason.
2. **Predictions ≠ measurements.** Boltz outputs live in a separate `predictions`
   lane, never get `model_ready` status, and are always visually distinct.
3. **Credits are finite.** All Boltz access goes through `boltz_client.py` with
   mock mode, caching, and a hard spend cap. Tests and CI never spend credits.
4. **No reward hacking.** The generator is never optimized against raw Boltz
   affinity; Boltz only ranks for acquisition. An OOD flag warns when a candidate
   is far from the training manifold.

See `spec.md` for the schema, pipeline contracts, and demo script.
