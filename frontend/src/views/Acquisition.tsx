import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { useAsync } from "../lib/useAsync";
import type { AcquisitionBatch, AcquisitionCandidate } from "../api/types";
import StructureCanvas from "../components/StructureCanvas";
import { fmtNum } from "../lib/format";
import { PersonaHint } from "../lib/persona";

function CandidateCard({ c }: { c: AcquisitionCandidate }) {
  return (
    <div
      className="panel"
      style={c.ood_flag ? { borderColor: "var(--red)", borderWidth: 2 } : undefined}
    >
      <div style={{ display: "flex", gap: "0.75rem", alignItems: "flex-start" }}>
        <StructureCanvas smiles={c.smiles} width={120} height={100} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", gap: "0.4rem", alignItems: "center", flexWrap: "wrap" }}>
            <span className={`tag tag-${c.tag === "exploit" ? "exploit" : "explore"}`}>
              {c.tag}
            </span>
            {c.ood_flag && <span className="ood-flag">⚠ OOD</span>}
            <Link to={`/compound/${c.inchikey}`} className="mono" style={{ fontSize: "0.78rem", wordBreak: "break-all" }}>
              {c.inchikey}
            </Link>
          </div>
        </div>
      </div>
      <div className="kv" style={{ marginTop: "0.6rem" }}>
        <span className="muted">Surrogate µ ± σ (pKi)</span>
        <span>
          <strong>{fmtNum(c.mu)}</strong> ± {fmtNum(c.sigma)}
        </span>
        <span className="muted">Boltz affinity</span>
        <span style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
          {c.boltz_affinity != null ? fmtNum(c.boltz_affinity) : "—"}
          <span className="predicted-badge">predicted · log-µM</span>
        </span>
        <span className="muted">ADMET</span>
        <span>
          {c.adme_flags.length
            ? c.adme_flags.map((f) => (
                <span key={f} className="chip chip-warn">
                  {f}
                </span>
              ))
            : "clean"}
        </span>
        <span className="muted">Design run</span>
        <span className="mono" style={{ wordBreak: "break-all" }}>{c.design_run_id ?? "—"}</span>
      </div>
      <p style={{ marginTop: "0.6rem", marginBottom: 0, fontSize: "0.86rem" }}>
        <span className="muted">Rationale: </span>
        {c.rationale}
      </p>
    </div>
  );
}

export default function Acquisition() {
  const { data, loading, error } = useAsync<AcquisitionBatch>(() =>
    api.acquisitionBatch(),
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actError, setActError] = useState<string | null>(null);

  async function approve() {
    setBusy("approve");
    setActError(null);
    setNotice(null);
    try {
      const summary = await api.acquisitionApprove();
      setNotice(
        `Batch approved → synthesis queue. in_synthesis=${summary.in_synthesis}, selected=${summary.selected}.`,
      );
    } catch (e) {
      setActError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function replay() {
    setBusy("replay");
    setActError(null);
    setNotice(null);
    try {
      const res = await api.loopReplay();
      setNotice(
        `Replayed ${res.replayed} wet-lab result(s) → re-ingested. ` +
          (res.calibration_error != null
            ? `Calibration error now ${fmtNum(res.calibration_error, 3)} log-µM.`
            : ""),
      );
    } catch (e) {
      setActError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <h1>Next batch — acquisition gate</h1>
      <p className="muted">
        The ranked candidates the loop proposes to synthesize. Boltz affinity is
        a <strong>ranking proxy (log-µM), not a measured Ki</strong>; the OOD
        flag warns when a candidate is far from the training manifold.
      </p>
      <PersonaHint route="/acquisition" />

      {data && (
        <div className="panel" style={{ marginBottom: "1rem" }}>
          <div className="kv">
            <span className="muted">Target</span>
            <span>{data.target_name ?? "—"}</span>
            <span className="muted">Generated → scored → shortlisted</span>
            <span>
              {data.generated} → {data.scored} → {data.shortlisted}
            </span>
          </div>
          <div style={{ marginTop: "0.75rem", display: "flex", gap: "0.6rem" }}>
            <button
              className="btn btn-primary"
              onClick={approve}
              disabled={busy != null}
            >
              {busy === "approve" ? "Approving…" : "Approve batch"}
            </button>
            <button className="btn" onClick={replay} disabled={busy != null}>
              {busy === "replay" ? "Replaying…" : "Replay results"}
            </button>
          </div>
          {notice && (
            <div className="persona-hint" style={{ marginTop: "0.75rem" }}>
              {notice}
            </div>
          )}
          {actError && (
            <div className="error-banner" style={{ marginTop: "0.75rem" }}>
              {actError}
            </div>
          )}
        </div>
      )}

      {error && <div className="error-banner">{error}</div>}
      {loading && <p className="muted">Loading…</p>}

      <div className="grid-cards">
        {data?.candidates.map((c) => (
          <CandidateCard key={c.inchikey} c={c} />
        ))}
      </div>
    </div>
  );
}
