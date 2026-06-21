// Assay-data intake — a standard drug-discovery-style form for inserting a
// measurement into the closed loop. The submitted record flows through the same
// real pipeline as everything else: POST /records -> ingest (identity +
// Cheng-Prusoff normalization + status) -> activity store -> loop counts.
//
// Status is NOT computed here: we post the raw record and render the
// authoritative status the backend (or MSW mock) returns. That keeps a single
// source of truth for the "model-ready" policy.

import { useMemo, useState, type ChangeEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { AssayRecord, AssayRecordIn } from "../api/types";
import StatusDot from "../components/StatusDot";
import StructureCanvas from "../components/StructureCanvas";
import { PersonaHint } from "../lib/persona";
import { STATUS_LABEL, rawValueLabel } from "../lib/format";

// --- form shape: every input is a string; coerced on submit ----------------
interface FormState {
  compound: { smiles: string; batch_id: string };
  assay: {
    assay_id: string;
    assay_type: string;
    readout: string;
    target_construct: string;
    value: string;
    unit: string;
  };
  conditions: {
    temperature_c: string;
    buffer: string;
    ph: string;
    substrate_conc_M: string;
    km_M: string;
    ligand_conc_M: string;
    probe_kd_M: string;
  };
  measurement: {
    replicates: string;
    std_error: string;
    qc_flag: string;
    operator: string;
    date: string;
  };
  provenance: { source_system: string; run_id: string; protocol_ref: string };
}

const EMPTY: FormState = {
  compound: { smiles: "", batch_id: "" },
  assay: {
    assay_id: "",
    assay_type: "SPR",
    readout: "Ki",
    target_construct: "",
    value: "",
    unit: "M",
  },
  conditions: {
    temperature_c: "",
    buffer: "",
    ph: "",
    substrate_conc_M: "",
    km_M: "",
    ligand_conc_M: "",
    probe_kd_M: "",
  },
  measurement: {
    replicates: "",
    std_error: "",
    qc_flag: "pass",
    operator: "",
    date: "",
  },
  provenance: { source_system: "", run_id: "", protocol_ref: "" },
};

const ASSAY_TYPES = ["SPR", "ITC", "DSF", "FP", "enzymatic_IC50", "radioligand", "other"];
const READOUTS = ["Kd", "Ki", "IC50", "pct_inhibition", "dTm", "kon", "koff"];
const UNITS = ["M", "mM", "µM", "nM", "pM"];
const QC_FLAGS = ["pass", "aggregator", "fluorescence_interference", "fail"];
const CONSTRUCTS = ["KINASE_X_1-320_His", "KINASE_X_2-300_His"];
const SOURCES = ["Benchling-ELN", "Dotmatics", "CDD Vault", "instrument-direct"];

// --- demo presets: one per status path, so a reviewer can see the policy ----
const PRESETS: { label: string; form: FormState }[] = [
  {
    label: "SPR · Ki → model-ready (green)",
    form: {
      compound: { smiles: "Cc1ccc(cc1)S(=O)(=O)N", batch_id: "" },
      assay: { assay_id: "ASY-SPR-DEMO1", assay_type: "SPR", readout: "Ki", target_construct: "KINASE_X_1-320_His", value: "5.0e-8", unit: "M" },
      conditions: { temperature_c: "25", buffer: "HBS-EP, 0.05% Tween", ph: "7.4", substrate_conc_M: "", km_M: "", ligand_conc_M: "", probe_kd_M: "" },
      measurement: { replicates: "3", std_error: "8e-9", qc_flag: "pass", operator: "demo", date: "2026-06-21" },
      provenance: { source_system: "Benchling-ELN", run_id: "RUN-DEMO-01", protocol_ref: "SOP-SPR-014" },
    },
  },
  {
    label: "Enzymatic IC50 · no conditions → blocked",
    form: {
      compound: { smiles: "Cn1cnc2c1c(=O)n(C)c(=O)n2C", batch_id: "" },
      assay: { assay_id: "ASY-ENZ-DEMO2", assay_type: "enzymatic_IC50", readout: "IC50", target_construct: "KINASE_X_1-320_His", value: "5.0e-7", unit: "M" },
      conditions: { temperature_c: "30", buffer: "", ph: "7.4", substrate_conc_M: "", km_M: "", ligand_conc_M: "", probe_kd_M: "" },
      measurement: { replicates: "3", std_error: "", qc_flag: "pass", operator: "demo", date: "2026-06-21" },
      provenance: { source_system: "Dotmatics", run_id: "RUN-DEMO-02", protocol_ref: "" },
    },
  },
  {
    label: "Enzymatic IC50 · +[S]/Km → normalizes to Ki (green)",
    form: {
      compound: { smiles: "Cn1cnc2c1c(=O)n(C)c(=O)n2C", batch_id: "" },
      assay: { assay_id: "ASY-ENZ-DEMO3", assay_type: "enzymatic_IC50", readout: "IC50", target_construct: "KINASE_X_1-320_His", value: "5.0e-7", unit: "M" },
      conditions: { temperature_c: "30", buffer: "", ph: "7.4", substrate_conc_M: "1.0e-4", km_M: "5.0e-5", ligand_conc_M: "", probe_kd_M: "" },
      measurement: { replicates: "3", std_error: "", qc_flag: "pass", operator: "demo", date: "2026-06-21" },
      provenance: { source_system: "Dotmatics", run_id: "RUN-DEMO-03", protocol_ref: "SOP-ENZ-003" },
    },
  },
  {
    label: "Radioligand IC50 · +[L]/probe Kd → Ki (green)",
    form: {
      compound: { smiles: "CN1CCC[C@H]1c1cccnc1", batch_id: "" },
      assay: { assay_id: "ASY-RAD-DEMO4", assay_type: "radioligand", readout: "IC50", target_construct: "KINASE_X_1-320_His", value: "2.0e-7", unit: "M" },
      conditions: { temperature_c: "25", buffer: "", ph: "7.4", substrate_conc_M: "", km_M: "", ligand_conc_M: "5.0e-9", probe_kd_M: "1.0e-9" },
      measurement: { replicates: "3", std_error: "", qc_flag: "pass", operator: "demo", date: "2026-06-21" },
      provenance: { source_system: "CDD Vault", run_id: "RUN-DEMO-04", protocol_ref: "" },
    },
  },
  {
    label: "SPR · Ki · aggregator QC → normalizable (amber)",
    form: {
      compound: { smiles: "Cc1ccc(cc1)S(=O)(=O)N", batch_id: "" },
      assay: { assay_id: "ASY-DSF-DEMO5", assay_type: "DSF", readout: "Ki", target_construct: "KINASE_X_2-300_His", value: "7.0e-8", unit: "M" },
      conditions: { temperature_c: "25", buffer: "", ph: "7.4", substrate_conc_M: "", km_M: "", ligand_conc_M: "", probe_kd_M: "" },
      measurement: { replicates: "3", std_error: "", qc_flag: "aggregator", operator: "demo", date: "2026-06-21" },
      provenance: { source_system: "Benchling-ELN", run_id: "RUN-DEMO-05", protocol_ref: "" },
    },
  },
  {
    label: "SPR · Kd · no construct → blocked",
    form: {
      compound: { smiles: "O=C(O)c1ccccc1Nc1ccccc1Cl", batch_id: "" },
      assay: { assay_id: "ASY-SPR-DEMO6", assay_type: "SPR", readout: "Kd", target_construct: "", value: "3.0e-7", unit: "M" },
      conditions: { temperature_c: "25", buffer: "", ph: "7.4", substrate_conc_M: "", km_M: "", ligand_conc_M: "", probe_kd_M: "" },
      measurement: { replicates: "2", std_error: "", qc_flag: "pass", operator: "demo", date: "2026-06-21" },
      provenance: { source_system: "instrument-direct", run_id: "RUN-DEMO-06", protocol_ref: "" },
    },
  },
];

// --- coercion helpers -------------------------------------------------------
const opt = (s: string): string | null => (s.trim() === "" ? null : s.trim());
const num = (s: string): number | null => {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
const int = (s: string): number | null => {
  const n = num(s);
  return n == null ? null : Math.round(n);
};

function buildBody(f: FormState): AssayRecordIn {
  return {
    compound: { smiles: f.compound.smiles.trim(), batch_id: opt(f.compound.batch_id) },
    assay: {
      assay_id: opt(f.assay.assay_id),
      assay_type: f.assay.assay_type,
      readout: f.assay.readout,
      target_construct: opt(f.assay.target_construct),
      value: num(f.assay.value),
      unit: opt(f.assay.unit),
    },
    conditions: {
      temperature_c: num(f.conditions.temperature_c),
      buffer: opt(f.conditions.buffer),
      ph: num(f.conditions.ph),
      substrate_conc_M: num(f.conditions.substrate_conc_M),
      km_M: num(f.conditions.km_M),
      ligand_conc_M: num(f.conditions.ligand_conc_M),
      probe_kd_M: num(f.conditions.probe_kd_M),
    },
    measurement: {
      replicates: int(f.measurement.replicates),
      std_error: num(f.measurement.std_error),
      qc_flag: f.measurement.qc_flag,
      operator: opt(f.measurement.operator),
      date: opt(f.measurement.date),
    },
    provenance: {
      source_system: opt(f.provenance.source_system),
      run_id: opt(f.provenance.run_id),
      protocol_ref: opt(f.provenance.protocol_ref),
    },
  };
}

// --- small field wrapper ----------------------------------------------------
function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="form-row">
      <label>
        {label}
        {required && <span className="required"> *</span>}
      </label>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}

function SectionHead({ n, title, note }: { n: number; title: string; note?: string }) {
  return (
    <div className="section-head">
      <span className="step-no">{n}</span>
      <h3 style={{ margin: 0 }}>{title}</h3>
      {note && <span className="muted" style={{ fontSize: "0.78rem" }}>{note}</span>}
    </div>
  );
}

export default function Intake() {
  const [form, setForm] = useState<FormState>(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<AssayRecord[]>([]);

  const isIC50 = form.assay.readout === "IC50";

  // generic immutable updater for any (section, field) pair
  const upd =
    (section: keyof FormState, key: string) =>
    (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm(
        (f) =>
          ({
            ...f,
            [section]: { ...(f[section] as Record<string, string>), [key]: e.target.value },
          }) as FormState,
      );

  function loadPreset(idx: number) {
    setError(null);
    setForm(JSON.parse(JSON.stringify(PRESETS[idx].form)) as FormState);
  }

  async function onSubmit() {
    setError(null);
    if (!form.compound.smiles.trim()) {
      setError("SMILES is required — it is the working compound identity.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.postRecord(buildBody(form));
      setSubmitted((prev) => [res.record, ...prev]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const ic50Note = useMemo(() => {
    if (!isIC50) return null;
    const enzyme = form.conditions.substrate_conc_M && form.conditions.km_M;
    const radio = form.conditions.ligand_conc_M && form.conditions.probe_kd_M;
    if (enzyme || radio) return null;
    return "IC50 needs either [S]+Km (enzyme) or [L]+probe Kd (radioligand) to derive Ki — otherwise this ingests as blocked: missing_conditions.";
  }, [isIC50, form.conditions]);

  return (
    <div>
      <h1>Assay data intake</h1>
      <p className="muted">
        Insert a measurement into the loop. On submit it runs the real pipeline —
        identity resolution, Cheng–Prusoff normalization, and the model-ready
        status policy — then lands in the activity store and updates the loop
        counts. Affinity is never coerced: incomplete semantics surface as a
        status, not a fabricated number.
      </p>
      <PersonaHint route="/submit" />

      <div
        className="panel"
        style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}
      >
        <strong style={{ fontSize: "0.85rem" }}>Load demo data:</strong>
        <select
          defaultValue=""
          onChange={(e) => {
            if (e.target.value !== "") loadPreset(Number(e.target.value));
            e.currentTarget.selectedIndex = 0;
          }}
          style={{ fontSize: "0.85rem", padding: "0.3rem 0.4rem" }}
        >
          <option value="">Choose an example…</option>
          {PRESETS.map((p, i) => (
            <option key={p.label} value={i}>
              {p.label}
            </option>
          ))}
        </select>
        <button className="btn" onClick={() => setForm(EMPTY)}>
          Clear form
        </button>
      </div>

      <div style={{ display: "flex", gap: "1.25rem", alignItems: "flex-start", marginTop: "1rem", flexWrap: "wrap" }}>
        {/* ---------------- the form ---------------- */}
        <div className="panel" style={{ flex: "1 1 560px", minWidth: 320 }}>
          <SectionHead n={1} title="Compound" note="working representation" />
          <div className="form-grid">
            <Field label="SMILES" required hint="canonicalized to an InChIKey on ingest">
              <input
                type="text"
                placeholder="e.g. Cc1ccc(cc1)S(=O)(=O)N"
                value={form.compound.smiles}
                onChange={upd("compound", "smiles")}
              />
            </Field>
            <Field label="Batch id" hint="optional — salt/batch is metadata">
              <input type="text" value={form.compound.batch_id} onChange={upd("compound", "batch_id")} />
            </Field>
          </div>

          <SectionHead n={2} title="Assay" note="what was measured" />
          <div className="form-grid">
            <Field label="Assay id">
              <input type="text" value={form.assay.assay_id} onChange={upd("assay", "assay_id")} />
            </Field>
            <Field label="Assay type" required>
              <select value={form.assay.assay_type} onChange={upd("assay", "assay_type")}>
                {ASSAY_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </Field>
            <Field label="Readout" required hint="Kd/Ki are condition-light; IC50 needs conditions">
              <select value={form.assay.readout} onChange={upd("assay", "readout")}>
                {READOUTS.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </Field>
            <Field label="Target construct" hint="exact construct gates model-readiness">
              <input
                type="text"
                list="construct-list"
                placeholder="KINASE_X_1-320_His"
                value={form.assay.target_construct}
                onChange={upd("assay", "target_construct")}
              />
              <datalist id="construct-list">
                {CONSTRUCTS.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </Field>
            <Field label="Value">
              <input
                type="text"
                inputMode="decimal"
                placeholder="e.g. 5.0e-8"
                value={form.assay.value}
                onChange={upd("assay", "value")}
              />
            </Field>
            <Field label="Unit" hint="normalized to molar internally">
              <select value={form.assay.unit} onChange={upd("assay", "unit")}>
                <option value="">(none)</option>
                {UNITS.map((u) => (
                  <option key={u} value={u}>{u}</option>
                ))}
              </select>
            </Field>
          </div>

          <SectionHead n={3} title="Conditions" note="required to compare / normalize" />
          <div className="form-grid">
            <Field label="Temperature (°C)">
              <input type="text" inputMode="decimal" value={form.conditions.temperature_c} onChange={upd("conditions", "temperature_c")} />
            </Field>
            <Field label="Buffer">
              <input type="text" value={form.conditions.buffer} onChange={upd("conditions", "buffer")} />
            </Field>
            <Field label="pH">
              <input type="text" inputMode="decimal" value={form.conditions.ph} onChange={upd("conditions", "ph")} />
            </Field>
          </div>

          {isIC50 && (
            <div className="cp-block">
              <div className="muted" style={{ fontSize: "0.8rem", marginBottom: "0.4rem" }}>
                Cheng–Prusoff inputs (provide <em>one</em> complete pair to derive Ki)
              </div>
              <div className="form-grid">
                <Field label="Substrate conc [S] (M)" hint="enzyme: Ki = IC50 / (1 + [S]/Km)">
                  <input type="text" inputMode="decimal" placeholder="1.0e-4" value={form.conditions.substrate_conc_M} onChange={upd("conditions", "substrate_conc_M")} />
                </Field>
                <Field label="Km (M)">
                  <input type="text" inputMode="decimal" placeholder="5.0e-5" value={form.conditions.km_M} onChange={upd("conditions", "km_M")} />
                </Field>
                <Field label="Ligand conc [L] (M)" hint="radioligand: Ki = IC50 / (1 + [L]/Kd)">
                  <input type="text" inputMode="decimal" placeholder="5.0e-9" value={form.conditions.ligand_conc_M} onChange={upd("conditions", "ligand_conc_M")} />
                </Field>
                <Field label="Probe Kd (M)">
                  <input type="text" inputMode="decimal" placeholder="1.0e-9" value={form.conditions.probe_kd_M} onChange={upd("conditions", "probe_kd_M")} />
                </Field>
              </div>
              {ic50Note && <div className="chip chip-warn" style={{ marginTop: "0.3rem" }}>{ic50Note}</div>}
            </div>
          )}

          <SectionHead n={4} title="Measurement & QC" />
          <div className="form-grid">
            <Field label="Replicates">
              <input type="text" inputMode="numeric" value={form.measurement.replicates} onChange={upd("measurement", "replicates")} />
            </Field>
            <Field label="Std error">
              <input type="text" inputMode="decimal" value={form.measurement.std_error} onChange={upd("measurement", "std_error")} />
            </Field>
            <Field label="QC flag" hint="fail → blocked; aggregator/fluorescence → normalizable">
              <select value={form.measurement.qc_flag} onChange={upd("measurement", "qc_flag")}>
                {QC_FLAGS.map((q) => (
                  <option key={q} value={q}>{q}</option>
                ))}
              </select>
            </Field>
            <Field label="Operator">
              <input type="text" value={form.measurement.operator} onChange={upd("measurement", "operator")} />
            </Field>
            <Field label="Date">
              <input type="date" value={form.measurement.date} onChange={upd("measurement", "date")} />
            </Field>
          </div>

          <SectionHead n={5} title="Provenance" />
          <div className="form-grid">
            <Field label="Source system">
              <input type="text" list="source-list" value={form.provenance.source_system} onChange={upd("provenance", "source_system")} />
              <datalist id="source-list">
                {SOURCES.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </Field>
            <Field label="Run id">
              <input type="text" value={form.provenance.run_id} onChange={upd("provenance", "run_id")} />
            </Field>
            <Field label="Protocol ref">
              <input type="text" value={form.provenance.protocol_ref} onChange={upd("provenance", "protocol_ref")} />
            </Field>
          </div>

          {error && <div className="error-banner" style={{ marginTop: "1rem" }}>{error}</div>}

          <div style={{ marginTop: "1rem", display: "flex", gap: "0.5rem" }}>
            <button className="btn btn-primary" onClick={onSubmit} disabled={submitting}>
              {submitting ? "Submitting…" : "Submit to loop"}
            </button>
          </div>
        </div>

        {/* ---------------- live structure preview ---------------- */}
        <div className="panel" style={{ flex: "0 0 220px" }}>
          <h3 style={{ marginTop: 0 }}>Structure preview</h3>
          {form.compound.smiles.trim() ? (
            <StructureCanvas smiles={form.compound.smiles} width={188} height={150} />
          ) : (
            <p className="muted" style={{ fontSize: "0.82rem" }}>Enter a SMILES to preview.</p>
          )}
        </div>
      </div>

      {/* ---------------- ingest results ---------------- */}
      {submitted.length > 0 && (
        <div style={{ marginTop: "1.5rem" }}>
          <h2>Submitted this session</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            Status was computed by the pipeline at ingest — quoted verbatim below.
          </p>
          <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
            <table>
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Record</th>
                  <th>Compound</th>
                  <th>Assay</th>
                  <th>Derived Ki</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {submitted.map((r) => (
                  <tr key={r.record_id} style={{ cursor: "default" }}>
                    <td>
                      <StatusDot status={r.status} />{" "}
                      <span style={{ fontSize: "0.78rem" }}>{STATUS_LABEL[r.status]}</span>
                    </td>
                    <td className="mono" style={{ whiteSpace: "nowrap" }}>{r.record_id}</td>
                    <td>
                      <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
                        <StructureCanvas smiles={r.compound.smiles} width={56} height={44} />
                        {r.compound.inchikey ? (
                          <Link to={`/compound/${r.compound.inchikey}`} className="mono">
                            {r.compound.inchikey}
                          </Link>
                        ) : (
                          <span className="mono">—</span>
                        )}
                      </div>
                    </td>
                    <td style={{ fontSize: "0.82rem" }}>
                      {r.assay.assay_type} · {r.assay.readout} ·{" "}
                      {rawValueLabel(r.assay.value, r.assay.unit)}
                    </td>
                    <td>{r.ki_M != null ? `${r.ki_M.toExponential(2)} M` : "—"}</td>
                    <td className="mono" style={{ fontSize: "0.74rem", maxWidth: 320 }}>
                      {r.reason_detail ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={{ marginTop: "0.6rem", fontSize: "0.85rem" }}>
            → See it in the <Link to="/records">records table</Link> or on the{" "}
            <Link to="/">loop overview</Link>.
          </p>
        </div>
      )}
    </div>
  );
}
