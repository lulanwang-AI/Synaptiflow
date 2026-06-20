import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { useAsync } from "../lib/useAsync";
import type { LoopSummary } from "../api/types";
import { PersonaHint } from "../lib/persona";

// A clickable loop stage rendered inside the SVG.
function Stage({
  x,
  y,
  w,
  h,
  title,
  count,
  highlight,
  onClick,
  fill = "#ffffff",
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  count?: number;
  highlight?: boolean;
  onClick?: () => void;
  fill?: string;
}) {
  return (
    <g
      style={{ cursor: onClick ? "pointer" : "default" }}
      onClick={onClick}
      role={onClick ? "button" : undefined}
    >
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={10}
        fill={highlight ? "#ffebe9" : fill}
        stroke={highlight ? "#cf222e" : "#c9d1da"}
        strokeWidth={highlight ? 2.5 : 1.5}
      />
      <text
        x={x + w / 2}
        y={y + 22}
        textAnchor="middle"
        fontSize="13"
        fontWeight="600"
        fill="#1b1f24"
      >
        {title}
      </text>
      {count != null && (
        <>
          <circle
            cx={x + w - 16}
            cy={y + 14}
            r={13}
            fill={highlight ? "#cf222e" : "#0969da"}
          />
          <text
            x={x + w - 16}
            y={y + 18}
            textAnchor="middle"
            fontSize="11"
            fontWeight="700"
            fill="#fff"
          >
            {count}
          </text>
        </>
      )}
    </g>
  );
}

function Arrow({
  x1,
  y1,
  x2,
  y2,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}) {
  return (
    <line
      x1={x1}
      y1={y1}
      x2={x2}
      y2={y2}
      stroke="#8b949e"
      strokeWidth={2}
      markerEnd="url(#arrow)"
    />
  );
}

export default function LoopOverview() {
  const nav = useNavigate();
  const { data, loading, error } = useAsync<LoopSummary>(() => api.loopSummary());

  const s: LoopSummary = data ?? {
    generated: 0,
    scored: 0,
    selected: 0,
    in_synthesis: 0,
    assayed: 0,
    ingested: 0,
    model_ready: 0,
    normalizable: 0,
    blocked: 0,
  };

  const goRecords = (status?: string) =>
    nav(status ? `/records?status=${status}` : "/records");

  return (
    <div>
      <h1>Two-loop DMTA flow</h1>
      <p className="muted">
        Inner compute loop (generate → cheap surrogate → acquisition gate) and
        outer wet-lab loop (synthesis → assay → ingest), both fed by the activity
        store. Counts are live from <span className="mono">/loop/summary</span>.
        Click a stage to drill into its records.
      </p>
      <PersonaHint route="/" />

      {error && <div className="error-banner">{error}</div>}
      {loading && <p className="muted">Loading…</p>}

      <div className="panel" style={{ overflowX: "auto" }}>
        <svg viewBox="0 0 900 480" width="100%" style={{ maxWidth: 900 }}>
          <defs>
            <marker
              id="arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#8b949e" />
            </marker>
          </defs>

          {/* loop labels */}
          <text x={250} y={28} textAnchor="middle" fontSize="12" fill="#6639ba" fontWeight="700">
            INNER LOOP — compute (fast, free, many/round)
          </text>
          <text x={250} y={462} textAnchor="middle" fontSize="12" fill="#1a7f37" fontWeight="700">
            OUTER LOOP — wet lab (slow, $$$, once/round)
          </text>

          {/* activity store — substrate feeding both loops */}
          <Stage
            x={690}
            y={195}
            w={180}
            h={90}
            title="Activity store"
            fill="#eef1f5"
          />
          <text x={780} y={252} textAnchor="middle" fontSize="11" fill="#5b6470">
            single source of truth
          </text>
          <text x={780} y={268} textAnchor="middle" fontSize="11" fill="#5b6470">
            + surrogate training set
          </text>

          {/* inner loop (top) */}
          <Stage x={40} y={60} w={170} h={60} title="Generator" count={s.generated} fill="#f3edff" />
          <Stage x={250} y={60} w={170} h={60} title="Cheap surrogate" count={s.scored} fill="#f3edff" />

          {/* acquisition gate — the hinge between loops */}
          <Stage
            x={365}
            y={195}
            w={180}
            h={90}
            title="Acquisition gate"
            count={s.selected}
            onClick={() => nav("/acquisition")}
            fill="#fff7e6"
          />
          <text x={455} y={252} textAnchor="middle" fontSize="11" fill="#9a6700">
            UCB + Boltz re-rank
          </text>
          <text x={455} y={268} textAnchor="middle" fontSize="11" fill="#9a6700">
            (the hinge)
          </text>

          {/* outer loop (bottom) */}
          <Stage x={460} y={360} w={150} h={60} title="Synthesis" count={s.in_synthesis} fill="#e6f4ea" />
          <Stage x={250} y={360} w={150} h={60} title="Assay" count={s.assayed} fill="#e6f4ea" />
          <Stage
            x={40}
            y={360}
            w={170}
            h={60}
            title="Ingest / normalize"
            count={s.ingested}
            onClick={() => goRecords()}
            fill="#e6f4ea"
          />

          {/* arrows: inner loop */}
          <Arrow x1={210} y1={90} x2={250} y2={90} />
          <Arrow x1={335} y1={120} x2={420} y2={195} />
          {/* surrogate -> gate */}

          {/* gate -> selected batch -> synthesis (down into outer loop) */}
          <Arrow x1={500} y1={285} x2={520} y2={360} />
          {/* synthesis -> assay -> ingest */}
          <Arrow x1={460} y1={390} x2={400} y2={390} />
          <Arrow x1={250} y1={390} x2={210} y2={390} />
          {/* ingest -> activity store (feed) */}
          <Arrow x1={125} y1={360} x2={125} y2={285} />
          <Arrow x1={125} y1={285} x2={690} y2={240} />
          {/* activity store -> generator (substrate feed, training) */}
          <Arrow x1={760} y1={195} x2={125} y2={120} />

          {/* model-ready + blocked summary badges (clickable) */}
          <Stage
            x={620}
            y={60}
            w={120}
            h={55}
            title="Model-ready"
            count={s.model_ready}
            onClick={() => goRecords("model_ready")}
            fill="#e6f4ea"
          />
          <Stage
            x={755}
            y={60}
            w={115}
            h={55}
            title="BLOCKED"
            count={s.blocked}
            highlight
            onClick={() => goRecords("blocked")}
          />
        </svg>
      </div>

      <div style={{ display: "flex", gap: "0.75rem", marginTop: "1rem", flexWrap: "wrap" }}>
        <CountTile label="Generated" value={s.generated} onClick={() => nav("/acquisition")} />
        <CountTile label="Scored" value={s.scored} onClick={() => nav("/acquisition")} />
        <CountTile label="Selected" value={s.selected} onClick={() => nav("/acquisition")} />
        <CountTile label="In synthesis" value={s.in_synthesis} />
        <CountTile label="Assayed" value={s.assayed} onClick={() => goRecords()} />
        <CountTile label="Ingested" value={s.ingested} onClick={() => goRecords()} />
        <CountTile
          label="Model-ready"
          value={s.model_ready}
          color="var(--green)"
          onClick={() => goRecords("model_ready")}
        />
        <CountTile
          label="Normalizable"
          value={s.normalizable}
          color="var(--amber)"
          onClick={() => goRecords("normalizable")}
        />
        <CountTile
          label="Blocked"
          value={s.blocked}
          color="var(--red)"
          emphasize
          onClick={() => goRecords("blocked")}
        />
      </div>
    </div>
  );
}

function CountTile({
  label,
  value,
  color,
  emphasize,
  onClick,
}: {
  label: string;
  value: number;
  color?: string;
  emphasize?: boolean;
  onClick?: () => void;
}) {
  return (
    <div
      className="panel"
      onClick={onClick}
      style={{
        minWidth: 110,
        cursor: onClick ? "pointer" : "default",
        borderColor: emphasize ? "var(--red)" : undefined,
        borderWidth: emphasize ? 2 : 1,
      }}
    >
      <div className="muted" style={{ fontSize: "0.78rem" }}>
        {label}
      </div>
      <div style={{ fontSize: "1.6rem", fontWeight: 700, color: color ?? "var(--fg)" }}>
        {value}
      </div>
    </div>
  );
}
