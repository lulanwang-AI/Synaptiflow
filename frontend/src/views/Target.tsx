// Target / substrate view — the leftmost node of the inner loop. This is the
// protein the generator designs against: Boltz `design` proposes molecules into
// its pocket and `screen` scores affinity to it. Read-only; uses GET /target.

import { api } from "../api/client";
import { useAsync } from "../lib/useAsync";
import type { Target } from "../api/types";
import { PersonaHint } from "../lib/persona";

const ROW = 60;

function SequenceViewer({ seq, pocket }: { seq: string; pocket: number[] }) {
  const pocketSet = new Set(pocket);
  const rows: { start: number; chars: string[] }[] = [];
  for (let i = 0; i < seq.length; i += ROW) {
    rows.push({ start: i + 1, chars: seq.slice(i, i + ROW).split("") });
  }
  return (
    <div className="seq">
      {rows.map((row) => (
        <div className="seq-row" key={row.start}>
          <span className="seq-pos">{row.start}</span>
          <span>
            {row.chars.map((ch, j) => {
              const pos = row.start + j;
              const isPocket = pocketSet.has(pos);
              return (
                <span
                  key={pos}
                  className={isPocket ? "seq-res pocket" : "seq-res"}
                  title={isPocket ? `${ch}${pos} · pocket` : `${ch}${pos}`}
                >
                  {ch}
                </span>
              );
            })}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function TargetView() {
  const { data, loading, error } = useAsync<Target>(() => api.target());

  return (
    <div>
      <h1>Target — the design substrate</h1>
      <p className="muted">
        The biological target the loop designs against — the leftmost node of the
        inner loop. Boltz <span className="mono">design</span> proposes molecules
        into this protein's pocket and <span className="mono">screen</span> scores
        their affinity to it, so every candidate downstream is ranked relative to
        this construct.
      </p>
      <PersonaHint route="/target" />

      {error && <div className="error-banner">{error}</div>}
      {loading && <p className="muted">Loading…</p>}

      {data && (
        <>
          <div className="panel">
            <div className="kv">
              <span className="muted">Name</span>
              <span>
                <strong>{data.name ?? "—"}</strong>
              </span>
              <span className="muted">Chains</span>
              <span>{data.chain_ids.length ? data.chain_ids.join(", ") : "—"}</span>
              <span className="muted">Sequence length</span>
              <span>{data.protein_sequence.length} residues</span>
              <span className="muted">Pocket residues</span>
              <span>
                {data.pocket_residues.length ? (
                  data.pocket_residues.map((r) => (
                    <span key={r} className="chip chip-pocket">
                      {r}
                    </span>
                  ))
                ) : (
                  "—"
                )}
              </span>
            </div>
          </div>

          <h2>Sequence</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            Pocket residues (the design site) are highlighted.
          </p>
          <div className="panel" style={{ overflowX: "auto" }}>
            <SequenceViewer
              seq={data.protein_sequence}
              pocket={data.pocket_residues}
            />
          </div>
        </>
      )}
    </div>
  );
}
