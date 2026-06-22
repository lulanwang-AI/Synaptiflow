// Mock in-memory backend mirroring the real status/normalization logic so the
// UI is fully clickable and the KEY INTERACTION works with no backend:
//   editing a blocked record's metadata (PATCH) recomputes status -> green,
//   and the model_ready count on the loop summary updates.
//
// This is a faithful-enough reimplementation of the backend's ingest rules
// (spec.md §1, CLAUDE.md "Status policy") for demo purposes only.

import type {
  AcquisitionBatch,
  AssayRecord,
  AssayRecordIn,
  BlockedReason,
  CompoundView,
  DockResponse,
  FoldResult,
  LoopSummary,
  Metrics,
  Prediction,
  QueueItem,
  QueueView,
  RecordPatch,
  RecordStatus,
  Target,
} from "../api/types";

// deterministic 32-bit hash for mock NIM outputs
function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// --- pseudo identity derivation (deterministic, no RDKit in the browser) ---
function fakeInchikey(smiles: string): string {
  // Stable 27-char InChIKey-shaped string from the SMILES.
  let h = 2166136261;
  for (let i = 0; i < smiles.length; i++) {
    h ^= smiles.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const block = (seed: number, n: number) => {
    let s = "";
    let x = seed >>> 0;
    for (let i = 0; i < n; i++) {
      x = Math.imul(x, 1664525) + 1013904223;
      s += alpha[(x >>> 16) % 26];
    }
    return s;
  };
  return `${block(h, 14)}-${block(h ^ 0x5a5a, 10)}-N`;
}

let compoundCounter = 100;
const compoundIdByInchikey: Record<string, string> = {};
function compoundIdFor(inchikey: string): string {
  if (!compoundIdByInchikey[inchikey]) {
    compoundCounter += 1;
    compoundIdByInchikey[inchikey] = `CMP-${String(compoundCounter).padStart(6, "0")}`;
  }
  return compoundIdByInchikey[inchikey];
}

// --- status computation (mirrors backend policy) ---
const CONDITION_LIGHT = new Set(["Kd", "Ki"]);

export function computeDerived(rec: AssayRecord): AssayRecord {
  const r: AssayRecord = JSON.parse(JSON.stringify(rec));
  const c = r.compound;
  const a = r.assay;
  const cond = r.conditions ?? {};
  const meas = r.measurement ?? {};

  // identity
  if (!c.inchikey) c.inchikey = fakeInchikey(c.smiles);
  if (!c.smiles_canonical) c.smiles_canonical = c.smiles;
  if (!c.compound_id) c.compound_id = compoundIdFor(c.inchikey);

  let status: RecordStatus = "model_ready";
  let blocked_reason: BlockedReason | null = null;
  let reason_detail: string | null = null;
  const missing_fields: string[] = [];

  // value normalized to molar (only "M" handled here; backend handles more)
  let value_M: number | null = null;
  if (a.value != null && a.unit) {
    const u = a.unit.toLowerCase();
    const scale: Record<string, number> = {
      m: 1,
      mm: 1e-3,
      um: 1e-6,
      "µm": 1e-6,
      nm: 1e-9,
      pm: 1e-12,
    };
    if (u in scale) value_M = a.value * scale[u];
  }
  let ki_M: number | null = null;

  // blocked checks in priority order
  if (!c.smiles) {
    status = "blocked";
    blocked_reason = "missing_identity";
    reason_detail = "blocked: missing compound identity (no SMILES).";
    missing_fields.push("compound.smiles");
  } else if (!a.target_construct) {
    status = "blocked";
    blocked_reason = "missing_construct";
    reason_detail =
      "blocked: target_construct missing -> measurements cannot be compared across assays.";
    missing_fields.push("assay.target_construct");
  } else if (!a.unit) {
    status = "blocked";
    blocked_reason = "missing_unit";
    reason_detail = "blocked: unit missing -> value cannot be normalized to molar.";
    missing_fields.push("assay.unit");
  } else if (meas.qc_flag === "fail") {
    status = "blocked";
    blocked_reason = "qc_fail";
    reason_detail = "blocked: qc_flag == fail -> measurement rejected.";
  } else if (a.readout === "IC50") {
    // need conditions to derive Ki (Cheng-Prusoff)
    const hasEnzyme = cond.substrate_conc_M != null && cond.km_M != null;
    const hasRadio = cond.ligand_conc_M != null && cond.probe_kd_M != null;
    if (hasEnzyme) {
      if (value_M != null)
        ki_M = value_M / (1 + cond.substrate_conc_M! / cond.km_M!);
      status = "model_ready";
    } else if (hasRadio) {
      if (value_M != null)
        ki_M = value_M / (1 + cond.ligand_conc_M! / cond.probe_kd_M!);
      status = "model_ready";
    } else {
      status = "blocked";
      blocked_reason = "missing_conditions";
      reason_detail =
        "blocked: IC50 present but substrate_conc_M and km_M missing -> cannot derive Ki (Cheng-Prusoff).";
      missing_fields.push("conditions.substrate_conc_M", "conditions.km_M");
    }
  } else if (!CONDITION_LIGHT.has(a.readout)) {
    // readouts like pct_inhibition cannot be normalized to an affinity
    status = "blocked";
    blocked_reason = "missing_conditions";
    reason_detail = `blocked: readout '${a.readout}' is not an affinity and cannot be normalized to Ki.`;
  }

  // soft QC warnings -> normalizable (only if not already blocked)
  if (
    status === "model_ready" &&
    (meas.qc_flag === "aggregator" || meas.qc_flag === "fluorescence_interference")
  ) {
    status = "normalizable";
    reason_detail = `soft QC warning: qc_flag == ${meas.qc_flag} -> usable with caution.`;
  }

  // Ki for condition-light readouts is the value itself
  if (status !== "blocked" && ki_M == null) {
    if (a.readout === "Ki" && value_M != null) ki_M = value_M;
    else if (a.readout === "Kd" && value_M != null) ki_M = value_M; // pooled by construct
  }

  // comparability key: construct + readout family (Ki-comparable)
  let comparability_key: string | null = null;
  if (status !== "blocked" && a.target_construct) {
    const family = a.readout === "Kd" ? "Kd" : "Ki";
    comparability_key = `${a.target_construct}|${family}`;
  }

  r.compound = c;
  r.status = status;
  r.blocked_reason = blocked_reason;
  r.reason_detail = reason_detail;
  r.missing_fields = missing_fields;
  r.value_M = value_M;
  r.ki_M = ki_M;
  r.comparability_key = comparability_key;
  return r;
}

// --- seed records (mirror backend/app/seed/records.jsonl shape, plus blocked) ---
type SeedIn = Omit<
  AssayRecord,
  | "record_id"
  | "status"
  | "blocked_reason"
  | "reason_detail"
  | "missing_fields"
  | "value_M"
  | "ki_M"
  | "comparability_key"
>;

const SEED: SeedIn[] = [
  {
    compound: { smiles: "CC(=O)Oc1ccccc1C(=O)O" },
    assay: {
      assay_id: "ASY-SPR-A01",
      assay_type: "SPR",
      readout: "Ki",
      target_construct: "KINASE_X_1-320_His",
      value: 8.0e-8,
      unit: "M",
    },
    conditions: { temperature_c: 25, buffer: "HBS-EP, 0.05% Tween", ph: 7.4 },
    measurement: { replicates: 3, std_error: 1.2e-8, qc_flag: "pass", operator: "jdoe", date: "2026-06-10" },
    provenance: { source_system: "Benchling-ELN", run_id: "RUN-2026-06-10-07", protocol_ref: "SOP-SPR-014" },
  },
  {
    compound: { smiles: "CC(=O)Oc1ccccc1C(=O)O" },
    assay: {
      assay_id: "ASY-IC50-A09",
      assay_type: "enzymatic_IC50",
      readout: "IC50",
      target_construct: "KINASE_X_1-320_His",
      value: 1.6e-7,
      unit: "M",
    },
    // missing substrate_conc_M / km_M -> blocked
    conditions: { temperature_c: 25, ph: 7.4 },
    measurement: { replicates: 3, qc_flag: "pass", operator: "asmith", date: "2026-06-13" },
    provenance: { source_system: "Dotmatics", run_id: "RUN-2026-06-13-04" },
  },
  {
    compound: { smiles: "CC(C)Cc1ccc(cc1)C(C)C(=O)O" },
    assay: {
      assay_id: "ASY-SPR-B01",
      assay_type: "SPR",
      readout: "Ki",
      target_construct: "KINASE_X_1-320_His",
      value: 2.5e-7,
      unit: "M",
    },
    conditions: { temperature_c: 25, ph: 7.4 },
    measurement: { replicates: 3, qc_flag: "pass", operator: "jdoe", date: "2026-06-10" },
    provenance: { source_system: "Benchling-ELN", run_id: "RUN-2026-06-10-08" },
  },
  {
    compound: { smiles: "CC(C)Cc1ccc(cc1)C(C)C(=O)O" },
    assay: {
      assay_id: "ASY-IC50-B07",
      assay_type: "enzymatic_IC50",
      readout: "IC50",
      target_construct: "KINASE_X_1-320_His",
      value: 5.0e-7,
      unit: "M",
    },
    // has conditions -> normalizes to Ki -> model_ready
    conditions: { temperature_c: 25, ph: 7.4, substrate_conc_M: 1.0e-4, km_M: 5.0e-5 },
    measurement: { replicates: 3, qc_flag: "pass", operator: "asmith", date: "2026-06-14" },
    provenance: { source_system: "Dotmatics", run_id: "RUN-2026-06-14-01" },
  },
  {
    compound: { smiles: "COc1ccc2cc(ccc2c1)C(C)C(=O)O" },
    assay: {
      assay_id: "ASY-SPR-E01",
      assay_type: "SPR",
      readout: "Ki",
      target_construct: "KINASE_X_1-320_His",
      value: 1.2e-7,
      unit: "M",
    },
    conditions: { temperature_c: 25, ph: 7.4 },
    measurement: { replicates: 3, qc_flag: "pass", operator: "asmith", date: "2026-06-12" },
    provenance: { source_system: "Dotmatics", run_id: "RUN-2026-06-12-01" },
  },
  {
    compound: { smiles: "CC(C)(C)NCC(O)c1ccc(O)c(O)c1" },
    assay: {
      assay_id: "ASY-SPR-F01",
      assay_type: "SPR",
      readout: "Ki",
      target_construct: "KINASE_X_1-320_His",
      value: 9.0e-7,
      unit: "M",
    },
    conditions: { temperature_c: 25, ph: 7.4 },
    measurement: { replicates: 2, qc_flag: "pass", operator: "jdoe", date: "2026-06-12" },
    provenance: { source_system: "Benchling-ELN", run_id: "RUN-2026-06-12-03" },
  },
  {
    compound: { smiles: "O=C(O)c1ccccc1Nc1ccccc1Cl" },
    assay: {
      // missing target_construct -> blocked
      assay_id: "ASY-SPR-G01",
      assay_type: "SPR",
      readout: "Kd",
      value: 3.0e-7,
      unit: "M",
    },
    conditions: { temperature_c: 25, ph: 7.4 },
    measurement: { replicates: 2, qc_flag: "pass", operator: "jdoe", date: "2026-06-13" },
    provenance: { source_system: "Benchling-ELN", run_id: "RUN-2026-06-13-09" },
  },
  {
    compound: { smiles: "CN1C=NC2=C1C(=O)N(C(=O)N2C)C" },
    assay: {
      // missing unit -> blocked
      assay_id: "ASY-FP-H01",
      assay_type: "FP",
      readout: "Kd",
      target_construct: "KINASE_X_1-320_His",
      value: 4.5e-7,
    },
    conditions: { temperature_c: 25, ph: 7.4 },
    measurement: { replicates: 3, qc_flag: "pass", operator: "asmith", date: "2026-06-14" },
    provenance: { source_system: "Dotmatics", run_id: "RUN-2026-06-14-07" },
  },
  {
    compound: { smiles: "Cc1ccc(cc1)S(=O)(=O)N" },
    assay: {
      assay_id: "ASY-DSF-I01",
      assay_type: "DSF",
      readout: "Ki",
      target_construct: "KINASE_X_2-300_His",
      value: 7.0e-8,
      unit: "M",
    },
    // soft QC warning -> normalizable (amber)
    conditions: { temperature_c: 25, ph: 7.4 },
    measurement: { replicates: 3, qc_flag: "aggregator", operator: "jdoe", date: "2026-06-15" },
    provenance: { source_system: "Benchling-ELN", run_id: "RUN-2026-06-15-02" },
  },
  {
    compound: { smiles: "Cc1ccc(cc1)S(=O)(=O)N" },
    assay: {
      assay_id: "ASY-RAD-I02",
      assay_type: "radioligand",
      readout: "IC50",
      target_construct: "KINASE_X_2-300_His",
      value: 2.2e-7,
      unit: "M",
    },
    // missing radioligand conditions -> blocked
    conditions: { temperature_c: 25, ph: 7.4 },
    measurement: { replicates: 3, qc_flag: "pass", operator: "asmith", date: "2026-06-15" },
    provenance: { source_system: "Dotmatics", run_id: "RUN-2026-06-15-08" },
  },
];

// --- mutable store ---
let recordSeq = 0;
function nextRecordId(): string {
  recordSeq += 1;
  return `REC-${String(recordSeq).padStart(4, "0")}`;
}

export interface MockState {
  records: AssayRecord[];
  approvedBatches: number;
  creditSpentUsd: number;
  calibrationErrors: number[];
  queue: QueueItem[];
}

let state: MockState;

function buildSeedRecords(): AssayRecord[] {
  recordSeq = 0;
  return SEED.map((s) =>
    computeDerived({
      ...s,
      record_id: nextRecordId(),
      status: "model_ready",
    } as AssayRecord),
  );
}

export function resetState(): number {
  compoundCounter = 100;
  for (const k of Object.keys(compoundIdByInchikey)) delete compoundIdByInchikey[k];
  state = {
    records: buildSeedRecords(),
    approvedBatches: 0,
    creditSpentUsd: 4.8,
    calibrationErrors: [],
    queue: [],
  };
  return state.records.length;
}

export function getState(): MockState {
  if (!state) resetState();
  return state;
}

// --- acquisition batch (static-ish candidates) ---
const CANDIDATES: AcquisitionBatch["candidates"] = [
  {
    smiles: "Cc1ccc(cc1)S(=O)(=O)Nc1ncccn1",
    inchikey: fakeInchikey("Cc1ccc(cc1)S(=O)(=O)Nc1ncccn1"),
    mu: 7.8,
    sigma: 0.3,
    boltz_affinity: -2.1,
    adme_flags: ["good_solubility"],
    ood_flag: false,
    tag: "exploit",
    rationale:
      "High predicted pKi (mu=7.8), low uncertainty; close to known active scaffold (sulfonamide). Boltz affinity proxy strong.",
    design_run_id: "DESIGN-2026-06-18-01",
  },
  {
    smiles: "O=C(Nc1ccc(F)cc1)c1cncc(c1)C#N",
    inchikey: fakeInchikey("O=C(Nc1ccc(F)cc1)c1cncc(c1)C#N"),
    mu: 7.4,
    sigma: 0.9,
    boltz_affinity: -1.6,
    adme_flags: ["cyp3a4_inhibition"],
    ood_flag: false,
    tag: "explore",
    rationale:
      "Moderate mu with high sigma (0.9) -> information gain candidate. ADMET flag: CYP3A4 inhibition to watch.",
    design_run_id: "DESIGN-2026-06-18-01",
  },
  {
    smiles: "Clc1ccc(cc1)C2=NN=C(S2)c3ccccc3N",
    inchikey: fakeInchikey("Clc1ccc(cc1)C2=NN=C(S2)c3ccccc3N"),
    mu: 6.9,
    sigma: 1.6,
    boltz_affinity: -1.2,
    adme_flags: ["herg_risk", "low_solubility"],
    ood_flag: true,
    tag: "explore",
    rationale:
      "Novel thiadiazole core, far from training manifold (OOD). Surrogate uncertain (sigma=1.6); Boltz used for ranking only — treat affinity as a proxy, not truth.",
    design_run_id: "DESIGN-2026-06-18-01",
  },
  {
    smiles: "COc1ccc(cc1)CNc1nccc(n1)c1ccccc1",
    inchikey: fakeInchikey("COc1ccc(cc1)CNc1nccc(n1)c1ccccc1"),
    mu: 7.1,
    sigma: 0.5,
    boltz_affinity: -1.9,
    adme_flags: [],
    ood_flag: false,
    tag: "exploit",
    rationale:
      "Aminopyrimidine hinge binder; balanced mu/sigma, clean ADMET profile. Within applicability domain.",
    design_run_id: "DESIGN-2026-06-18-01",
  },
  {
    smiles: "CC1(C)Cc2c(O1)ccc(c2)C(=O)Nc1ccncc1",
    inchikey: fakeInchikey("CC1(C)Cc2c(O1)ccc(c2)C(=O)Nc1ccncc1"),
    mu: 6.6,
    sigma: 1.2,
    boltz_affinity: -0.9,
    adme_flags: ["low_solubility"],
    ood_flag: true,
    tag: "explore",
    rationale:
      "Chromane scaffold, nearest-neighbor Tanimoto below OOD threshold. High sigma; flagged out-of-distribution.",
    design_run_id: "DESIGN-2026-06-18-01",
  },
];

export function acquisitionBatch(): AcquisitionBatch {
  return {
    target_name: "KINASE_X",
    generated: 240,
    scored: 240,
    shortlisted: CANDIDATES.length,
    candidates: JSON.parse(JSON.stringify(CANDIDATES)),
  };
}

export const TARGET: Target = {
  name: "KINASE_X",
  protein_sequence:
    "MGSSHHHHHHSSGLVPRGSHMASMTGGQQMGRGSEFMKELRDLLSPEQRQKLRDLLGGVTVAELHRLGKEILTKLGHPEVLSRLQEGAFTYVELGNSPRYIVMEYCDGGDLMSYLKQRGRLSEEEAKHFMRQILSGLEYLHSNHIVHRDLKPENILLDSEGHVKLADFGLSNIMRDGEFLRTSCGSPNYAAPEVISGKLYAGPEVDIWSCGVILYALLCGTLPFDDEHVPTLFKKIRGGVFYIPEYLNRSVATLLMHMLQVDPLKRATIKDIREHEWFKQDLPSYLFPEDPSYDANVIDDEAVKEVCEKFECTESEVMNSLYSGDPQDQLAVAYHLIIDNRRIMNQASEFYLASSPPSGSFMDDSAMHIPPGLKPHPERMPPLIADSPKARCPLDC",
  chain_ids: ["A"],
  pocket_residues: [78, 80, 83, 128, 130, 145, 147, 149, 167],
};

// --- derived views ---
export function loopSummary(): LoopSummary {
  const s = getState();
  const model_ready = s.records.filter((r) => r.status === "model_ready").length;
  const normalizable = s.records.filter((r) => r.status === "normalizable").length;
  const blocked = s.records.filter((r) => r.status === "blocked").length;
  const generated = 240;
  const scored = 240;
  const selected = CANDIDATES.length;
  const in_synthesis = s.queue.length;
  const ingested = s.records.length;
  const assayed = s.records.length;
  return {
    generated,
    scored,
    selected,
    in_synthesis,
    assayed,
    ingested,
    model_ready,
    normalizable,
    blocked,
  };
}

export function metrics(): Metrics {
  const s = getState();
  const total = s.records.length;
  const ready = s.records.filter((r) => r.status === "model_ready").length;
  const blocked_by_reason: Record<string, number> = {};
  for (const r of s.records) {
    if (r.status === "blocked" && r.blocked_reason) {
      blocked_by_reason[r.blocked_reason] =
        (blocked_by_reason[r.blocked_reason] ?? 0) + 1;
    }
  }
  const queue_depths = {
    synthesis: s.queue.length,
    assay: 0,
    ingest_pending: 0,
  };
  const errs = s.calibrationErrors;
  const calibration_error =
    errs.length > 0 ? errs.reduce((a, b) => a + b, 0) / errs.length : null;
  const cap = 2000;
  return {
    total_records: total,
    pct_model_ready: total > 0 ? (ready / total) * 100 : 0,
    blocked_by_reason,
    queue_depths,
    cycle_time_s: 1.8,
    credit_spent_usd: s.creditSpentUsd,
    credit_cap_usd: cap,
    credit_remaining_usd: cap - s.creditSpentUsd,
    calibration_error,
    calibration_n: errs.length,
  };
}

export function compoundView(inchikey: string): CompoundView | null {
  const s = getState();
  const recs = s.records.filter((r) => r.compound.inchikey === inchikey);
  if (recs.length === 0) return null;
  const first = recs[0];

  // group by comparability_key; blocked records grouped as not-poolable
  const groupsMap: Record<string, AssayRecord[]> = {};
  for (const r of recs) {
    const key = r.comparability_key ?? `unpoolable:${r.record_id}`;
    (groupsMap[key] ??= []).push(r);
  }
  const groups = Object.entries(groupsMap).map(([key, members]) => ({
    comparability_key: key,
    poolable: members.length > 1 && !key.startsWith("unpoolable:"),
    measurements: members.map((r) => ({
      record_id: r.record_id,
      assay_type: r.assay.assay_type,
      readout: r.assay.readout,
      target_construct: r.assay.target_construct ?? null,
      value: r.assay.value ?? null,
      unit: r.assay.unit ?? null,
      ki_M: r.ki_M ?? null,
      status: r.status,
      comparability_key: r.comparability_key ?? null,
    })),
  }));

  // best measured Ki
  const kis = recs.map((r) => r.ki_M).filter((v): v is number => v != null);
  const measured_ki_M = kis.length ? Math.min(...kis) : null;

  // attach a prediction for some compounds (predictions lane)
  let prediction: Prediction | null = null;
  let delta_loguM: number | null = null;
  const predictForSmiles: Record<string, Prediction> = {
    "Cc1ccc(cc1)S(=O)(=O)N": {
      smiles: "Cc1ccc(cc1)S(=O)(=O)N",
      inchikey,
      boltz_affinity_loguM: -1.4,
      adme_flags: ["good_solubility"],
      ood_flag: false,
      provenance: { source: "boltz-api", model: "boltzmol-1", run_id: "SCREEN-2026-06-17-03" },
    },
    "CC(=O)Oc1ccccc1C(=O)O": {
      smiles: "CC(=O)Oc1ccccc1C(=O)O",
      inchikey,
      boltz_affinity_loguM: -0.8,
      adme_flags: [],
      ood_flag: false,
      provenance: { source: "boltz-api", model: "boltzmol-1", run_id: "SCREEN-2026-06-17-01" },
    },
  };
  const p = predictForSmiles[first.compound.smiles];
  if (p) {
    prediction = p;
    if (measured_ki_M != null) {
      // measured Ki(M) -> log-µM
      const measuredLoguM = Math.log10(measured_ki_M / 1e-6);
      delta_loguM = Number((p.boltz_affinity_loguM - measuredLoguM).toFixed(2));
    }
  }

  return {
    inchikey,
    smiles_canonical: first.compound.smiles_canonical ?? first.compound.smiles,
    compound_id: first.compound.compound_id ?? null,
    groups,
    prediction,
    measured_ki_M,
    delta_loguM,
  };
}

// --- mutations ---
export function getRecord(recordId: string): AssayRecord | null {
  return getState().records.find((r) => r.record_id === recordId) ?? null;
}

export function listRecords(status?: string): AssayRecord[] {
  const recs = getState().records;
  return status ? recs.filter((r) => r.status === status) : recs;
}

export function postRecord(body: AssayRecordIn): AssayRecord {
  const rec = computeDerived({
    ...body,
    record_id: nextRecordId(),
    status: "model_ready",
  } as AssayRecord);
  getState().records.push(rec);
  return rec;
}

export function patchRecord(
  recordId: string,
  patch: RecordPatch,
): AssayRecord | null {
  const s = getState();
  const idx = s.records.findIndex((r) => r.record_id === recordId);
  if (idx < 0) return null;
  const cur = s.records[idx];
  const merged: AssayRecord = {
    ...cur,
    compound: { ...cur.compound, ...(patch.compound ?? {}) },
    assay: { ...cur.assay, ...(patch.assay ?? {}) },
    conditions: { ...(cur.conditions ?? {}), ...(patch.conditions ?? {}) },
    measurement: { ...(cur.measurement ?? {}), ...(patch.measurement ?? {}) },
    provenance: { ...(cur.provenance ?? {}), ...(patch.provenance ?? {}) },
  };
  const recomputed = computeDerived(merged);
  s.records[idx] = recomputed;
  return recomputed;
}

export function queueView(): QueueView {
  const s = getState();
  return { depth: s.queue.length, items: JSON.parse(JSON.stringify(s.queue)) };
}

// --- NIM tier mocks (AlphaFold2 fold, DiffDock dock) ---
export function foldMock(target: Target): FoldResult {
  const seq = target.protein_sequence ?? "";
  const h = hash32(seq);
  const plddt = Math.round((72 + (h % 230) / 10) * 10) / 10; // 72.0–95.0
  let pocket = target.pocket_residues ?? [];
  if (!pocket.length) {
    const len = seq.length || 320;
    const set = new Set<number>();
    let x = h || 1;
    for (let i = 0; i < 8; i++) {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
      set.add((x % Math.max(2, len - 1)) + 1);
    }
    pocket = Array.from(set).sort((a, b) => a - b);
  }
  return { plddt, pocket_residues: pocket, model: "alphafold2" };
}

export function dockMock(smiles: string[]): DockResponse {
  return {
    results: smiles.map((s) => {
      const h = hash32("dock|" + s);
      const conf = Math.round((0.4 + ((h % 1000) / 1000) * 0.55) * 1000) / 1000;
      return { smiles: s, dock_confidence: conf, model: "diffdock" };
    }),
  };
}

export function approveBatch() {
  const s = getState();
  s.approvedBatches += 1;
  s.creditSpentUsd += 12.5; // shortlist Boltz screen/adme spend
  const now = Date.now() / 1000;
  for (const c of CANDIDATES) {
    if (s.queue.some((q) => q.inchikey === c.inchikey)) continue;
    s.queue.push({
      smiles: c.smiles,
      inchikey: c.inchikey,
      target_construct: "KINASE_X_1-320_His",
      boltz_affinity_loguM: c.boltz_affinity ?? null,
      design_run_id: c.design_run_id ?? null,
      selected_at: now,
    });
  }
  return loopSummary();
}

export function replay(inchikeys?: string[] | null) {
  const s = getState();
  // simulate wet-lab results returning for queued candidates, re-ingested as
  // model-ready Ki records, with a calibration delta vs the Boltz prediction.
  // Mirrors backend loop._mocked_measurement: measured = pred + uniform(-0.8,1.2).
  const items = s.queue.filter(
    (q) => !inchikeys || inchikeys.includes(q.inchikey),
  );
  const newRecords: AssayRecord[] = [];
  for (const item of items) {
    const pred = item.boltz_affinity_loguM ?? 0;
    const measuredLoguM = pred + (Math.random() * 2 - 0.8);
    const ki = Math.pow(10, measuredLoguM - 6); // log µM -> M
    const rec = computeDerived({
      compound: { smiles: item.smiles, inchikey: item.inchikey },
      assay: {
        assay_id: `ASY-REPLAY-${item.inchikey.slice(0, 4)}`,
        assay_type: "SPR",
        readout: "Ki",
        target_construct: item.target_construct ?? "KINASE_X_1-320_His",
        value: ki,
        unit: "M",
      },
      conditions: { temperature_c: 25, ph: 7.4 },
      measurement: { replicates: 3, qc_flag: "pass", operator: "loop", date: "2026-06-20" },
      provenance: { source_system: "replayed-synthesis", run_id: "RUN-REPLAY" },
      record_id: nextRecordId(),
      status: "model_ready",
    } as AssayRecord);
    s.records.push(rec);
    newRecords.push(rec);

    // calibration: |Boltz pred (log-µM) - measured (log-µM)|
    if (item.boltz_affinity_loguM != null) {
      s.calibrationErrors.push(Math.abs(item.boltz_affinity_loguM - measuredLoguM));
    }
  }
  // drain the replayed items from the queue
  const replayedKeys = new Set(items.map((i) => i.inchikey));
  s.queue = s.queue.filter((q) => !replayedKeys.has(q.inchikey));
  const errs = s.calibrationErrors;
  const calibration_error =
    errs.length > 0 ? errs.reduce((a, b) => a + b, 0) / errs.length : null;
  return {
    replayed: newRecords.length,
    records: newRecords,
    calibration_error:
      calibration_error != null ? Number(calibration_error.toFixed(3)) : null,
  };
}
