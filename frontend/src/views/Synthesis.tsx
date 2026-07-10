// Synthesis queue — the outer-loop hand-off: approved candidates wait here for
// (mocked) wet-lab results. "Replay results" returns synthetic ground truth,
// re-ingests it as model-ready Ki records, and updates surrogate calibration.
// Reads GET /loop/queue; closes the loop via POST /loop/replay.

import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { useAsync } from "../lib/useAsync";
import type { AssayRecord, QueueView } from "../api/types";
import StructureCanvas from "../components/StructureCanvas";
import StatusDot from "../components/StatusDot";
import { fmtNum } from "../lib/format";
import { PersonaHint } from "../lib/persona";

function whenLabel(selectedAt?: number | null): string {
  if (selectedAt == null) return "—";
  const secsAgo = Math.max(0, Date.now() / 1000 - selectedAt);
  if (secsAgo < 90) return `${Math.round(secsAgo)}s ago`;
  if (secsAgo < 5400) return `${Math.round(secsAgo / 60)}m ago`;
  return new Date(selectedAt * 1000).toLocaleString();
}

export default function Synthesis() {
  const { data, loading, error, reload } = useAsync<QueueView>(() =>
    api.loopQueue(),
  );
  const [busy, setBusy] = useState(false);
  const [actError, setActError] = useState<string | null>(null);
  const [replayed, setReplayed] = useState<AssayRecord[]>([]);
  const [calib, setCalib] = useState<number | null>(null);

  async function replay() {
    setBusy(true);
    setActError(null);
    try {
      const res = await api.loopReplay();
      setReplayed(res.records);
      setCalib(res.calibration_error ?? null);
      reload();
    } catch (e) {
      setActError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const items = data?.items ?? [];

  return (
    <div>
      <h1>Synthesis queue</h1>
      <p className="muted">
        The outer-loop hand-off: candidates approved on{" "}
        <Link to="/acquisition">Next batch</Link> wait here for wet-lab results.
        Replaying returns (mocked) ground-truth Ki, re-ingests it, and feeds the
        predicted-vs-measured delta back as surrogate calibration.
      </p>
      <PersonaHint route="/synthesis" />

      <div className="panel" style={{ marginBottom: "1rem" }}>
        <div className="kv">
          <span className="muted">In synthesis</span>
          <span>
            <strong>{data?.depth ?? 0}</strong> candidate(s) awaiting assay
          </span>
        </div>
        <div style={{ marginTop: "0.75rem", display: "flex", gap: "0.6rem" }}>
          <button
            className="btn btn-primary"
            onClick={replay}
            disabled={busy || items.length === 0}
          >
            {busy ? "Replaying…" : "Replay results → ingest"}
          </button>
          <button className="btn" onClick={reload} disabled={busy}>
            Refresh
          </button>
        </div>
        {calib != null && (
          <div className="persona-hint" style={{ marginTop: "0.75rem" }}>
            Re-ingested wet-lab results. Surrogate calibration error now{" "}
            <strong>{fmtNum(calib, 3)}</strong> log-µM.
          </div>
        )}
        {actError && (
          <div className="error-banner" style={{ marginTop: "0.75rem" }}>
            {actError}
          </div>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}
      {loading && <p className="muted">Loading…</p>}

      {!loading && items.length === 0 ? (
        <div className="panel">
          <p className="muted" style={{ margin: 0 }}>
            Queue is empty. Approve a batch on{" "}
            <Link to="/acquisition">Next batch</Link> to move candidates into
            synthesis.
          </p>
        </div>
      ) : (
        <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
          <table>
            <thead>
              <tr>
                <th>Compound</th>
                <th>Construct</th>
                <th>Boltz affinity</th>
                <th>Design run</th>
                <th>Selected</th>
              </tr>
            </thead>
            <tbody>
              {items.map((q) => (
                <tr key={q.inchikey} style={{ cursor: "default" }}>
                  <td>
                    <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                      <StructureCanvas smiles={q.smiles} width={70} height={54} />
                      <Link to={`/compound/${q.inchikey}`} className="mono" style={{ wordBreak: "break-all" }}>
                        {q.inchikey}
                      </Link>
                    </div>
                  </td>
                  <td>{q.target_construct ?? "—"}</td>
                  <td>
                    <span style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
                      {q.boltz_affinity_loguM != null ? fmtNum(q.boltz_affinity_loguM) : "—"}
                      <span className="predicted-badge">PREDICTED · log-µM</span>
                    </span>
                  </td>
                  <td className="mono" style={{ fontSize: "0.74rem", wordBreak: "break-all" }}>
                    {q.design_run_id ?? "—"}
                  </td>
                  <td className="muted" style={{ whiteSpace: "nowrap" }}>{whenLabel(q.selected_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {replayed.length > 0 && (
        <div style={{ marginTop: "1.5rem" }}>
          <h2>Returned wet-lab results</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            Re-ingested as ground-truth Ki — these are now part of the training
            set and the predicted-vs-measured calibration.
          </p>
          <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
            <table>
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Record</th>
                  <th>Compound</th>
                  <th>Measured Ki</th>
                </tr>
              </thead>
              <tbody>
                {replayed.map((r) => (
                  <tr key={r.record_id} style={{ cursor: "default" }}>
                    <td><StatusDot status={r.status} /></td>
                    <td className="mono" style={{ whiteSpace: "nowrap" }}>{r.record_id}</td>
                    <td>
                      <Link to={`/compound/${r.compound.inchikey}`} className="mono" style={{ wordBreak: "break-all" }}>
                        {r.compound.inchikey}
                      </Link>
                    </td>
                    <td>{r.ki_M != null ? `${r.ki_M.toExponential(2)} M` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
