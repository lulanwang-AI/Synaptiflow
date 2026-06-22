// Guided discovery — the step-by-step experience. Insert a protein/peptide (and
// optionally a reference ligand), press Start, and the left rail animates each
// stage as the real pipeline runs (POST /acquisition/run → hits). The human
// then reviews the hits and accepts the ones to test; accepting runs (randomized,
// mocked) assays and feeds the predicted-vs-measured delta back to the model.

import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { AcquisitionCandidate, AssayRecord, Target } from "../api/types";
import { useAsync } from "../lib/useAsync";
import StructureCanvas from "../components/StructureCanvas";
import { fmtNum, fmtMolar } from "../lib/format";
import { PersonaHint } from "../lib/persona";

type StepState = "idle" | "running" | "done";
const STEP_DEFS = [
  { key: "target", title: "Target", sub: "parse protein / ligand" },
  { key: "generate", title: "Generate", sub: "Boltz design" },
  { key: "score", title: "Score", sub: "surrogate µ ± σ" },
  { key: "gate", title: "Acquisition gate", sub: "UCB + Boltz re-rank" },
  { key: "review", title: "Human review", sub: "accept hits to test" },
  { key: "assay", title: "Assays", sub: "randomized results" },
  { key: "feedback", title: "Feedback", sub: "update the model" },
] as const;
type StepKey = (typeof STEP_DEFS)[number]["key"];

const initSteps = (): Record<StepKey, StepState> =>
  Object.fromEntries(STEP_DEFS.map((s) => [s.key, "idle"])) as Record<StepKey, StepState>;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const measuredLoguM = (kiM: number) => Math.log10(kiM / 1e-6);

type Phase = "input" | "processing" | "hits" | "testing" | "done";

export default function Discover() {
  const { data: example } = useAsync<Target>(() => api.target());
  const [protein, setProtein] = useState("");
  const [pocket, setPocket] = useState<number[]>([]);
  const [ligand, setLigand] = useState("");
  const [phase, setPhase] = useState<Phase>("input");
  const [steps, setSteps] = useState<Record<StepKey, StepState>>(initSteps());
  const [hits, setHits] = useState<AcquisitionCandidate[]>([]);
  const [accepted, setAccepted] = useState<Record<string, boolean>>({});
  const [results, setResults] = useState<AssayRecord[]>([]);
  const [calib, setCalib] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setStep = (k: StepKey, s: StepState) => setSteps((p) => ({ ...p, [k]: s }));

  function useExample() {
    if (!example) return;
    setProtein(example.protein_sequence);
    setPocket(example.pocket_residues ?? []);
  }

  async function start() {
    const seq = protein.trim();
    if (!seq && !ligand.trim()) {
      setError("Insert a protein/peptide sequence or a ligand SMILES to begin.");
      return;
    }
    setError(null);
    setSteps(initSteps());
    setHits([]);
    setResults([]);
    setCalib(null);
    setAccepted({});
    setPhase("processing");
    try {
      setStep("target", "running");
      await delay(650);
      setStep("target", "done");

      const target: Target = {
        name:
          example && seq === example.protein_sequence
            ? example.name ?? "target"
            : "custom-target",
        protein_sequence: seq || (example?.protein_sequence ?? ""),
        chain_ids: ["A"],
        pocket_residues: pocket,
      };

      setStep("generate", "running");
      const batchP = api.acquisitionRun(target);
      await delay(700);
      setStep("generate", "done");
      setStep("score", "running");
      await delay(700);
      setStep("score", "done");
      setStep("gate", "running");
      const batch = await batchP;
      await delay(500);
      setStep("gate", "done");

      setHits(batch.candidates);
      setAccepted(Object.fromEntries(batch.candidates.map((c) => [c.inchikey, true])));
      setStep("review", "running");
      setPhase("hits");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("input");
    }
  }

  function toggle(ik: string) {
    setAccepted((a) => ({ ...a, [ik]: !a[ik] }));
  }

  async function accept() {
    const keys = hits.filter((h) => accepted[h.inchikey]).map((h) => h.inchikey);
    if (keys.length === 0) {
      setError("Select at least one hit to send for testing.");
      return;
    }
    setError(null);
    setPhase("testing");
    setStep("review", "done");
    setStep("assay", "running");
    try {
      await api.acquisitionApprove();
      await delay(500);
      const res = await api.loopReplay({ inchikeys: keys });
      setResults(res.records);
      setCalib(res.calibration_error ?? null);
      setStep("assay", "done");
      setStep("feedback", "running");
      await delay(750);
      setStep("feedback", "done");
      setPhase("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep("assay", "idle");
      setStep("review", "running");
      setPhase("hits");
    }
  }

  function reset() {
    setPhase("input");
    setSteps(initSteps());
    setHits([]);
    setResults([]);
    setCalib(null);
    setAccepted({});
    setError(null);
  }

  const acceptedCount = hits.filter((h) => accepted[h.inchikey]).length;
  const predByIk: Record<string, number | null> = Object.fromEntries(
    hits.map((h) => [h.inchikey, h.boltz_affinity ?? null]),
  );

  return (
    <div>
      <h1>Discover</h1>
      <p className="muted">
        Insert a target, watch the pipeline run step by step, then review and
        accept the proposed hits. Accepted hits get (mocked) assay results, and
        the predicted-vs-measured delta is fed back to the model.
      </p>
      <PersonaHint route="/discover" />

      <div className="discover">
        {/* ---- animated left rail ---- */}
        <div className="discover-rail">
          <div className="panel">
            <h3 style={{ marginTop: 0 }}>Pipeline</h3>
            <ol className="stepper">
              {STEP_DEFS.map((s, i) => {
                const st = steps[s.key];
                return (
                  <li key={s.key} className={`step ${st}`}>
                    <span className="step-icon">{st === "done" ? "✓" : i + 1}</span>
                    <span>
                      <div className="step-title">{s.title}</div>
                      <div className="step-sub">{s.sub}</div>
                      {st === "running" && (
                        <div className="step-now">
                          {s.key === "review" ? (
                            "● awaiting your decision"
                          ) : (
                            <>
                              <span className="spinner" style={{ width: 11, height: 11 }} />{" "}
                              working…
                            </>
                          )}
                        </div>
                      )}
                    </span>
                  </li>
                );
              })}
            </ol>
          </div>
        </div>

        {/* ---- main column ---- */}
        <div className="discover-main">
          {error && <div className="error-banner">{error}</div>}

          {phase === "input" && (
            <div className="panel">
              <h3 style={{ marginTop: 0 }}>Insert a target</h3>
              <div className="form-row">
                <label>Protein / peptide sequence</label>
                <textarea
                  rows={5}
                  placeholder="Paste a protein or peptide sequence (one-letter codes)…"
                  value={protein}
                  onChange={(e) => setProtein(e.target.value)}
                  style={{ fontFamily: "ui-monospace, monospace", fontSize: "0.8rem" }}
                />
                <span className="field-hint">
                  {protein.trim() ? `${protein.trim().length} residues` : "required (or provide a ligand)"}
                  {pocket.length > 0 && ` · pocket: ${pocket.join(", ")}`}
                </span>
              </div>
              <div className="form-row">
                <label>Reference ligand SMILES (optional)</label>
                <input
                  type="text"
                  placeholder="e.g. Cc1ccc(cc1)S(=O)(=O)N"
                  value={ligand}
                  onChange={(e) => setLigand(e.target.value)}
                />
              </div>
              {ligand.trim() && (
                <StructureCanvas smiles={ligand} width={160} height={110} />
              )}
              <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem", flexWrap: "wrap" }}>
                <button className="btn btn-primary" onClick={start}>
                  Start discovery ▸
                </button>
                <button className="btn" onClick={useExample} disabled={!example}>
                  Use example target (KINASE_X)
                </button>
              </div>
            </div>
          )}

          {phase === "processing" && (
            <div className="panel" style={{ display: "flex", alignItems: "center", gap: "0.7rem" }}>
              <span className="spinner" />
              <div>
                <strong>Analyzing target and generating candidates…</strong>
                <div className="muted" style={{ fontSize: "0.82rem" }}>
                  Boltz design → cheap surrogate → acquisition gate.
                </div>
              </div>
            </div>
          )}

          {(phase === "hits" || phase === "testing") && (
            <>
              <div className="persona-hint">
                <strong>Human-in-the-loop:</strong> review the proposed hits and
                accept the ones to send for testing. {acceptedCount} of {hits.length} selected.
              </div>
              <div className="grid-cards">
                {hits.map((h) => {
                  const sel = !!accepted[h.inchikey];
                  return (
                    <div key={h.inchikey} className={`panel hit-card${sel ? " sel" : ""}`}>
                      <input
                        type="checkbox"
                        className="hit-check"
                        checked={sel}
                        onChange={() => toggle(h.inchikey)}
                        disabled={phase === "testing"}
                        aria-label={`accept ${h.inchikey}`}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", gap: "0.6rem", alignItems: "flex-start" }}>
                          <StructureCanvas smiles={h.smiles} width={92} height={74} />
                          <div style={{ minWidth: 0 }}>
                            <div style={{ display: "flex", gap: "0.35rem", alignItems: "center", flexWrap: "wrap" }}>
                              <span className={`tag tag-${h.tag === "exploit" ? "exploit" : "explore"}`}>{h.tag}</span>
                              {h.ood_flag && <span className="ood-flag">⚠ OOD</span>}
                            </div>
                            <Link to={`/compound/${h.inchikey}`} className="mono" style={{ fontSize: "0.72rem", wordBreak: "break-all" }}>
                              {h.inchikey}
                            </Link>
                          </div>
                        </div>
                        <div className="kv" style={{ marginTop: "0.5rem", fontSize: "0.84rem" }}>
                          <span className="muted">µ ± σ (pKi)</span>
                          <span><strong>{fmtNum(h.mu)}</strong> ± {fmtNum(h.sigma)}</span>
                          <span className="muted">Boltz affinity</span>
                          <span style={{ display: "flex", gap: "0.35rem", alignItems: "center", flexWrap: "wrap" }}>
                            {h.boltz_affinity != null ? fmtNum(h.boltz_affinity) : "—"}
                            <span className="predicted-badge">PREDICTED · log-µM</span>
                          </span>
                          <span className="muted">ADMET</span>
                          <span>
                            {h.adme_flags.length
                              ? h.adme_flags.map((f) => <span key={f} className="chip chip-warn">{f}</span>)
                              : "clean"}
                          </span>
                        </div>
                        <p style={{ margin: "0.5rem 0 0", fontSize: "0.8rem" }}>
                          <span className="muted">Rationale: </span>
                          {h.rationale}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div style={{ marginTop: "1rem", display: "flex", gap: "0.6rem", alignItems: "center", flexWrap: "wrap" }}>
                <button className="btn btn-primary" onClick={accept} disabled={phase === "testing" || acceptedCount === 0}>
                  {phase === "testing" ? <span className="spinner" /> : "✓"}&nbsp; Accept {acceptedCount} & run assays
                </button>
                <button className="btn" onClick={reset} disabled={phase === "testing"}>
                  Start over
                </button>
                {phase === "testing" && (
                  <span className="muted" style={{ fontSize: "0.82rem", display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
                    <span className="spinner" /> running assays on {acceptedCount} hit(s)…
                  </span>
                )}
              </div>
            </>
          )}

          {phase === "done" && (
            <>
              <div className="panel measured-card" style={{ marginBottom: "1rem" }}>
                <h3 style={{ marginTop: 0 }}>✓ Feedback sent to the model</h3>
                <div className="kv">
                  <span className="muted">Ground-truth points returned</span>
                  <span><strong>{results.length}</strong> added to the training set</span>
                  <span className="muted">Calibration error</span>
                  <span>{calib != null ? `${fmtNum(calib, 3)} log-µM` : "—"} (predicted vs measured)</span>
                </div>
                <p className="muted" style={{ margin: "0.5rem 0 0", fontSize: "0.83rem" }}>
                  The surrogate retrains on these on the next round. See the trend on{" "}
                  <Link to="/metrics">Metrics</Link> and per-compound deltas on the{" "}
                  <Link to="/records">records</Link>.
                </p>
              </div>

              <h3>Test results (randomized demo data)</h3>
              <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
                <table>
                  <thead>
                    <tr>
                      <th>Compound</th>
                      <th>Predicted <span style={{ textTransform: "none" }}>(log-µM)</span></th>
                      <th>Measured Ki</th>
                      <th>Δ <span style={{ textTransform: "none" }}>(pred − meas)</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((r) => {
                      const ik = r.compound.inchikey ?? "";
                      const pred = predByIk[ik];
                      const meas = r.ki_M != null ? measuredLoguM(r.ki_M) : null;
                      const delta = pred != null && meas != null ? pred - meas : null;
                      return (
                        <tr key={r.record_id} style={{ cursor: "default" }}>
                          <td>
                            <Link to={`/compound/${ik}`} className="mono" style={{ wordBreak: "break-all" }}>{ik}</Link>
                          </td>
                          <td>{pred != null ? fmtNum(pred) : "—"}</td>
                          <td>{fmtMolar(r.ki_M)}</td>
                          <td>{delta != null ? fmtNum(delta) : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div style={{ marginTop: "1rem", display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
                <button className="btn btn-primary" onClick={reset}>
                  Run another round ▸
                </button>
                <Link to="/metrics" className="btn">View calibration</Link>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
