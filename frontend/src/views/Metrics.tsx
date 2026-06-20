import { api } from "../api/client";
import { useAsync } from "../lib/useAsync";
import type { Metrics } from "../api/types";
import { fmtNum, fmtUsd } from "../lib/format";
import { PersonaHint } from "../lib/persona";

function Bar({ value, max, color }: { value: number; max: number; color?: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="bar-track">
      <div className="bar-fill" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

export default function MetricsView() {
  const { data, loading, error } = useAsync<Metrics>(() => api.metrics());

  return (
    <div>
      <h1>Health / metrics</h1>
      <p className="muted">
        Manager dashboard. The frontend never calls Boltz directly — credit
        spend and calibration are read from <span className="mono">/metrics</span>.
      </p>
      <PersonaHint route="/metrics" />

      {error && <div className="error-banner">{error}</div>}
      {loading && <p className="muted">Loading…</p>}
      {data && <Body m={data} />}
    </div>
  );
}

function Body({ m }: { m: Metrics }) {
  const blockedEntries = Object.entries(m.blocked_by_reason);
  const maxBlocked = Math.max(1, ...blockedEntries.map(([, v]) => v));
  const queueEntries = Object.entries(m.queue_depths);
  const maxQueue = Math.max(1, ...queueEntries.map(([, v]) => v));

  return (
    <div className="grid-cards">
      {/* model-ready % */}
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Model-ready</h3>
        <div style={{ fontSize: "2rem", fontWeight: 700, color: "var(--green)" }}>
          {fmtNum(m.pct_model_ready, 1)}%
        </div>
        <Bar value={m.pct_model_ready} max={100} color="var(--green)" />
        <p className="muted" style={{ marginBottom: 0 }}>
          {m.total_records} total records
        </p>
      </div>

      {/* blocked-by-reason */}
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Blocked by reason</h3>
        {blockedEntries.length === 0 && <p className="muted">Nothing blocked.</p>}
        {blockedEntries.map(([reason, count]) => (
          <div key={reason} style={{ marginBottom: "0.5rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.84rem" }}>
              <span className="mono">{reason}</span>
              <strong>{count}</strong>
            </div>
            <Bar value={count} max={maxBlocked} color="var(--red)" />
          </div>
        ))}
      </div>

      {/* queue depths + cycle time */}
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Queue depths</h3>
        {queueEntries.length === 0 && <p className="muted">Empty.</p>}
        {queueEntries.map(([q, count]) => (
          <div key={q} style={{ marginBottom: "0.5rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.84rem" }}>
              <span className="mono">{q}</span>
              <strong>{count}</strong>
            </div>
            <Bar value={count} max={maxQueue} />
          </div>
        ))}
        <p className="muted" style={{ marginBottom: 0 }}>
          Cycle time: {m.cycle_time_s != null ? `${fmtNum(m.cycle_time_s)} s` : "—"}
        </p>
      </div>

      {/* Boltz credit widget */}
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Boltz credit</h3>
        <Bar value={m.credit_spent_usd} max={m.credit_cap_usd} color="var(--amber)" />
        <div className="kv" style={{ marginTop: "0.5rem" }}>
          <span className="muted">Spent</span>
          <span>{fmtUsd(m.credit_spent_usd)}</span>
          <span className="muted">Cap</span>
          <span>{fmtUsd(m.credit_cap_usd)}</span>
          <span className="muted">Remaining</span>
          <span>
            <strong>{fmtUsd(m.credit_remaining_usd)}</strong>
          </span>
        </div>
      </div>

      {/* surrogate calibration */}
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Surrogate calibration</h3>
        <div className="kv">
          <span className="muted">Mean |pred − measured| (log-µM)</span>
          <span style={{ fontSize: "1.3rem", fontWeight: 700 }}>
            {m.calibration_error != null ? fmtNum(m.calibration_error, 3) : "—"}
          </span>
          <span className="muted">Closed-cycle samples (n)</span>
          <span>{m.calibration_n}</span>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Boltz-predicted vs wet-lab measured, over closed cycles. Approve a batch
          and replay results on the Next-batch view to grow n.
        </p>
      </div>
    </div>
  );
}
