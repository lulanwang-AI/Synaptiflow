import { Link, useParams } from "react-router-dom";
import { api } from "../api/client";
import { useAsync } from "../lib/useAsync";
import type { CompoundView } from "../api/types";
import StatusDot from "../components/StatusDot";
import StructureCanvas from "../components/StructureCanvas";
import { fmtMolar, fmtNum, rawValueLabel } from "../lib/format";
import { PersonaHint } from "../lib/persona";

export default function Compound() {
  const { inchikey = "" } = useParams();
  const { data, loading, error } = useAsync<CompoundView>(
    () => api.getCompound(inchikey),
    [inchikey],
  );

  return (
    <div>
      <h1>Compound</h1>
      <PersonaHint route="/compound" />
      {error && <div className="error-banner">{error}</div>}
      {loading && <p className="muted">Loading…</p>}
      {data && <CompoundBody view={data} />}
    </div>
  );
}

function CompoundBody({ view }: { view: CompoundView }) {
  return (
    <>
      <div className="panel" style={{ display: "flex", gap: "1rem", alignItems: "flex-start" }}>
        <StructureCanvas
          smiles={view.smiles_canonical ?? ""}
          width={160}
          height={130}
        />
        <div className="kv">
          <span className="muted">InChIKey</span>
          <span className="mono">{view.inchikey}</span>
          <span className="muted">Compound ID</span>
          <span className="mono">{view.compound_id ?? "—"}</span>
          <span className="muted">Canonical SMILES</span>
          <span className="mono">{view.smiles_canonical ?? "—"}</span>
          <span className="muted">Best measured Ki</span>
          <span>{fmtMolar(view.measured_ki_M)}</span>
        </div>
      </div>

      <h2>Measurements by comparability</h2>
      <p className="muted">
        Records sharing a comparability key (same construct + Ki-comparable
        readout) can be pooled; others cannot. Comparability is never fabricated.
      </p>

      {view.groups.length === 0 && <p className="muted">No measurements.</p>}

      {view.groups.map((g) => (
        <div className="panel" key={g.comparability_key} style={{ marginBottom: "0.85rem" }}>
          <h3 style={{ marginTop: 0 }}>
            <span className="mono">{g.comparability_key}</span>{" "}
            <span
              className={`chip ${g.poolable ? "" : "chip-warn"}`}
              style={
                g.poolable
                  ? { background: "var(--green-bg)", color: "var(--green)", borderColor: "#b7dfc2" }
                  : undefined
              }
            >
              {g.poolable ? "poolable" : "not comparable"}
            </span>
          </h3>
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>Record</th>
                <th>Assay</th>
                <th>Readout</th>
                <th>Value</th>
                <th>Construct</th>
                <th>Ki</th>
              </tr>
            </thead>
            <tbody>
              {g.measurements.map((m) => (
                <tr key={m.record_id} style={{ cursor: "default" }}>
                  <td>
                    <StatusDot status={m.status} withLabel={false} />
                  </td>
                  <td className="mono">{m.record_id}</td>
                  <td>{m.assay_type}</td>
                  <td>{m.readout}</td>
                  <td>{rawValueLabel(m.value, m.unit)}</td>
                  <td>{m.target_construct ?? "—"}</td>
                  <td>{fmtMolar(m.ki_M)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      <h2>Surrogate calibration — predicted vs measured</h2>
      {view.prediction ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
          <div className="measured-card">
            <h3 style={{ marginTop: 0 }}>Measured (ground truth)</h3>
            <div className="kv">
              <span className="muted">Best Ki</span>
              <span>{fmtMolar(view.measured_ki_M)}</span>
              <span className="muted">log-µM</span>
              <span>
                {view.measured_ki_M != null
                  ? fmtNum(Math.log10(view.measured_ki_M / 1e-6))
                  : "—"}
              </span>
            </div>
          </div>

          <div className="prediction-card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3 style={{ margin: 0 }}>Boltz prediction</h3>
              <span className="predicted-badge">PREDICTED — not measured</span>
            </div>
            <div className="kv" style={{ marginTop: "0.5rem" }}>
              <span className="muted">Affinity (log-µM proxy)</span>
              <span>{fmtNum(view.prediction.boltz_affinity_loguM)}</span>
              <span className="muted">ADMET flags</span>
              <span>
                {view.prediction.adme_flags.length
                  ? view.prediction.adme_flags.map((f) => (
                      <span key={f} className="chip chip-warn">
                        {f}
                      </span>
                    ))
                  : "—"}
              </span>
              <span className="muted">OOD</span>
              <span>
                {view.prediction.ood_flag ? (
                  <span className="ood-flag">OUT OF DISTRIBUTION</span>
                ) : (
                  "in distribution"
                )}
              </span>
              <span className="muted">Provenance</span>
              <span className="mono">
                {view.prediction.provenance.source} /{" "}
                {view.prediction.provenance.model} /{" "}
                {view.prediction.provenance.run_id ?? "—"}
              </span>
            </div>
          </div>

          <div className="panel" style={{ gridColumn: "1 / -1" }}>
            <strong>Δ (predicted − measured), log-µM:</strong>{" "}
            <span style={{ fontSize: "1.2rem", fontWeight: 700 }}>
              {view.delta_loguM != null ? fmtNum(view.delta_loguM) : "—"}
            </span>{" "}
            <span className="muted">
              — the calibration signal. Boltz affinity is an assay-agnostic
              ranking proxy, never ingested as an assay record.
            </span>
          </div>
        </div>
      ) : (
        <p className="muted">
          No Boltz prediction on file for this compound. Predictions, when
          present, are shown in a visually distinct lane and never mixed with
          measurements.
        </p>
      )}

      <p style={{ marginTop: "1rem" }}>
        <Link to="/records">← back to records</Link>
      </p>
    </>
  );
}
