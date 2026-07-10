// Screening Campaign — the assay-side loop, made runnable for a UHTS workflow.
//
// A deliberately simple, step-by-step flow that mirrors how a High-Throughput
// Screening group actually works:
//   1. Predicted small molecules come in (from the generative/Boltz side).
//   2. PRIMARY screen — a 1536-well single-concentration % inhibition run with
//      Z'-factor QC and hit calling (the "large-scale test", mimicked).
//   3. CONFIRM & characterize — dose-response IC50/EC50 and SPR Kd/Ki on the
//      hits (the depth: the real numbers a screener cares about).
//   4. FEEDBACK — those measured affinities are GROUND TRUTH: ingested as
//      model-ready records and diffed against the Boltz prediction. That delta
//      is what retrains the surrogate and grades the structure/Boltz model.
//
// Every number is deterministic mock data (no spend, no network); stronger
// predicted binders screen hotter, so the funnel behaves sensibly end to end.

import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type {
  AcquisitionCandidate,
  ConfirmHit,
  PrimaryHit,
  PrimaryResult,
  ConfirmResult,
} from "../api/types";
import StructureCanvas from "../components/StructureCanvas";
import { fmtMolar, fmtNum } from "../lib/format";
import { PersonaHint } from "../lib/persona";

type StepState = "idle" | "running" | "done";
const STEP_DEFS = [
  { key: "candidates", title: "Predicted molecules", sub: "input from the design side" },
  { key: "primary", title: "Primary screen", sub: "1536-well · % inhibition" },
  { key: "confirm", title: "Confirm & characterize", sub: "IC50 / EC50 · SPR Kd / Ki" },
  { key: "feedback", title: "Ground truth → model", sub: "measured affinity recalibrates" },
] as const;
type StepKey = (typeof STEP_DEFS)[number]["key"];

const initSteps = (): Record<StepKey, StepState> =>
  Object.fromEntries(STEP_DEFS.map((s) => [s.key, "idle"])) as Record<StepKey, StepState>;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- 1536-well plate heatmap (illustrative) --------------------------------
const ROWS = 32;
const COLS = 48; // 32 × 48 = 1536 wells
// deterministic per-well pseudo-noise so the plate is stable across renders
function noise(i: number): number {
  let x = (i * 2654435761) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 2246822519);
  x ^= x >>> 13;
  return (x >>> 0) / 4294967296;
}
// map % inhibition → heat colour (cold pale → brand orange → deep red)
function heat(p: number): string {
  const stops: [number, [number, number, number]][] = [
    [0, [233, 236, 241]],
    [25, [255, 233, 194]],
    [45, [255, 154, 60]],
    [70, [255, 106, 0]],
    [100, [176, 32, 46]],
  ];
  const v = Math.max(0, Math.min(100, p));
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const [x0, c0] = stops[i - 1];
      const [x1, c1] = stops[i];
      const t = (v - x0) / (x1 - x0 || 1);
      const c = c0.map((a, k) => Math.round(a + (c1[k] - a) * t));
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    }
  }
  return "rgb(176,32,46)";
}

interface Well {
  pct: number;
  kind: "neg" | "pos" | "sample" | "hit";
  ik?: string;
}

function buildPlate(hits: PrimaryHit[]): Well[] {
  const wells: Well[] = new Array(ROWS * COLS);
  for (let i = 0; i < wells.length; i++) {
    const col = i % COLS;
    if (col === 0) wells[i] = { pct: 1 + noise(i) * 4, kind: "neg" }; // DMSO controls
    else if (col === 1) wells[i] = { pct: 94 + noise(i) * 6, kind: "pos" }; // full-inhibition controls
    else wells[i] = { pct: noise(i) * 18, kind: "sample" }; // cold library background
  }
  // drop the tracked candidates into stable sample positions so they light up
  const taken = new Set<number>();
  hits.forEach((h, idx) => {
    let pos = (Math.abs(hashStr(h.inchikey)) % (ROWS * COLS - 200)) + 120 + idx;
    while (taken.has(pos) || pos % COLS < 2) pos = (pos + 7) % (ROWS * COLS);
    taken.add(pos);
    wells[pos] = { pct: h.pct_inhibition, kind: h.is_hit ? "hit" : "sample", ik: h.inchikey };
  });
  return wells;
}
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

export default function Screen() {
  const [steps, setSteps] = useState<Record<StepKey, StepState>>(initSteps());
  const [candidates, setCandidates] = useState<AcquisitionCandidate[]>([]);
  const [loadingCands, setLoadingCands] = useState(false);
  const [primary, setPrimary] = useState<PrimaryResult | null>(null);
  const [running1, setRunning1] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmResult | null>(null);
  const [running2, setRunning2] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setStep = (k: StepKey, s: StepState) => setSteps((p) => ({ ...p, [k]: s }));

  async function loadCandidates() {
    setError(null);
    setLoadingCands(true);
    setStep("candidates", "running");
    try {
      // Fetching the batch also caches the Boltz predictions the screen calibrates against.
      const batch = await api.acquisitionBatch();
      setCandidates(batch.candidates);
      setStep("candidates", "done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep("candidates", "idle");
    } finally {
      setLoadingCands(false);
    }
  }

  async function runPrimary() {
    if (!candidates.length) return;
    setError(null);
    setRunning1(true);
    setConfirm(null);
    setStep("confirm", "idle");
    setStep("feedback", "idle");
    setStep("primary", "running");
    try {
      const res = await api.screenPrimary(candidates.map((c) => c.smiles));
      await delay(650); // "reading plate…"
      setPrimary(res);
      setStep("primary", "done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep("primary", "idle");
    } finally {
      setRunning1(false);
    }
  }

  async function runConfirm() {
    if (!primary) return;
    const hitSmiles = primary.results.filter((r) => r.is_hit).map((r) => r.smiles);
    const toConfirm = hitSmiles.length ? hitSmiles : primary.results.slice(0, 2).map((r) => r.smiles);
    setError(null);
    setRunning2(true);
    setStep("confirm", "running");
    try {
      const res = await api.screenConfirm(toConfirm);
      await delay(600);
      setConfirm(res);
      setStep("confirm", "done");
      setStep("feedback", "running");
      await delay(600);
      setStep("feedback", "done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep("confirm", "idle");
    } finally {
      setRunning2(false);
    }
  }

  function reset() {
    setSteps(initSteps());
    setCandidates([]);
    setPrimary(null);
    setConfirm(null);
    setError(null);
  }

  const plate = primary ? buildPlate(primary.results) : [];

  return (
    <div>
      <h1>Screening Campaign</h1>
      <p className="muted">
        The assay-side loop for a UHTS workflow: take the predicted small
        molecules, run them through a large-scale primary screen, confirm and
        characterize the hits, then feed the measured affinities back as ground
        truth that recalibrates the prediction model. Every step below is one
        click — follow the rail on the left.
      </p>
      <PersonaHint route="/screen" />

      <div className="discover">
        {/* ---- left rail: the 4-step campaign ---- */}
        <div className="discover-rail">
          <div className="panel">
            <h3 style={{ marginTop: 0 }}>Campaign</h3>
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
                          <span className="spinner" style={{ width: 11, height: 11 }} /> working…
                        </div>
                      )}
                    </span>
                  </li>
                );
              })}
            </ol>
          </div>
        </div>

        {/* ---- main column: panels stack as the campaign progresses ---- */}
        <div className="discover-main">
          {error && <div className="error-banner">{error}</div>}

          {/* STEP 1 — predicted molecules */}
          <div className="panel" style={{ marginBottom: "1rem" }}>
            <div className="screen-step-head">
              <span className="step-no">1</span>
              <h3 style={{ margin: 0 }}>Predicted small molecules</h3>
            </div>
            <p className="muted" style={{ fontSize: "0.85rem", margin: "0 0 0.6rem" }}>
              These come from the design side (generation + Boltz ranking). The{" "}
              <span className="predicted-badge">PREDICTED · log-µM</span> value is a
              model guess, <strong>not</strong> a measurement — the screen is what turns
              it into truth.
            </p>
            {candidates.length === 0 ? (
              <button className="btn btn-primary" onClick={loadCandidates} disabled={loadingCands}>
                {loadingCands ? <span className="spinner" /> : "＋"}&nbsp; Load predicted candidates
              </button>
            ) : (
              <div className="grid-cards">
                {candidates.map((c) => (
                  <div key={c.inchikey} className="panel" style={{ padding: "0.7rem" }}>
                    <div style={{ display: "flex", gap: "0.6rem", alignItems: "flex-start" }}>
                      <StructureCanvas smiles={c.smiles} width={84} height={66} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: "flex", gap: "0.35rem", alignItems: "center", flexWrap: "wrap" }}>
                          <span className={`tag tag-${c.tag === "exploit" ? "exploit" : "explore"}`}>{c.tag}</span>
                          {c.ood_flag && <span className="ood-flag">⚠ OOD</span>}
                        </div>
                        <Link to={`/compound/${c.inchikey}`} className="mono" style={{ fontSize: "0.7rem", wordBreak: "break-all" }}>
                          {c.inchikey}
                        </Link>
                        <div className="kv" style={{ marginTop: "0.3rem", fontSize: "0.8rem" }}>
                          <span className="muted">Boltz</span>
                          <span>
                            {c.boltz_affinity != null ? fmtNum(c.boltz_affinity) : "—"}{" "}
                            <span className="predicted-badge">PRED</span>
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {candidates.length > 0 && (
              <div style={{ marginTop: "0.8rem" }}>
                <button className="btn btn-primary" onClick={runPrimary} disabled={running1}>
                  {running1 ? <span className="spinner" /> : "▸"}&nbsp; Run 1536-well primary screen
                </button>
              </div>
            )}
          </div>

          {/* STEP 2 — primary screen */}
          {primary && (
            <div className="panel" style={{ marginBottom: "1rem" }}>
              <div className="screen-step-head">
                <span className="step-no">2</span>
                <h3 style={{ margin: 0 }}>Primary screen — 1536-well plate</h3>
              </div>
              <p className="muted" style={{ fontSize: "0.85rem", margin: "0 0 0.7rem" }}>
                Each well is one compound at a single concentration; colour is %
                inhibition. Column&nbsp;1 is DMSO (negative) and column&nbsp;2 is
                full-inhibition (positive) controls — the spread between them is the{" "}
                <strong>Z′-factor</strong>. Wells at or above the{" "}
                {primary.hit_threshold}% line are called hits.
              </p>

              <div className="screen-kpis">
                <div className="kpi">
                  <div className="kpi-n">{primary.plate_wells.toLocaleString()}</div>
                  <div className="kpi-l">wells</div>
                </div>
                <div className="kpi">
                  <div className="kpi-n">{primary.z_prime.toFixed(2)}</div>
                  <div className="kpi-l">Z′-factor {primary.z_prime >= 0.5 ? "· excellent" : "· marginal"}</div>
                </div>
                <div className="kpi">
                  <div className="kpi-n">{primary.hits}</div>
                  <div className="kpi-l">hits ≥ {primary.hit_threshold}%</div>
                </div>
                <div className="kpi">
                  <div className="kpi-n">{(primary.hit_rate * 100).toFixed(1)}%</div>
                  <div className="kpi-l">hit rate (tracked set)</div>
                </div>
              </div>

              <div className="plate-wrap">
                <div className="plate" style={{ gridTemplateColumns: `repeat(${COLS}, 1fr)` }}>
                  {plate.map((w, i) => (
                    <span
                      key={i}
                      className={`plate-well${w.kind === "hit" ? " hit" : ""}`}
                      style={{ background: heat(w.pct) }}
                      title={
                        w.kind === "neg"
                          ? `neg control · ${w.pct.toFixed(0)}%`
                          : w.kind === "pos"
                            ? `pos control · ${w.pct.toFixed(0)}%`
                            : `${w.ik ? "candidate · " : ""}${w.pct.toFixed(1)}% inhibition`
                      }
                    />
                  ))}
                </div>
              </div>
              <div className="plate-legend">
                <span className="muted" style={{ fontSize: "0.75rem" }}>0%</span>
                <span className="plate-scale" />
                <span className="muted" style={{ fontSize: "0.75rem" }}>100% inhibition</span>
                <span style={{ marginLeft: "auto", fontSize: "0.75rem" }} className="muted">
                  ◾ ringed = called hit
                </span>
              </div>

              {/* candidate results table */}
              <div className="panel" style={{ padding: 0, overflow: "hidden", marginTop: "0.9rem" }}>
                <table>
                  <thead>
                    <tr>
                      <th>Compound</th>
                      <th>% inhibition</th>
                      <th>Call</th>
                    </tr>
                  </thead>
                  <tbody>
                    {primary.results
                      .slice()
                      .sort((a, b) => b.pct_inhibition - a.pct_inhibition)
                      .map((r) => (
                        <tr key={r.inchikey} style={{ cursor: "default" }}>
                          <td>
                            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                              <StructureCanvas smiles={r.smiles} width={52} height={40} />
                              <Link to={`/compound/${r.inchikey}`} className="mono" style={{ fontSize: "0.7rem", wordBreak: "break-all" }}>
                                {r.inchikey}
                              </Link>
                            </div>
                          </td>
                          <td>
                            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                              <span className="bar-track" style={{ width: 90 }}>
                                <span
                                  className="bar-fill"
                                  style={{ width: `${Math.max(0, Math.min(100, r.pct_inhibition))}%`, background: heat(r.pct_inhibition) }}
                                />
                              </span>
                              <strong>{r.pct_inhibition.toFixed(1)}%</strong>
                            </div>
                          </td>
                          <td>
                            {r.is_hit ? (
                              <span className="tag tag-exploit">HIT</span>
                            ) : (
                              <span className="muted" style={{ fontSize: "0.8rem" }}>inactive</span>
                            )}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>

              <div style={{ marginTop: "0.9rem" }}>
                <button className="btn btn-primary" onClick={runConfirm} disabled={running2}>
                  {running2 ? <span className="spinner" /> : "▸"}&nbsp; Confirm hits — dose-response + SPR
                </button>
              </div>
            </div>
          )}

          {/* STEP 3 — confirm & characterize */}
          {confirm && (
            <div className="panel" style={{ marginBottom: "1rem" }}>
              <div className="screen-step-head">
                <span className="step-no">3</span>
                <h3 style={{ margin: 0 }}>Confirm & characterize the hits</h3>
              </div>
              <p className="muted" style={{ fontSize: "0.85rem", margin: "0 0 0.7rem" }}>
                Primary hits go into dose-response (IC50 / EC50) and biophysical
                characterization (SPR → Kd / Ki). This is the depth: real potency
                numbers with QC. {confirm.confirmed} of {confirm.results.length} confirmed.
              </p>
              <div className="panel" style={{ padding: 0, overflow: "auto" }}>
                <table style={{ minWidth: 720 }}>
                  <thead>
                    <tr>
                      <th>Compound</th>
                      <th>IC50</th>
                      <th>EC50</th>
                      <th>Kd</th>
                      <th>Ki</th>
                      <th>QC</th>
                      <th>Confirmed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {confirm.results.map((c: ConfirmHit) => (
                      <tr key={c.inchikey} style={{ cursor: "default" }}>
                        <td>
                          <Link to={`/compound/${c.inchikey}`} className="mono" style={{ fontSize: "0.7rem", wordBreak: "break-all" }}>
                            {c.inchikey}
                          </Link>
                        </td>
                        <td>{fmtMolar(c.ic50_M)}</td>
                        <td>{fmtMolar(c.ec50_M)}</td>
                        <td>{fmtMolar(c.kd_M)}</td>
                        <td>
                          <strong>{fmtMolar(c.ki_M)}</strong>
                        </td>
                        <td>
                          {c.qc_flag === "pass" ? (
                            <span className="muted" style={{ fontSize: "0.8rem" }}>pass</span>
                          ) : (
                            <span className="chip chip-warn">{c.qc_flag}</span>
                          )}
                        </td>
                        <td>{c.confirmed ? <span className="tag tag-exploit">✓</span> : <span className="muted">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted" style={{ fontSize: "0.78rem", marginTop: "0.6rem" }}>
                Each Ki here is a real, model-ready measurement. Aggregator / QC-flagged
                rows stay visible and usable-with-caution — nothing is silently dropped.
              </p>
            </div>
          )}

          {/* STEP 4 — feedback to the model */}
          {confirm && steps.feedback === "done" && (
            <div className="panel measured-card" style={{ marginBottom: "1rem" }}>
              <div className="screen-step-head">
                <span className="step-no" style={{ background: "var(--green)" }}>4</span>
                <h3 style={{ margin: 0 }}>Ground truth fed back to the model</h3>
              </div>
              <div className="kv" style={{ marginTop: "0.4rem" }}>
                <span className="muted">Measured points returned</span>
                <span>
                  <strong>{confirm.results.length}</strong> Ki records added to the training set
                </span>
                <span className="muted">Calibration error</span>
                <span>
                  {confirm.calibration_error != null ? `${fmtNum(confirm.calibration_error, 3)} log-µM` : "—"}{" "}
                  <span className="muted">(mean |Boltz predicted − measured|)</span>
                </span>
              </div>

              {/* predicted vs measured per confirmed hit */}
              <div className="panel" style={{ padding: 0, overflow: "hidden", marginTop: "0.7rem" }}>
                <table>
                  <thead>
                    <tr>
                      <th>Compound</th>
                      <th>Predicted <span style={{ textTransform: "none" }}>(log-µM)</span></th>
                      <th>Measured <span style={{ textTransform: "none" }}>(log-µM)</span></th>
                      <th>Δ <span style={{ textTransform: "none" }}>(pred − meas)</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {confirm.results.map((c) => (
                      <tr key={c.inchikey} style={{ cursor: "default" }}>
                        <td>
                          <Link to={`/compound/${c.inchikey}`} className="mono" style={{ fontSize: "0.7rem", wordBreak: "break-all" }}>
                            {c.inchikey}
                          </Link>
                        </td>
                        <td>
                          {c.predicted_loguM != null ? fmtNum(c.predicted_loguM) : "—"}{" "}
                          {c.predicted_loguM != null && <span className="predicted-badge">PRED</span>}
                        </td>
                        <td><strong>{c.measured_loguM != null ? fmtNum(c.measured_loguM) : "—"}</strong></td>
                        <td>{c.delta_loguM != null ? fmtNum(c.delta_loguM) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="loop-close">
                <span className="chip">predicted molecule</span>
                <span className="loop-arrow">→</span>
                <span className="chip">1536 primary</span>
                <span className="loop-arrow">→</span>
                <span className="chip">confirm Ki</span>
                <span className="loop-arrow">→</span>
                <span className="chip chip-pocket">ground truth</span>
                <span className="loop-arrow">→</span>
                <span className="chip">retrains surrogate + grades Boltz</span>
              </div>
              <p className="muted" style={{ fontSize: "0.83rem", marginTop: "0.6rem" }}>
                The measured Ki is what the cheap surrogate retrains on and what the
                Boltz prediction is scored against — the Δ above is that grade. Watch
                the trend on <Link to="/metrics">Metrics</Link> and every measurement
                on <Link to="/records">Records</Link>. Run another batch through{" "}
                <Link to="/discover">Discover</Link> and the loop tightens.
              </p>
              <div style={{ marginTop: "0.7rem", display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
                <button className="btn btn-primary" onClick={reset}>
                  Run another campaign ▸
                </button>
                <Link to="/metrics" className="btn">View calibration</Link>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
