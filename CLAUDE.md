# CLAUDE.md — cross-session rules

This repo is the Closed-Loop Discovery MVP. Read `docs/context.md` and
`docs/spec.md` before changing anything.

## Frozen contract (do not break)
- **API route signatures and response models** (`backend/app/api/` +
  `backend/app/schema.py`) are FROZEN. Implement internals; never change a route
  shape or a response model field. The frontend builds against
  `docs/openapi.json`.
- **`backend/app/boltz_client.py` interface is FROZEN:**
  `design(target, num_molecules)`, `screen(target, smiles[])`, `adme(smiles[])`.
  Change the implementations, not the signatures.
- If you must evolve the contract, regenerate `docs/openapi.json`
  (`python backend/export_openapi.py`) and say so explicitly.

## Non-negotiable product rules
- **Affinity values are never coerced.** A missing `Ki` beats a fabricated one.
  An `IC50` without the conditions to derive `Ki` is `blocked: missing_conditions`,
  never guessed.
- **Boltz outputs are PREDICTIONS, never assay records.** They live in the
  separate `predictions` lane, never get `model_ready` status, and are always
  visually distinct in the UI.
- **All Boltz access goes through `backend/app/boltz_client.py`** — never call
  the API or SDK from anywhere else.
- **No reward hacking.** The generator is never optimized against raw Boltz
  affinity; Boltz only ranks for acquisition. The OOD flag stays visible.
- **Tests and CI run with `BOLTZ_MOCK=1` and never spend credits.** Mock mode
  must fully work with `BOLTZ_API_KEY` unset.

## Status policy (the encoded "model-ready" definition; spec §1, §8)
- `blocked`: missing identity | target_construct | unit (a `%`-family unit for
  primary readouts) | (IC50 without the conditions to derive Ki) |
  unrecognized readout | `qc_flag == "fail"`.
- `normalizable`: would be model-ready but carries a soft QC warning
  (`aggregator` / `fluorescence_interference`) — usable with caution.
- `model_ready`: identity resolved, (assay_type, readout, construct, unit)
  present, qc pass, and the readout is one of:
  - condition-light affinity (Kd/Ki), pooled in `Ki` space; OR
  - an IC50 normalized to Ki via Cheng–Prusoff using present conditions; OR
  - a **primary single-concentration readout** (`pct_inhibition` /
    `pct_activity`) or **functional potency** (`EC50`) — each first-class in
    its **own comparability space** (`construct::readout`), never coerced into
    Ki. Comparability keys keep these lanes from being pooled with affinity.

## UHTS screening lane (additive, spec-aligned)
- `POST /screen/primary` and `POST /screen/confirm` (see
  `backend/app/screen.py`) mimic a 1536-well primary screen → confirmation.
  They are **deterministic, mock-only, and never spend** — no Boltz/NIM calls.
- Primary emits first-class `pct_inhibition` records; confirm emits SPR `Ki`
  ground truth and records a calibration delta vs the cached Boltz prediction.
- These routes were **added additively**; `docs/openapi.json` was regenerated
  (`python backend/export_openapi.py`, 18 paths). No existing route shape or
  response-model field changed.

## Workflow
- Commit in small increments with clear messages.
- Backend lives in `backend/`, frontend in `frontend/`, docs in `docs/`.
- Run backend tests: `cd backend && BOLTZ_MOCK=1 pytest`.
- One-command demo: `make up` (or `docker compose up`) — see README.

## Boltz live calls
The SDK surface (`small_molecule.design/screen/adme`, async start/poll/download)
is new — confirm signatures at api.boltz.bio/docs and pin the version before
relying on the live path. The live methods in `boltz_client.py` are guarded so
that, without a key/SDK, they raise a clear error rather than spending or
crashing.
