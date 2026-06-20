# Claude Code Sessions — Building the Closed-Loop MVP

Prompts to implement the MVP defined in `docs/context.md` and `docs/spec.md`. Four sessions, with explicit ordering. Copy each prompt into a fresh Claude Code session.

## Assumptions
- `docs/context.md` and `docs/spec.md` are committed at the repo root (`docs/`).
- Tooling available: Python 3.11+, Node 18+, git. RDKit installs via `pip install rdkit` (2023.9+ ships wheels).
- **Boltz API:** an account at api.boltz.bio with a key in `BOLTZ_API_KEY` and the $2,000 launch credit. Backend uses the Python SDK (`boltz_api`); the macOS CLI (`curl … install.sh | sh` per api.boltz.bio/docs) is optional and for interactive use only. The exact SDK surface (`small_molecule.design` / `screen` / `adme`) is new — sessions must read api.boltz.bio/docs to confirm signatures before wiring live calls, and pin a version.
- **Credit safety:** every Boltz call goes through one `boltz_client.py` wrapper with a `BOLTZ_MOCK=1` mode (canned outputs), a cache, and a hard spend cap (`BOLTZ_MAX_SPEND_USD`). Scaffolding, tests, and CI run in mock mode and never spend credits. Boltz also ships first-party Claude Code integration, so a session can install/wire the SDK itself.
- Claude Code sessions are stateless — every prompt below starts by re-reading the docs and the relevant existing code.

## Ordering

```
S1  Foundation + frozen API contract        (sequential, run first)
        │
        ├───────────────┐
        ▼               ▼
   S2 Backend        S3 Frontend             (PARALLEL — separate branches/worktrees)
        └───────┬───────┘
                ▼
        S4  Integration + demo               (sequential, run last)
```

**Why this split:** S1 freezes the schema and every API route shape, so S2 (backend internals) and S3 (frontend) only share a contract that no longer changes — they can run concurrently without conflict. If you prefer to work one session at a time, run S1 → S2 → S3 → S4 in order; you lose only wall-clock time.

## Parallel mechanics (S2 ∥ S3)
- Backend and frontend live in disjoint directories, so conflict surface is near-zero.
- Use git worktrees so two sessions don't fight over one checkout:
  ```
  git worktree add ../mvp-backend  s2-backend
  git worktree add ../mvp-frontend s3-frontend
  ```
  Run S2 in `../mvp-backend`, S3 in `../mvp-frontend`. Merge both to `main` before S4 (order doesn't matter — disjoint paths).
- **The contract is frozen.** S2 implements route *internals* but must not change any route signature or response model. S3 builds against `docs/openapi.json` exported by S1.
- S1 writes a `CLAUDE.md` encoding these rules, so S2–S4 pick them up automatically.

---

## Session 1 — Foundation + frozen contract
**Sequential. Run first.** Locks the schema, identity layer, and the full API surface so the parallel phase is safe.

```text
Read docs/context.md and docs/spec.md in full before writing any code. You are scaffolding the MVP they describe. Scope yourself to THIS session's deliverables only — do not implement business logic for the surrogate, acquisition, or normalization yet (later sessions do that).

Stack: Python 3.11+, FastAPI, Pydantic v2, RDKit (pip install rdkit), SQLite (stdlib), venv, Boltz API Python SDK (boltz_api; key in BOLTZ_API_KEY). Frontend stack will be React/Vite/TS in frontend/ — leave it empty for now.

Create this layout:
  docs/{context.md,spec.md}        (already present)
  backend/app/{main.py,schema.py,identity.py,boltz_client.py,api/}
  backend/app/seed/{records.jsonl,target.json}
  backend/tests/
  backend/pyproject.toml
  frontend/                        (empty placeholder)
  CLAUDE.md
  README.md

Deliverables:
1. Runnable FastAPI app: `uvicorn app.main:app` serves and /docs works.
2. app/schema.py — Pydantic models for the assay-metadata record EXACTLY per spec §1 (compound, assay, conditions, measurement, provenance). Add enums RecordStatus {model_ready, normalizable, blocked} and BlockedReason {missing_identity, missing_construct, missing_unit, missing_conditions, qc_fail}. Also add: a Prediction model (the Boltz `predictions` lane — smiles, inchikey, boltz_affinity_loguM, adme_flags, ood_flag, provenance {source:"boltz-api", model, run_id}) kept SEPARATE from assay records; and a Target model (protein_sequence, chain_ids, pocket_residues) for the generator input.
3. app/identity.py — REAL RDKit identity: canonicalize(smiles)->str, inchikey(smiles)->str, resolve(smiles, compound_id=None) that dedups on InChIKey and assigns a compound_id. Invalid SMILES must fail gracefully (typed error, not a crash).
4. app/api/ — define EVERY endpoint the frontend needs (spec §4) as typed routes returning seed/mock data for now: GET /loop/summary, GET /records, GET /records/{id}, GET /compound/{inchikey}, GET /acquisition/batch, GET /metrics, GET /target, POST /records (ingest), PATCH /records/{id} (edit metadata). The /acquisition/batch response model carries per-candidate {mu, sigma, boltz_affinity, adme_flags, ood_flag, tag, rationale, design_run_id}; /metrics carries {credit_spent_usd, credit_cap_usd, calibration_error}. All requests/responses are Pydantic models.
5. app/boltz_client.py — the ONLY path to the Boltz API. Define the wrapper interface now: design(target, num_molecules)->[candidates], screen(target, smiles[])->[affinity], adme(smiles[])->[flags]. Implement a working BOLTZ_MOCK=1 mode returning canned, deterministic outputs; a cache keyed on (target_hash, inchikey, endpoint); and a credit guard that tracks cumulative spend and refuses calls past BOLTZ_MAX_SPEND_USD. Live API calls are wired in S2 — for now mock mode must fully work. This interface is FROZEN like the routes.
6. app/seed/records.jsonl (~15 records mixing model_ready, normalizable, blocked; ≥1 compound measured by two assays with different comparability) and app/seed/target.json (one demo Target: a protein sequence + pocket_residues for Boltz design).
7. Export OpenAPI to docs/openapi.json (a script + committed file) for the frontend session.
8. CLAUDE.md — cross-session rules: docs live in docs/; the API route signatures, response models (app/api + app/schema.py), and the app/boltz_client.py interface are FROZEN after this session; commit in small increments; affinity values are never coerced (a missing Ki beats a fabricated one); Boltz outputs are PREDICTIONS, never ingested as assay records; all Boltz access goes through app/boltz_client.py; tests and CI run with BOLTZ_MOCK=1 and never spend credits.
9. Minimal pytest (BOLTZ_MOCK=1): identity (canonicalization idempotence, InChIKey stability, invalid SMILES), schema validation, and a boltz_client mock-mode smoke test.

Commit when the server runs, /docs lists all endpoints, and pytest is green.
```

**Expected:** running server with full Swagger UI, seed data (records + target) loading, identity tests passing, `boltz_client.py` mock mode working with no key set, `docs/openapi.json` committed, `CLAUDE.md` present.

**Verify:**
```
cd backend && uvicorn app.main:app --reload   # open /docs
BOLTZ_MOCK=1 pytest
curl localhost:8000/records | jq '.[0]'
curl localhost:8000/target | jq
```

**Follow-ups:**
- "Export `docs/openapi.json` and commit it — the frontend session depends on it." (if skipped)
- "Confirm `boltz_client.py` mock mode runs with BOLTZ_API_KEY unset and returns deterministic canned design/screen/adme outputs — no network calls in tests."
- "Add 3 more blocked records, each with a *different* `BlockedReason`, so the metrics breakdown has variety."
- RDKit install issue: "`pip install rdkit` (2023.9+) ships manylinux wheels; if that fails, fall back to conda-forge and document the working install in README."
- Then branch for parallel: `git commit -am "S1: scaffold + schema + identity + boltz wrapper + frozen API" && git worktree add ../mvp-backend s2-backend && git worktree add ../mvp-frontend s3-frontend`.

---

## Session 2 — Backend semantics core
**Parallel with S3.** Run in `../mvp-backend`. Implements real internals behind the frozen API. This is the core of the product.

```text
Read docs/context.md, docs/spec.md, CLAUDE.md, and the existing backend/ — especially app/schema.py, app/api/, and app/boltz_client.py. RULE: do not change any API route signature, response model, or the app/boltz_client.py interface. Implement their real internals (including the live Boltz API calls inside boltz_client). Build in committed increments in this exact order; run tests (BOLTZ_MOCK=1) and commit after each step.

1. app/ingest.py — THE CORE. For a raw record: validate, resolve identity (app/identity.py), normalize all concentrations/values to molar, then compute RecordStatus + reason per spec §1.
   - Implement Cheng–Prusoff: Ki = IC50 / (1 + [S]/Km) for enzymatic; Ki = IC50 / (1 + [L]/Kd_probe) for radioligand.
   - If an IC50 lacks the conditions to normalize, status = blocked, reason = missing_conditions. NEVER coerce or guess.
   - On successful normalization, attach a derived ki_M field.
   - Tests: one record per status path; assert the numeric Ki for a known IC50 + conditions by hand.

2. app/store.py — SQLite activity store keyed on InChIKey, joining identity ↔ measurement ↔ conditions. Provide: upsert(record), model_ready_dataset(), compound_measurements(inchikey) grouped by comparability, blocked_records(), loop_summary() counts, metrics(). Tests for joins and the comparability grouping.

3. app/surrogate.py — the CHEAP inner-loop tier. ECFP4 fingerprints + a small RandomForest ENSEMBLE returning (mu, sigma) per SMILES, trained on model-ready Ki/Kd data. sigma = variance across the ensemble, not a constant. Free, runs on every candidate. Fall back to a clearly-documented mock if training points < threshold.

4. app/boltz_client.py (live) + app/generator.py — implement the LIVE Boltz calls inside the frozen boltz_client interface: first read api.boltz.bio/docs to confirm the `small_molecule.design` / `screen` / `adme` signatures and async (start/poll/download) semantics, then implement them with the cache and credit guard already scaffolded. generator.py calls boltz_client.design(target, num_molecules) for the demo Target, canonicalizes returned SMILES through app/identity.py, and dedups on InChIKey. Keep BOLTZ_MOCK=1 fully working. Do NOT raise num_molecules in tests.

5. app/acquisition.py — two-tier gate: (a) cheap-surrogate UCB alpha = mu + beta*sigma selects a shortlist of top-m; (b) boltz_client.screen + adme score the shortlist ONLY (cached by target+inchikey, credit-guarded), and the outputs are written to the predictions lane in the store (never as assay records); (c) final batch = top-k by combined affinity + ADMET, each with exploit/explore tag, an OOD flag (nearest-neighbor Tanimoto to training set below threshold), and a rationale. REWARD-HACKING GUARD: the generator is never optimized against raw Boltz affinity; Boltz only ranks for acquisition.

6. app/loop.py — synthesis queue + replay_results(batch): turns a selected batch into mocked assay records and feeds them back through ingest, closing the loop. On each returned ground-truth value, diff it against the cached Boltz prediction for that compound and accumulate a calibration_error surfaced in /metrics.

7. Wire all of the above into the existing endpoints, replacing S1's mock returns. Response shapes (including the boltz fields on /acquisition/batch and the credit/calibration fields on /metrics) must stay byte-for-byte compatible with the frozen models.

Acceptance: with BOLTZ_MOCK=1 the full loop runs end-to-end in tests and via the API (POST a blocked IC50 → PATCH conditions → model_ready with ki_M; design → shortlist → screen → ranked batch → replay → calibration updates); a live run with small num_molecules works against the real API and stops at BOLTZ_MAX_SPEND_USD; pytest green.
```

**Expected:** fully functional backend behind the unchanged contract; correct Cheng–Prusoff; correct status logic; loop closes via `replay_results`.

**Verify:**
```
BOLTZ_MOCK=1 pytest
# ingest a blocked record, patch conditions, watch status flip:
curl -X POST localhost:8000/records -d @blocked_ic50.json
curl -X PATCH localhost:8000/records/<id> -d '{"conditions":{"substrate_conc_M":1e-5,"km_M":2e-5}}'
curl localhost:8000/loop/summary | jq
curl localhost:8000/acquisition/batch | jq   # check boltz_affinity, adme_flags, ood_flag present
```

**Follow-ups:**
- "Confirm the live `boltz_client` signatures against api.boltz.bio/docs and pin the SDK version; show me a diff if the real `design`/`screen`/`adme` schemas differ from the mock."
- "Show the Cheng–Prusoff test cases and the exact Ki you computed for record X — I want to check the arithmetic."
- "Verify the credit guard: simulate spend approaching `BOLTZ_MAX_SPEND_USD` and confirm further Boltz calls are refused with a clear error, not a silent skip."
- "Make the surrogate honest about extrapolation — verify sigma (and the OOD Tanimoto flag) actually grow for candidates far from the training manifold."
- If it edited a frozen interface: "Revert that change — the routes, response models, and boltz_client interface are frozen per CLAUDE.md. Fit the internals instead."

---

## Session 3 — Frontend
**Parallel with S2.** Run in `../mvp-frontend`. Builds against `docs/openapi.json`; can use the real backend or a mock generated from the spec.

```text
Read docs/context.md, docs/spec.md (especially §4), CLAUDE.md, and docs/openapi.json. Build the React SPA in frontend/. If the backend is running, use it (uvicorn app.main:app); if not, generate a mock from docs/openapi.json with MSW so the UI is fully clickable standalone.

Stack: React + Vite + TypeScript; a typed API client in src/api/ generated from / aligned to docs/openapi.json; minimal, legible styling (this is for scientists and managers — clarity over polish). Render SMILES structures in-browser (smiles-drawer or rdkit-js).

Build these views per spec §4 (commit per view):
1. "/" Loop overview — the centerpiece. Render the two-loop flow as an SVG (inner compute loop: generator → surrogate → acquisition; outer wet-lab loop: synthesis → assay → ingest; the substrate feeding both). Overlay a live COUNT badge on each stage: generated, scored, selected, in_synthesis, assayed, ingested, model_ready, blocked. Highlight the blocked count. Stages clickable → drill into /records filtered to that stage.
2. "/records" — table with green/amber/red status (model_ready/normalizable/blocked). Columns: compound (SMILES + small structure render), assay_type, readout, value, status. Row click → detail panel that quotes the API's machine reason verbatim and lists the exact missing fields as form inputs. Inline PATCH to fill missing conditions.
3. "/compound/:inchikey" — structure + every measurement across assays, grouped by comparability (poolable vs not-comparable). Where a Boltz prediction exists for the compound, show it next to the returned wet-lab value with the delta (the surrogate-calibration view). Predictions are visually distinct from measurements — never mixed.
4. "/acquisition" — the ranked candidate batch with cheap-surrogate mu ± sigma, Boltz affinity (log-µM proxy), ADMET flags, an OOD flag, an exploit/explore tag, and the rationale; show Boltz design_run_id provenance per candidate.
5. "/metrics" — % model_ready, blocked-by-reason breakdown, cycle time, queue depths, a Boltz credit widget (spent / cap / remaining), and surrogate calibration (Boltz-predicted vs measured error). (The frontend reads all of this from the API — it never calls Boltz directly and needs no key.)

Implement the key interaction: editing a blocked record's metadata on /records (PATCH) flips its status, and the model_ready count on "/" updates. Add brief persona hints on the relevant views (scientist / ML eng / manager).

Acceptance: all 5 views render against the API (or mock); the metadata-fix-flips-green flow works; structures render.
```

**Expected:** all five views functional; the "fix metadata → turns green → overview count rises" interaction works; SMILES structures render.

**Verify:**
```
npm run dev   # click through all routes
# edit a blocked record on /records, confirm "/" count updates
```

**Follow-ups:**
- "On the overview SVG, match the architecture exactly — inner loop, acquisition gate as the hinge, outer loop — and put the live counts on the nodes."
- "Persona toggle: a selector that emphasizes each persona's view set (scientist → records/compound; ML eng → acquisition/records; manager → overview/metrics)."
- "The blocked detail panel must show *only* the genuinely missing fields as inputs, derived from the API reason — not the whole form."
- "On /acquisition and /compound, make the 'predicted, not measured' distinction and the OOD flag visually unmissable — they're the guardrails against over-trusting Boltz affinity."
- Backend not ready: "Stand up an MSW mock from docs/openapi.json so the UI is fully demoable without the server, then swap to live in S4."

---

## Session 4 — Integration + demo
**Sequential. Run last,** after merging `s2-backend` and `s3-frontend` to `main`.

```text
First: merge s2-backend and s3-frontend into main (disjoint paths, no conflicts expected). Read docs/spec.md §5 (demo script) and §6 (real-vs-mocked). Wire the real frontend to the real backend end-to-end and make the one-cycle demo reliable.

1. Reconcile any drift between the frontend client and backend response models. The backend contract is canonical — adapt the client, not the routes/boltz_client.
2. Seed a COMPELLING demo dataset: a clear mix of model_ready / normalizable / blocked, including (a) one IC50 record that becomes model_ready after adding [S] and Km, and (b) one compound with two non-comparable measurements; plus the demo Target (app/seed/target.json) for Boltz design.
3. Make the §5 demo script work click-by-click in BOTH modes — BOLTZ_MOCK=1 (for rehearsal, zero spend) and live (small num_molecules): overview N ready / M blocked → drill into a blocked IC50 → add conditions → turns green, count increments → model-ready data trains the surrogate → Boltz design proposes candidates → shortlist re-ranked by Boltz affinity + ADMET → /acquisition shows the batch (with OOD flag, predicted-not-measured) → approve → synthesis queue → replay results → counts update and the predicted-vs-measured delta appears on /compound.
4. One-command run: Makefile or docker-compose bringing up backend + frontend together, reading BOLTZ_API_KEY / BOLTZ_MOCK / BOLTZ_MAX_SPEND_USD from env. README with setup, the demo script, the real-vs-mocked table from spec §6, and a clear note that mock mode requires no key and spends nothing.
5. Smoke test the full loop end-to-end with BOLTZ_MOCK=1 (a short script or e2e test) so a fresh clone is known-good without credits.

Acceptance: a fresh clone runs with one command; the demo works start to finish in mock mode with no key, and in live mode within the credit cap.
```

**Expected:** a fresh clone runs with one command; the closed-loop demo and the "aha" interaction work live; README documents setup, demo, and scope.

**Verify:**
```
git clone <repo> /tmp/mvp-check && cd /tmp/mvp-check
BOLTZ_MOCK=1 make up   # or docker-compose up — no key needed
# walk the spec §5 demo script end to end
```

**Follow-ups:**
- "Add a seed-reset button/endpoint so I can re-run the demo from a clean state mid-presentation."
- "Show the live Boltz credit spend for one full demo cycle, and set BOLTZ_MAX_SPEND_USD so a runaway demo can't burn the $2k."
- "Write a 6-line demo narration (one line per step) tied to the personas in context.md, that I can read while clicking — include the predicted-vs-measured calibration moment."
- "Add real cycle-time tracking: timestamp candidate selection vs mocked-result return, and surface it on /metrics."
- "Generate a short GIF/screen recording of the closed loop (mock mode) for the README."

---

## One-page checklist
- [ ] **S1** (seq): scaffold, schema (+ predictions lane + Target), RDKit identity, `boltz_client.py` wrapper (mock mode + credit guard), all routes mocked, `openapi.json`, `CLAUDE.md`, tests. Contract + boltz_client interface frozen.
- [ ] **S2 ∥ S3** (parallel, worktrees): backend core (Cheng–Prusoff, store, cheap surrogate, live Boltz design/screen/adme, acquisition re-rank, credit guard, loop + calibration) ‖ frontend (5 views, green-flip, Boltz affinity/ADMET/OOD, credit widget).
- [ ] Merge both to `main`.
- [ ] **S4** (seq): end-to-end wiring, demo dataset + Target, one-command run (mock + live), README, mock-mode smoke test.
