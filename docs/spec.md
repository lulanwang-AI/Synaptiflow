# Spec — Closed-Loop Discovery MVP (Demo)

## Purpose
Demonstrate that assay data, captured with proper semantic metadata, flows cleanly from the wet lab into the dry-lab optimization loop and is **visible end-to-end** to scientists and managers. The pipeline is illustrative — components are stubbed where noted — but the schema, identity handling, affinity normalization, data contracts, and frontend are real.

What the demo makes tangible:
1. The assay-metadata schema as the spine of wet↔dry communication.
2. The point where data is blocked because semantics are missing — the root-cause problem, surfaced as a number.
3. The two-loop DMTA flow, with live counts at each stage.

---

## 1. Core artifact — assay-metadata schema
The heart of the product. A measurement is **model-ready** only if it carries enough semantics to be compared and normalized. Minimal schema for one assay measurement:

```jsonc
{
  "compound": {
    "smiles": "Cc1ccc(cc1)S(=O)(=O)N",         // working representation (required)
    "smiles_canonical": "Cc1ccc(S(N)(=O)=O)cc1",// derived: RDKit canonicalization
    "inchikey": "FWMNVWWHGCHHJJ-UHFFFAOYSA-N",  // derived: stable join / dedup key
    "compound_id": "CMP-000123",                // registration id (assigned on register)
    "batch_id": "CMP-000123-002"                // optional; salt/batch is metadata
  },
  "assay": {
    "assay_id": "ASY-SPR-A01",
    "assay_type": "SPR",                         // SPR | ITC | DSF | FP | enzymatic_IC50 | radioligand | ...
    "readout": "Kd",                             // Kd | IC50 | Ki | pct_inhibition | dTm | kon | koff
    "target_construct": "KINASE_X_1-320_His",    // exact construct matters (required)
    "value": 8.0e-8,
    "unit": "M"                                  // required; normalized to molar internally
  },
  "conditions": {                                // required to compare / normalize
    "temperature_c": 25,
    "buffer": "HBS-EP, 0.05% Tween",
    "ph": 7.4,
    "substrate_conc_M": null,                    // [S], for enzymatic IC50 -> Ki
    "km_M": null,                                // Km, for Cheng-Prusoff (enzyme)
    "ligand_conc_M": null,                       // [L], for radioligand IC50 -> Ki
    "probe_kd_M": null                           // Kd of probe (radioligand case)
  },
  "measurement": {
    "replicates": 3,
    "std_error": 1.2e-8,
    "qc_flag": "pass",                           // pass | aggregator | fluorescence_interference | fail
    "operator": "jdoe",
    "date": "2026-06-10"
  },
  "provenance": {
    "source_system": "Benchling-ELN",            // or Dotmatics / CDD Vault / instrument
    "run_id": "RUN-2026-06-10-07",
    "protocol_ref": "SOP-SPR-014"
  }
}
```

### Record status (computed at ingest)
- **`model_ready`** — identity resolved, and (`assay_type`, `readout`, `target_construct`, `unit`) present, and either the readout is condition-light (`Kd`, `Ki`) **or** conditions are present to normalize an `IC50` to `Ki`.
- **`normalizable`** — `IC50` present with the conditions needed to compute `Ki`; normalization pending/derivable.
- **`blocked`** — missing `target_construct`, `unit`, identity, or (for `IC50`) the conditions required to normalize. Carries a machine-readable reason.

### Normalization rule (Cheng–Prusoff), applied at ingest
$$K_i = \frac{IC_{50}}{1 + [S]/K_m}\quad(\text{enzyme}) \qquad K_i = \frac{IC_{50}}{1 + [L]/K_d}\quad(\text{radioligand})$$

If the conditions are absent, the record is **not silently coerced** — it is flagged `blocked: missing_conditions`. Refusing to fabricate comparability is the whole point: a wrong `Ki` poisons the surrogate more quietly than a missing one.

### Predicted vs measured (Boltz outputs are not assay records)
The Boltz API supplies the generator and the cheap oracle (§2), but a Boltz affinity is a **model prediction** — an assay-agnostic binding-strength proxy in log-µM, not a literal `Ki`/`IC50` and not ground truth. Predictions live in a **separate `predictions` lane**, never the assay-record lane, with provenance `{ source: "boltz-api", model: "boltzmol-1", run_id }`. They never receive `model_ready` status. The closed loop compares each Boltz prediction against the wet-lab ground truth that later returns for the same compound, and that delta is the surrogate's calibration signal. Conflating the two would collapse the fidelity gap the product exists to manage.

---

## 2. Pipeline structure
Each stage has an explicit data contract (input → output); the activity store is the single source of truth. Stubbed stages marked `*`.

**Flow:** `Registration → Assay-ingest/normalize → Activity store → Generator (Boltz) → Cheap surrogate → Acquisition (+ Boltz re-rank) → Synthesis queue* → results* → (back to Assay-ingest)`, with the activity store also supplying the surrogate's training set. Stages marked `*` are mocked; Boltz stages are **real but metered** (see cost controls). (See the two-loop architecture diagram for the visual.)

1. **Registration / identity** — *real*
   - In: `{ smiles, compound_id? }`
   - Do: RDKit canonicalize SMILES; derive InChIKey; dedup; assign or look up `compound_id`.
   - Out: `{ compound_id, smiles_canonical, inchikey }`

2. **Assay ingest + normalization** — *real (the core)*
   - In: raw assay record (schema §1).
   - Do: validate against schema; resolve identity; normalize units to molar; if `IC50` + conditions, compute `Ki` (Cheng–Prusoff); compute `model_ready` / `normalizable` / `blocked` with reasons.
   - Out: typed activity record + status.

3. **Activity store** — *real, lightweight*
   - Typed store joining identity ↔ measurements ↔ conditions on InChIKey (SQLite or seeded JSON at demo scale). Holds two lanes: assay records (ground truth) and `predictions` (Boltz outputs, §1).
   - Exposes: model-ready dataset view, per-compound measurement view, blocked-record view, predictions-vs-measured view.

4. **Generator — Boltz API `small_molecule.design`** — *real; metered*
   - In: target `{ protein_sequence, chain_ids, pocket_residues }` (+ optional reference actives).
   - Do: call `client.small_molecule.design.run(target=…, num_molecules=k)`; canonicalize returned SMILES through stage 1; dedup on InChIKey.
   - Out: `[ { smiles, inchikey, design_run_id }, … ]`
   - Runs **once per DMTA round**, not per inner-loop step. `k` is small in the demo (cost).

5. **Cheap surrogate (local)** — *real*
   - In: candidate SMILES + model-ready `Ki`/`Kd` training data.
   - Do: ECFP4 + RandomForest **ensemble** → `(mu, sigma)` per candidate; `sigma` = ensemble variance. Free, runs on every candidate — this is the fast inner-loop ranker. Falls back to a documented mock if training points < threshold.
   - Out: `{ smiles, mu, sigma }`

6. **Acquisition + Boltz oracle re-rank** — *real; metered, cost-guarded*
   - In: cheap-surrogate scores `{ smiles, mu, sigma }`.
   - Do: (a) UCB on the cheap surrogate, $\alpha(x) = \mu(x) + \beta\,\sigma(x)$, selects a shortlist of the top-$m$; (b) call Boltz `small_molecule.screen` (affinity proxy) + `small_molecule.adme` on the shortlist **only**, results cached by `(target, inchikey)` and written to the `predictions` lane; (c) final batch = top-$k$ ranked by combined affinity + ADMET, each tagged `exploit` (high $\mu$) / `explore` (high $\sigma$) with rationale.
   - Out: ranked synthesis batch with per-candidate `{ mu, sigma, boltz_affinity, adme_flags, tag, rationale }`.
   - **Reward-hacking guard:** the generator is never optimized directly against raw Boltz affinity; Boltz is used to *rank for acquisition*, and an OOD flag (nearest-neighbor Tanimoto to training set below threshold) is surfaced in the rationale.

7. **Synthesis queue + assay results** — *mocked feedback*
   - Selected batch → synthesis queue → mocked/replayed assay results re-enter at stage 2. This closes the loop, and the returned ground truth is diffed against the cached Boltz prediction to show surrogate calibration.

### Boltz API integration & cost controls
- **Oracle ladder mapping** (matches the tech-stack doc): cheap local ECFP+RF (`~ms`, free, every candidate) → Boltz co-folding affinity/ADMET (`~s`, metered, shortlist only) → wet-lab assay (ground truth). Boltz is the mid tier, used at the acquisition gate.
- **SDK:** Python `from boltz_api import Boltz`; `client = Boltz(api_key=os.environ["BOLTZ_API_KEY"])`. Endpoints used: `small_molecule.design`, `small_molecule.screen`, `small_molecule.adme`. *Confirm exact signatures against api.boltz.bio/docs — the API is new and the surface may shift.*
- **All Boltz calls go through one wrapper** (`boltz_client.py`) with: a `BOLTZ_MOCK=1` mode returning canned outputs (so scaffolding, tests, and CI never spend credits), a cache keyed on `(target_hash, inchikey, endpoint)`, and a **credit guard** that estimates per-call cost, enforces a configurable hard cap (`BOLTZ_MAX_SPEND_USD`), and logs cumulative spend. The $2,000 launch credit is finite and metered — an ungated inner loop will exhaust it.
- **Async:** prefer the SDK's start/poll pattern (`start()` then `download_results()`) for batches; the demo uses small `num_molecules`/shortlist sizes.

---

## 3. Tech choices (demo)
- **Backend:** Python + FastAPI.
- **Chemistry:** RDKit (canonical SMILES, InChIKey, ECFP fingerprints).
- **Generation + oracle + ADMET:** Boltz API via the Python SDK (`boltz_api`), key in `BOLTZ_API_KEY`, wrapped in `boltz_client.py` with mock mode, caching, and a credit guard. For interactive use the Boltz CLI is installed per api.boltz.bio/docs; the backend uses the SDK.
- **Cheap surrogate:** scikit-learn RandomForest ensemble ($\mu,\sigma$) — local, free, for the inner loop; mock fallback.
- **Schema/validation:** Pydantic + JSON Schema.
- **Store:** SQLite (or in-memory JSON seed); two lanes (assay records, predictions).
- **Frontend:** React single-page app over the backend API.
- All generator / surrogate / optimizer components sit behind interfaces so they are swappable later (Boltz ↔ REINVENT ↔ GraphGA ↔ Bayesian optimization), and so the whole pipeline runs offline in mock mode.

---

## 4. Frontend — data-flow visibility
Make the loop and its bottlenecks legible to a mixed audience. One app, three personas, role-relevant emphasis.

**Personas → what they need to see:**
- Bench scientist: "Is my result usable? If not, what's missing?"
- ML engineer / comp chemist: "What is the model trained on, and what does it want made next?"
- Engineering manager / project lead: "Where is the loop stuck, and how fast is it turning?"

**Views / routes:**

1. **Loop overview (`/`) — the centerpiece.** A live rendering of the two-loop flow with a count badge at each stage: generated, scored, selected, in synthesis, assayed, ingested, model-ready, blocked. The **blocked** count is highlighted — the communication gap, shown as a number. Clicking a stage drills into its records.

2. **Assay records (`/records`).** Table of measurements with a semantic-completeness status: green = model-ready, amber = normalizable, red = blocked. Columns: compound (SMILES + small structure render), `assay_type`, `readout`, `value`, status. Row click opens a detail panel naming exactly which fields are missing and why the record is unusable (e.g. *"blocked: IC50 present but `substrate_conc_M` and `km_M` missing → cannot derive Ki"*). This view is the direct demonstration of the root cause and its fix.

3. **Compound (`/compound/:inchikey`).** Structure render + every measurement for that compound across assays, grouped by **comparability**: which values can be pooled (same construct/conditions, or normalized to `Ki`) versus which cannot. Where a Boltz prediction exists for the compound, show it alongside the returned wet-lab value with the delta — the surrogate-calibration view.

4. **Next batch (`/acquisition`).** The ranked candidate batch the system proposes to synthesize, each with cheap-surrogate $\mu \pm \sigma$, Boltz affinity (log-µM proxy), ADMET flags, an `exploit`/`explore` tag, an OOD flag, and the rationale. Candidates carry Boltz `design_run_id` provenance. A scientist or manager can review (and, in a fuller product, approve) before synthesis. Demonstrates the acquisition gate.

5. **Health / metrics (`/metrics`).** % model-ready, blocked-by-reason breakdown, cycle time, queue depths, hit-rate, **Boltz credit spend / remaining**, and surrogate calibration (Boltz-predicted vs measured error over closed cycles). The manager's dashboard.

**Key interaction (the demo's "aha"):** on `/records`, fixing a blocked record's metadata flips it green and increments the model-ready count on `/` — showing in one motion that the bottleneck is semantic, not computational.

---

## 5. Demo script (one cycle)
1. Seed assay data: some records complete, some missing conditions/units/construct.
2. `/` shows *N* model-ready, *M* blocked (*M* highlighted).
3. `/records`: drill into a blocked `IC50` record → see missing $[S]$ / $K_m$ → add them → record normalizes to $K_i$ and turns green.
4. Model-ready dataset trains the cheap surrogate; Boltz `design` proposes candidates against the target pocket (small `num_molecules`); the top shortlist is re-ranked by Boltz affinity + ADMET; `/acquisition` shows the batch with $\mu \pm \sigma$, Boltz affinity, ADMET flags, and OOD flag. (Run with `BOLTZ_MOCK=1` to rehearse without spending credits.)
5. Approve the batch → it enters the synthesis queue → mocked results return → re-ingest → loop counts update.

---

## 6. Real vs mocked
- **Real:** schema, RDKit canonicalization + InChIKey, Cheng–Prusoff normalization, status logic, data contracts, activity store (two lanes), acquisition (UCB + Boltz re-rank), **Boltz API generation / affinity / ADMET** (live, or canned via `BOLTZ_MOCK=1`), the full frontend.
- **Mocked / stubbed:** wet-lab assay results (replayed/synthetic), no instrument connectors. The cheap surrogate falls back to a mock when training data is too sparse.

---

## 7. Out of scope (demo)
Production registration/ELN/LIMS integration, real instrument ingest, multi-objective Bayesian optimization, OOD / applicability-domain detection beyond a placeholder flag, authentication, persistence at scale.

---

## 8. Open questions / risks
- **Schema fidelity.** The fields here are a reference minimum, not final — they must match Amgen's actual assay taxonomy and construct naming, which needs SME input.
- **Normalization scope.** Cheng–Prusoff applies to specific modes (competitive enzymatic inhibition; radioligand displacement). Allosteric, slow/tight-binding, and ITC thermodynamic readouts need their own handling — don't over-generalize the conversion.
- **Identity.** SMILES is the chosen representation, but canonical SMILES differ across toolkits; dedup/joins must key on InChIKey. Tautomer, stereochemistry, and salt handling (per the standardization pipeline) still need an explicit canonicalization-rules decision.
- **"Model-ready" is a policy, not a fact.** The completeness criteria should be reviewed jointly with wet- and dry-lab stakeholders before they gate anything real.
- **Boltz affinity is a ranking proxy, not truth.** It is an assay-agnostic log-µM strength estimate with documented pose/protonation/ring-geometry biases (independent evals). Use it for acquisition ranking only; never as the generator's direct objective and never ingested as an assay record. Wet-lab assays remain ground truth.
- **Credits are finite and metered.** The $2,000 launch credit is a two-week promo; the API is pay-per-call. The credit guard, caching, mock mode, and shortlist-only affinity calls are load-bearing, not optional. Confirm current pricing and rate limits at api.boltz.bio.
- **New SDK surface.** The Boltz API launched recently; the exact SDK signatures, `design`/`screen`/`adme` schemas, and async semantics must be confirmed against api.boltz.bio/docs and pinned. Keep all calls behind `boltz_client.py`.
- **Target input requirement.** Boltz `design` needs a protein sequence + chain/pocket-residue definition (structure-based); some endpoints may need an MSA. The `Target + dataset` input contract must carry these, which is new relative to the assay-only framing.
