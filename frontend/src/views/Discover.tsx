// Guided discovery with a structure-based generative-screening setup inspired by
// NVIDIA's generative virtual screening blueprint: fold the target (AlphaFold2),
// generate candidates (MolMIM), dock & score (DiffDock + cheap surrogate), then
// the acquisition gate. The left rail animates each stage. The human reviews the
// hits, accepts the ones to test, and the predicted-vs-measured delta from the
// (randomized, mocked) assays is fed back to the model.
//
// The fold/generate/dock compute is illustrative/mocked, as elsewhere in the
// demo; the inserted sequence + pocket genuinely drive generation via
// POST /acquisition/run.

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
  { key: "fold", title: "Fold target", sub: "predict 3-D structure", nim: "AlphaFold2" },
  { key: "generate", title: "Generate", sub: "de novo / optimize", nim: "MolMIM" },
  { key: "dock", title: "Dock & score", sub: "poses + surrogate µ,σ", nim: "DiffDock" },
  { key: "gate", title: "Acquisition gate", sub: "UCB re-rank", nim: null },
  { key: "review", title: "Human review", sub: "accept hits to test", nim: null },
  { key: "assay", title: "Assays", sub: "randomized results", nim: null },
  { key: "feedback", title: "Feedback", sub: "update the model", nim: null },
] as const;
type StepKey = (typeof STEP_DEFS)[number]["key"];

const initSteps = (): Record<StepKey, StepState> =>
  Object.fromEntries(STEP_DEFS.map((s) => [s.key, "idle"])) as Record<StepKey, StepState>;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const measuredLoguM = (kiM: number) => Math.log10(kiM / 1e-6);

const hashStr = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};
const round1 = (x: number) => Math.round(x * 10) / 10;
const parsePocket = (s: string): number[] =>
  s
    .split(/[\s,]+/)
    .map((t) => parseInt(t, 10))
    .filter((n) => Number.isFinite(n) && n > 0);
function suggestPocket(seq: string, h: number): number[] {
  const len = seq.length || 320;
  const out: number[] = [];
  let x = h || 1;
  for (let i = 0; i < 8; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out.push((x % Math.max(1, len - 2)) + 1);
  }
  return Array.from(new Set(out)).sort((a, b) => a - b);
}
// DiffDock-style confidence: stronger (more negative) affinity → higher confidence.
const dockConf = (aff: number | null | undefined): number =>
  Math.max(0.05, Math.min(0.98, 0.62 - (aff ?? 0) * 0.13));

type Phase = "input" | "processing" | "hits" | "testing" | "done";
type GenMode = "denovo" | "optimize";

export default function Discover() {
  const { data: example } = useAsync<Target>(() => api.target());
  const [protein, setProtein] = useState("");
  const [pocketStr, setPocketStr] = useState("");
  const [ligand, setLigand] = useState("");
  const [folded, setFolded] = useState<{ plddt: number; pocket: number[] } | null>(null);
  const [folding, setFolding] = useState(false);
  const [genMode, setGenMode] = useState<GenMode>("denovo");
  const [numMol, setNumMol] = useState(12);
  const [useDocking, setUseDocking] = useState(true);

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
    setPocketStr((example.pocket_residues ?? []).join(", "));
    setFolded(null);
  }

  async function fold() {
    const seq = protein.trim();
    if (!seq) {
      setError("Enter a protein/peptide sequence to fold.");
      return;
    }
    setError(null);
    setFolding(true);
    await delay(1100); // mock AlphaFold2
    const h = hashStr(seq);
    const f = { plddt: round1(72 + (h % 230) / 10), pocket: suggestPocket(seq, h) };
    setFolded(f);
    if (!parsePocket(pocketStr).length) setPocketStr(f.pocket.join(", "));
    setFolding(false);
  }

  const configLabel = () =>
    `${genMode === "optimize" ? "MolMIM · optimize from reference" : "MolMIM · de novo"} · ${numMol} molecules · DiffDock ${useDocking ? "re-rank on" : "off"}`;

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
      // 1. Fold (AlphaFold2)
      setStep("fold", "running");
      let pocketArr = parsePocket(pocketStr);
      if (!folded && seq) {
        await delay(900);
        const h = hashStr(seq);
        const f = { plddt: round1(72 + (h % 230) / 10), pocket: suggestPocket(seq, h) };
        setFolded(f);
        if (!pocketArr.length) {
          pocketArr = f.pocket;
          setPocketStr(f.pocket.join(", "));
        }
      } else {
        await delay(450);
      }
      setStep("fold", "done");

      const target: Target = {
        name:
          example && seq === example.protein_sequence ? example.name ?? "target" : "custom-target",
        protein_sequence: seq || (example?.protein_sequence ?? ""),
        chain_ids: ["A"],
        pocket_residues: pocketArr,
      };

      // 2. Generate (MolMIM)
      setStep("generate", "running");
      const batchP = api.acquisitionRun(target, numMol);
      await delay(700);
      setStep("generate", "done");
      // 3. Dock & score (DiffDock + surrogate)
      setStep("dock", "running");
      await delay(700);
      setStep("dock", "done");
      // 4. Acquisition gate
      setStep("gate", "running");
      const batch = await batchP;
      await delay(450);
      setStep("gate", "done");

      let cands = batch.candidates;
      if (useDocking) {
        cands = [...cands].sort((a, b) => dockConf(b.boltz_affinity) - dockConf(a.boltz_affinity));
      }
      setHits(cands);
      setAccepted(Object.fromEntries(cands.map((c) => [c.inchikey, true])));
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
        Structure-based generative screening: fold the target, generate and dock
        candidates, then review and accept hits. Accepted hits get (mocked) assay
        results, and the predicted-vs-measured delta is fed back to the model.
        Pipeline tools after{" "}
        <span className="nim-tag">AlphaFold2</span>{" "}
        <span className="nim-tag">MolMIM</span>{" "}
        <span className="nim-tag">DiffDock</span>.
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
                      <div className="step-title">
                        {s.title}{" "}
                        {s.nim && <span className="nim-tag">{s.nim}</span>}
                      </div>
                      <div className="step-sub">{s.sub}</div>
                      {st === "running" && (
                        <div className="step-now">
                          {s.key === "review" ? (
                            "● awaiting your decision"
                          ) : (
                            <>
                              <span className="spinner" style={{ width: 11, height: 11 }} /> working…
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
              <h3 style={{ marginTop: 0 }}>Set up the screen</h3>

              {/* A. Structure — AlphaFold2 */}
              <div className="setup-section">
                <div className="setup-head">
                  <span className="nim-tag">AlphaFold2</span> Target structure
                </div>
                <div className="form-row">
                  <label>Protein / peptide sequence</label>
                  <textarea
                    rows={4}
                    placeholder="Paste a protein or peptide sequence (one-letter codes)…"
                    value={protein}
                    onChange={(e) => {
                      setProtein(e.target.value);
                      setFolded(null);
                    }}
                    style={{ fontFamily: "ui-monospace, monospace", fontSize: "0.8rem" }}
                  />
                  <span className="field-hint">
                    {protein.trim() ? `${protein.trim().length} residues` : "required (or provide a ligand)"}
                  </span>
                </div>
                <div style={{ display: "flex", gap: "0.6rem", alignItems: "center", flexWrap: "wrap" }}>
                  <button className="btn" onClick={fold} disabled={folding || !protein.trim()}>
                    {folding ? <span className="spinner" /> : "⚛"}&nbsp; Predict structure
                  </button>
                  {folded && (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem", fontSize: "0.82rem" }}>
                      <span className="nim-tag" style={{ background: "#e6f4ea" }}>structure ready</span>
                      pLDDT {folded.plddt}
                      <span className="conf-bar" style={{ width: 110 }}>
                        <span
                          className="conf-fill"
                          style={{
                            width: `${folded.plddt}%`,
                            background: "linear-gradient(90deg,#34c759,#86e0a0)",
                          }}
                        />
                      </span>
                    </span>
                  )}
                </div>
              </div>

              {/* B. Binding pocket */}
              <div className="setup-section">
                <div className="setup-head">Binding pocket</div>
                <div className="form-row">
                  <label>Pocket residues (comma-separated)</label>
                  <input
                    type="text"
                    placeholder="e.g. 78, 80, 83, 128, 130"
                    value={pocketStr}
                    onChange={(e) => setPocketStr(e.target.value)}
                  />
                  <span className="field-hint">
                    {parsePocket(pocketStr).length} residue(s) define the docking site.
                  </span>
                </div>
                <button
                  className="btn"
                  onClick={() => folded && setPocketStr(folded.pocket.join(", "))}
                  disabled={!folded}
                >
                  Use predicted pocket
                </button>
              </div>

              {/* C. Generation — MolMIM */}
              <div className="setup-section">
                <div className="setup-head">
                  <span className="nim-tag">MolMIM</span> Generation
                </div>
                <div style={{ display: "flex", gap: "0.8rem", alignItems: "center", flexWrap: "wrap" }}>
                  <div className="seg">
                    <button className={genMode === "denovo" ? "on" : ""} onClick={() => setGenMode("denovo")}>
                      De novo
                    </button>
                    <button className={genMode === "optimize" ? "on" : ""} onClick={() => setGenMode("optimize")}>
                      Optimize reference
                    </button>
                  </div>
                  <label style={{ fontSize: "0.84rem", display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
                    Molecules:
                    <input
                      type="number"
                      min={4}
                      max={40}
                      value={numMol}
                      onChange={(e) => setNumMol(Math.max(4, Math.min(40, Number(e.target.value) || 12)))}
                      style={{ width: 70, padding: "0.3rem 0.4rem", border: "1px solid var(--line)", borderRadius: 6 }}
                    />
                  </label>
                </div>
                {genMode === "optimize" && (
                  <div className="form-row" style={{ marginTop: "0.6rem" }}>
                    <label>Reference ligand SMILES</label>
                    <input
                      type="text"
                      placeholder="e.g. Cc1ccc(cc1)S(=O)(=O)N"
                      value={ligand}
                      onChange={(e) => setLigand(e.target.value)}
                    />
                    {ligand.trim() && <StructureCanvas smiles={ligand} width={150} height={100} />}
                  </div>
                )}
              </div>

              {/* D. Docking — DiffDock */}
              <div className="setup-section">
                <div className="setup-head">
                  <span className="nim-tag">DiffDock</span> Docking
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={useDocking}
                    onChange={(e) => setUseDocking(e.target.checked)}
                  />
                  Re-rank hits by predicted docking confidence
                </label>
              </div>

              <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.4rem", flexWrap: "wrap" }}>
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
                <strong>Folding, generating, and docking candidates…</strong>
                <div className="muted" style={{ fontSize: "0.82rem" }}>{configLabel()}</div>
              </div>
            </div>
          )}

          {(phase === "hits" || phase === "testing") && (
            <>
              <div className="persona-hint">
                <strong>Human-in-the-loop:</strong> review the proposed hits and
                accept the ones to send for testing. {acceptedCount} of {hits.length} selected.
                <div className="muted" style={{ marginTop: "0.2rem", fontSize: "0.78rem" }}>{configLabel()}</div>
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
                          {useDocking && (
                            <>
                              <span className="muted">DiffDock conf.</span>
                              <span style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                                <span className="conf-bar" style={{ width: 80 }}>
                                  <span
                                    className="conf-fill"
                                    style={{ width: `${Math.round(dockConf(h.boltz_affinity) * 100)}%`, background: "var(--brand)" }}
                                  />
                                </span>
                                {fmtNum(dockConf(h.boltz_affinity), 2)}
                              </span>
                            </>
                          )}
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
