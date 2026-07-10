// Dify-style workflow canvas — a node graph of the closed loop with real action
// buttons. "Run full loop" orchestrates the actual pipeline (GET /acquisition/batch
// → POST /acquisition/approve → POST /loop/replay), lighting up each node and
// flowing the connecting edges as the work happens. Individual stage buttons let
// you drive it step by step. Everything calls the real API (or the MSW mock).

import { useState } from "react";
import { api } from "../api/client";
import type { AcquisitionBatch, LoopSummary, ReplayResponse } from "../api/types";
import { useAsync } from "../lib/useAsync";
import { PersonaHint } from "../lib/persona";

type NodeId =
  | "target"
  | "generator"
  | "surrogate"
  | "acquisition"
  | "synthesis"
  | "assay"
  | "ingest"
  | "store";
type RunState = "idle" | "running" | "done";

interface NodeDef {
  id: NodeId;
  kicker: string;
  title: string;
  sub: string;
  x: number;
  y: number;
  color: string;
}

const NODES: NodeDef[] = [
  { id: "target", kicker: "Substrate", title: "Target", sub: "KINASE_X pocket", x: 24, y: 36, color: "var(--blue)" },
  { id: "generator", kicker: "Design", title: "Generator", sub: "Boltz design", x: 268, y: 36, color: "var(--accent)" },
  { id: "surrogate", kicker: "Score", title: "Cheap surrogate", sub: "ECFP4 + RF (µ,σ)", x: 512, y: 36, color: "var(--accent)" },
  { id: "acquisition", kicker: "Gate", title: "Acquisition", sub: "UCB + Boltz re-rank", x: 756, y: 36, color: "var(--accent)" },
  { id: "synthesis", kicker: "Make", title: "Synthesis queue", sub: "approved batch", x: 756, y: 240, color: "var(--green)" },
  { id: "assay", kicker: "Test", title: "Assay", sub: "wet-lab (mocked)", x: 512, y: 240, color: "var(--green)" },
  { id: "ingest", kicker: "Analyze", title: "Ingest / normalize", sub: "Cheng–Prusoff + status", x: 268, y: 240, color: "var(--green)" },
  { id: "store", kicker: "Store", title: "Activity store", sub: "source of truth", x: 24, y: 240, color: "var(--muted)" },
];

interface EdgeDef {
  from: NodeId;
  to: NodeId;
  d: string;
  feed?: boolean;
}

// Coordinates match the node layout (node 180×76); top-row centre y=74, bottom y=278.
const EDGES: EdgeDef[] = [
  { from: "target", to: "generator", d: "M204,74 L268,74" },
  { from: "generator", to: "surrogate", d: "M448,74 L512,74" },
  { from: "surrogate", to: "acquisition", d: "M692,74 L756,74" },
  { from: "acquisition", to: "synthesis", d: "M846,112 L846,240" },
  { from: "synthesis", to: "assay", d: "M756,278 L696,278" },
  { from: "assay", to: "ingest", d: "M512,278 L452,278" },
  { from: "ingest", to: "store", d: "M268,278 L208,278" },
  { from: "store", to: "target", d: "M114,240 L114,112" },
  { from: "store", to: "surrogate", d: "M126,242 C 300,182 460,168 596,114", feed: true },
];

const idleStates = (): Record<NodeId, RunState> =>
  Object.fromEntries(NODES.map((n) => [n.id, "idle"])) as Record<NodeId, RunState>;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface LogEntry {
  label: string;
  state: RunState | "error";
}

export default function Workflow() {
  const [states, setStates] = useState<Record<NodeId, RunState>>(idleStates());
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data: summary, reload: reloadSummary } = useAsync<LoopSummary>(() =>
    api.loopSummary(),
  );
  const [batch, setBatch] = useState<AcquisitionBatch | null>(null);
  const [selectedCount, setSelectedCount] = useState<number | null>(null);
  const [replay, setReplay] = useState<ReplayResponse | null>(null);

  function setNodes(ids: NodeId[], st: RunState) {
    setStates((prev) => {
      const next = { ...prev };
      for (const id of ids) next[id] = st;
      return next;
    });
  }

  // Run one stage: mark node(s) running, await the work (with a min beat so the
  // animation is visible), then mark done. Appends to the run log.
  async function step<T>(ids: NodeId[], label: string, work: () => Promise<T>): Promise<T> {
    setNodes(ids, "running");
    setLogs((l) => [...l, { label, state: "running" }]);
    try {
      const [res] = await Promise.all([work(), delay(750)]);
      setNodes(ids, "done");
      setLogs((l) => l.map((e, i) => (i === l.length - 1 ? { ...e, state: "done" } : e)));
      return res;
    } catch (e) {
      setNodes(ids, "idle");
      setLogs((l) => l.map((e, i) => (i === l.length - 1 ? { ...e, state: "error" } : e)));
      throw e;
    }
  }

  async function withBusy(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doGenerate() {
    await step(["target"], "Load target — KINASE_X pocket", () => api.target());
    const b = await step(
      ["generator", "surrogate", "acquisition"],
      "Generate → score → acquisition gate (Boltz design · ECFP/RF µ,σ · UCB)",
      () => api.acquisitionBatch(),
    );
    setBatch(b);
  }

  async function doApprove() {
    const sum = await step(["synthesis"], "Approve batch → synthesis queue", () =>
      api.acquisitionApprove(),
    );
    setSelectedCount(sum.in_synthesis);
    reloadSummary();
  }

  async function doReplay() {
    const r = await step(
      ["assay", "ingest", "store"],
      "Replay wet-lab results → ingest / normalize → activity store",
      () => api.loopReplay(),
    );
    setReplay(r);
    reloadSummary();
  }

  const runAll = () =>
    withBusy(async () => {
      setStates(idleStates());
      setLogs([]);
      setBatch(null);
      setReplay(null);
      setSelectedCount(null);
      await doGenerate();
      await doApprove();
      await doReplay();
    });

  const resetAll = () =>
    withBusy(async () => {
      await api.reset();
      setStates(idleStates());
      setLogs([]);
      setBatch(null);
      setReplay(null);
      setSelectedCount(null);
      reloadSummary();
    });

  function edgeClass(e: EdgeDef): string {
    const f = states[e.from];
    const t = states[e.to];
    let state = "idle";
    if (f === "done" && t === "done") state = "done";
    else if (f === "done" || t === "running") state = "active";
    return `wf-edge ${state}${e.feed ? " feed" : ""}`;
  }

  function nodeCount(id: NodeId): number | null {
    switch (id) {
      case "generator":
        return batch?.generated ?? null;
      case "surrogate":
        return batch?.scored ?? null;
      case "acquisition":
        return batch?.shortlisted ?? null;
      case "synthesis":
        return selectedCount;
      case "assay":
      case "ingest":
        return replay?.replayed ?? null;
      case "store":
        return summary?.ingested ?? null;
      default:
        return null;
    }
  }

  return (
    <div>
      <h1>Workflow</h1>
      <p className="muted">
        The closed loop as an executable pipeline. Press{" "}
        <strong>Run full loop</strong> to drive the real stages end to end, or run
        a single stage — nodes light up and edges flow as the work happens.
      </p>
      <PersonaHint route="/workflow" />

      <div className="wf-toolbar">
        <button className="btn btn-primary" onClick={runAll} disabled={busy}>
          {busy ? <span className="spinner" /> : "▶"}&nbsp; Run full loop
        </button>
        <button className="btn" onClick={() => withBusy(doGenerate)} disabled={busy}>
          1 · Generate
        </button>
        <button className="btn" onClick={() => withBusy(doApprove)} disabled={busy}>
          2 · Approve
        </button>
        <button className="btn" onClick={() => withBusy(doReplay)} disabled={busy}>
          3 · Replay
        </button>
        <button className="btn" onClick={resetAll} disabled={busy}>
          Reset
        </button>
        {busy && (
          <span className="muted" style={{ fontSize: "0.82rem", display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
            <span className="spinner" /> analyzing…
          </span>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="panel" style={{ padding: "0.75rem" }}>
        <div className="wf-wrap">
          <div className="wf-canvas">
            <svg className="wf-edges" viewBox="0 0 1000 360" width="1000" height="360">
              <defs>
                <marker
                  id="wf-arrow"
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M0,0 L10,5 L0,10 z" fill="context-stroke" />
                </marker>
              </defs>
              {EDGES.map((e) => (
                <path
                  key={`${e.from}-${e.to}`}
                  className={edgeClass(e)}
                  d={e.d}
                  markerEnd="url(#wf-arrow)"
                />
              ))}
            </svg>

            {NODES.map((n) => {
              const st = states[n.id];
              const count = nodeCount(n.id);
              return (
                <div
                  key={n.id}
                  className={`wf-node ${st}`}
                  style={{ left: n.x, top: n.y }}
                >
                  <div className="wf-kicker" style={{ color: n.color }}>
                    {n.kicker}
                  </div>
                  <div className="wf-node-title">{n.title}</div>
                  <div className="wf-node-sub">{n.sub}</div>
                  <div className="wf-node-meta">
                    <span className="wf-count">{count != null ? count : ""}</span>
                    <span className={`wf-status ${st}`}>
                      <span className="dotk" />
                      {st === "running" ? "running" : st === "done" ? "done" : "idle"}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: "1rem", marginTop: "1rem", flexWrap: "wrap" }}>
        <div className="panel" style={{ flex: "1 1 360px" }}>
          <h3 style={{ marginTop: 0 }}>Run log</h3>
          {logs.length === 0 ? (
            <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>
              No run yet. Press <strong>Run full loop</strong> to start.
            </p>
          ) : (
            <ul className="wf-log">
              {logs.map((e, i) => (
                <li key={i}>
                  {e.state === "running" ? (
                    <span className="spinner" />
                  ) : e.state === "error" ? (
                    <span className="wf-x">✕</span>
                  ) : (
                    <span className="wf-check">✓</span>
                  )}
                  <span>{e.label}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="panel" style={{ flex: "1 1 240px" }}>
          <h3 style={{ marginTop: 0 }}>Loop counts</h3>
          <div className="kv">
            <span className="muted">Model-ready</span>
            <span style={{ color: "var(--green)", fontWeight: 600 }}>{summary?.model_ready ?? "—"}</span>
            <span className="muted">Normalizable</span>
            <span style={{ color: "var(--amber)" }}>{summary?.normalizable ?? "—"}</span>
            <span className="muted">Blocked</span>
            <span style={{ color: "var(--red)" }}>{summary?.blocked ?? "—"}</span>
            <span className="muted">In synthesis</span>
            <span>{summary?.in_synthesis ?? "—"}</span>
            {replay?.calibration_error != null && (
              <>
                <span className="muted">Calibration err</span>
                <span>{replay.calibration_error} log-µM</span>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
