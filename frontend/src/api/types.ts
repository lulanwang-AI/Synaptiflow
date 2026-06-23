// Typed models mirroring docs/openapi.json (FROZEN contract).
// Field names match the API exactly.

export type RecordStatus = "model_ready" | "normalizable" | "blocked";

export type BlockedReason =
  | "missing_identity"
  | "missing_construct"
  | "missing_unit"
  | "missing_conditions"
  | "qc_fail";

export interface Compound {
  smiles: string;
  smiles_canonical?: string | null;
  inchikey?: string | null;
  compound_id?: string | null;
  batch_id?: string | null;
}

export interface Assay {
  assay_id?: string | null;
  assay_type: string;
  readout: string;
  target_construct?: string | null;
  value?: number | null;
  unit?: string | null;
}

export interface Conditions {
  temperature_c?: number | null;
  buffer?: string | null;
  ph?: number | null;
  substrate_conc_M?: number | null;
  km_M?: number | null;
  ligand_conc_M?: number | null;
  probe_kd_M?: number | null;
}

export interface Measurement {
  replicates?: number | null;
  std_error?: number | null;
  qc_flag?: string | null;
  operator?: string | null;
  date?: string | null;
}

export interface Provenance {
  source_system?: string | null;
  run_id?: string | null;
  protocol_ref?: string | null;
}

export interface AssayRecord {
  compound: Compound;
  assay: Assay;
  conditions?: Conditions;
  measurement?: Measurement;
  provenance?: Provenance;
  record_id: string;
  status: RecordStatus;
  blocked_reason?: BlockedReason | null;
  reason_detail?: string | null;
  missing_fields?: string[];
  value_M?: number | null;
  ki_M?: number | null;
  comparability_key?: string | null;
}

export interface AssayRecordIn {
  compound: Compound;
  assay: Assay;
  conditions?: Conditions;
  measurement?: Measurement;
  provenance?: Provenance;
}

export interface RecordPatch {
  compound?: Compound | null;
  assay?: Assay | null;
  conditions?: Conditions | null;
  measurement?: Measurement | null;
  provenance?: Provenance | null;
}

export interface IngestResponse {
  record: AssayRecord;
}

export interface LoopSummary {
  generated: number;
  scored: number;
  selected: number;
  in_synthesis: number;
  assayed: number;
  ingested: number;
  model_ready: number;
  normalizable: number;
  blocked: number;
}

export interface CompoundMeasurement {
  record_id: string;
  assay_type: string;
  readout: string;
  target_construct?: string | null;
  value?: number | null;
  unit?: string | null;
  ki_M?: number | null;
  status: RecordStatus;
  comparability_key?: string | null;
}

export interface ComparabilityGroup {
  comparability_key: string;
  poolable: boolean;
  measurements: CompoundMeasurement[];
}

export interface PredictionProvenance {
  source: string;
  model: string;
  run_id?: string | null;
}

export interface Prediction {
  smiles: string;
  inchikey: string;
  boltz_affinity_loguM: number;
  adme_flags: string[];
  ood_flag: boolean;
  provenance: PredictionProvenance;
}

export interface CompoundView {
  inchikey: string;
  smiles_canonical?: string | null;
  compound_id?: string | null;
  groups: ComparabilityGroup[];
  prediction?: Prediction | null;
  measured_ki_M?: number | null;
  delta_loguM?: number | null;
}

export interface AcquisitionCandidate {
  smiles: string;
  inchikey: string;
  mu: number;
  sigma: number;
  boltz_affinity?: number | null;
  adme_flags: string[];
  ood_flag: boolean;
  tag: string;
  rationale: string;
  design_run_id?: string | null;
}

export interface AcquisitionBatch {
  target_name?: string | null;
  generated: number;
  scored: number;
  shortlisted: number;
  candidates: AcquisitionCandidate[];
}

export interface ReplayRequest {
  inchikeys?: string[] | null;
}

export interface ReplayResponse {
  replayed: number;
  records: AssayRecord[];
  calibration_error?: number | null;
}

export interface Metrics {
  total_records: number;
  pct_model_ready: number;
  blocked_by_reason: Record<string, number>;
  queue_depths: Record<string, number>;
  cycle_time_s?: number | null;
  credit_spent_usd: number;
  credit_cap_usd: number;
  credit_remaining_usd: number;
  calibration_error?: number | null;
  calibration_n: number;
}

export interface Target {
  name?: string | null;
  protein_sequence: string;
  chain_ids: string[];
  pocket_residues: number[];
}

export interface ResetResponse {
  ok: boolean;
  records: number;
}

export interface QueueItem {
  smiles: string;
  inchikey: string;
  target_construct?: string | null;
  boltz_affinity_loguM?: number | null;
  design_run_id?: string | null;
  selected_at?: number | null;
}

export interface QueueView {
  depth: number;
  items: QueueItem[];
}

export interface FoldResult {
  plddt: number;
  pocket_residues: number[];
  model: string;
}

export interface DockResult {
  smiles: string;
  dock_confidence: number;
  model: string;
}

export interface DockResponse {
  results: DockResult[];
}

export interface PoseResult {
  smiles: string;
  sdf?: string | null;
  model: string;
}
