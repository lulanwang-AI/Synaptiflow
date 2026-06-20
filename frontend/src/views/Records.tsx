import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { useAsync } from "../lib/useAsync";
import type { AssayRecord, RecordPatch } from "../api/types";
import StatusDot from "../components/StatusDot";
import StructureCanvas from "../components/StructureCanvas";
import { rawValueLabel } from "../lib/format";
import { PersonaHint } from "../lib/persona";

// Maps a missing_fields[] entry (dot-path) to a friendly label + numeric flag.
const FIELD_META: Record<string, { label: string; numeric: boolean; section: keyof RecordPatch }> = {
  "assay.target_construct": { label: "Target construct", numeric: false, section: "assay" },
  "assay.unit": { label: "Unit (e.g. M, nM)", numeric: false, section: "assay" },
  "compound.smiles": { label: "SMILES", numeric: false, section: "compound" },
  "conditions.substrate_conc_M": { label: "Substrate conc [S] (M)", numeric: true, section: "conditions" },
  "conditions.km_M": { label: "Km (M)", numeric: true, section: "conditions" },
  "conditions.ligand_conc_M": { label: "Ligand conc [L] (M)", numeric: true, section: "conditions" },
  "conditions.probe_kd_M": { label: "Probe Kd (M)", numeric: true, section: "conditions" },
};

function DetailPanel({
  record,
  onPatched,
}: {
  record: AssayRecord;
  onPatched: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const missing = record.missing_fields ?? [];

  async function submit() {
    setSaving(true);
    setSaveError(null);
    const patch: RecordPatch = {};
    for (const field of missing) {
      const meta = FIELD_META[field];
      const raw = values[field];
      if (raw == null || raw === "") continue;
      const key = field.split(".")[1];
      const section = (meta?.section ?? "conditions") as keyof RecordPatch;
      const target = (patch[section] ??= {} as never) as unknown as Record<
        string,
        unknown
      >;
      target[key] = meta?.numeric ? Number(raw) : raw;
    }
    try {
      await api.patchRecord(record.record_id, patch);
      onPatched();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="panel" style={{ marginTop: "1rem" }}>
      <div style={{ display: "flex", gap: "1rem", alignItems: "flex-start" }}>
        <StructureCanvas smiles={record.compound.smiles} width={140} height={110} />
        <div style={{ flex: 1 }}>
          <h3 style={{ marginTop: 0 }}>
            <StatusDot status={record.status} /> &nbsp;
            <span className="mono">{record.record_id}</span>
          </h3>
          <div className="kv">
            <span className="muted">Canonical SMILES</span>
            <span className="mono">{record.compound.smiles_canonical ?? record.compound.smiles}</span>
            <span className="muted">InChIKey</span>
            <span className="mono">
              {record.compound.inchikey ? (
                <Link to={`/compound/${record.compound.inchikey}`}>
                  {record.compound.inchikey}
                </Link>
              ) : (
                "—"
              )}
            </span>
            <span className="muted">Assay</span>
            <span>
              {record.assay.assay_type} · {record.assay.readout} ·{" "}
              {rawValueLabel(record.assay.value, record.assay.unit)}
            </span>
            <span className="muted">Construct</span>
            <span>{record.assay.target_construct ?? "—"}</span>
            {record.ki_M != null && (
              <>
                <span className="muted">Derived Ki</span>
                <span>{record.ki_M.toExponential(2)} M</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* reason_detail quoted VERBATIM */}
      {record.reason_detail && (
        <div
          className={record.status === "blocked" ? "error-banner" : "persona-hint"}
          style={{ marginTop: "0.85rem" }}
        >
          <strong>Reason (verbatim):</strong>{" "}
          <span className="mono">{record.reason_detail}</span>
        </div>
      )}

      {record.status === "blocked" && missing.length > 0 && (
        <div style={{ marginTop: "0.5rem" }}>
          <h3>Fill the missing fields to unblock</h3>
          {missing.map((field) => {
            const meta = FIELD_META[field];
            return (
              <div className="form-row" key={field}>
                <label>{meta?.label ?? field}</label>
                <input
                  type={meta?.numeric ? "number" : "text"}
                  step="any"
                  placeholder={field}
                  value={values[field] ?? ""}
                  onChange={(e) =>
                    setValues((v) => ({ ...v, [field]: e.target.value }))
                  }
                />
              </div>
            );
          })}
          {saveError && <div className="error-banner">{saveError}</div>}
          <button className="btn btn-primary" onClick={submit} disabled={saving}>
            {saving ? "Saving…" : "Save & re-ingest"}
          </button>
        </div>
      )}

      {record.status === "blocked" && missing.length === 0 && (
        <p className="muted" style={{ marginTop: "0.5rem" }}>
          This record is blocked but exposes no auto-fillable fields (e.g. QC
          failure). It must be re-run, not patched.
        </p>
      )}
    </div>
  );
}

export default function Records() {
  const [searchParams, setSearchParams] = useSearchParams();
  const statusFilter = searchParams.get("status") ?? "";
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data, loading, error, reload } = useAsync<AssayRecord[]>(
    () => api.listRecords(statusFilter || undefined),
    [statusFilter],
  );

  const records = useMemo(() => data ?? [], [data]);
  const selected = useMemo(
    () => records.find((r) => r.record_id === selectedId) ?? null,
    [records, selectedId],
  );

  function setFilter(v: string) {
    if (v) setSearchParams({ status: v });
    else setSearchParams({});
    setSelectedId(null);
  }

  return (
    <div>
      <h1>Assay records</h1>
      <p className="muted">
        Semantic-completeness status: <StatusDot status="model_ready" /> ·{" "}
        <StatusDot status="normalizable" /> · <StatusDot status="blocked" />.
        Click a row to inspect and fix it.
      </p>
      <PersonaHint route="/records" />

      <div style={{ marginBottom: "0.75rem", display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
        {["", "model_ready", "normalizable", "blocked"].map((v) => (
          <button
            key={v || "all"}
            className={`btn ${statusFilter === v ? "btn-primary" : ""}`}
            onClick={() => setFilter(v)}
          >
            {v === "" ? "All" : v.replace("_", "-")}
          </button>
        ))}
      </div>

      {error && <div className="error-banner">{error}</div>}
      {loading && <p className="muted">Loading…</p>}

      <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Compound</th>
              <th>Assay type</th>
              <th>Readout</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <tr
                key={r.record_id}
                className={r.record_id === selectedId ? "selected" : ""}
                onClick={() => setSelectedId(r.record_id)}
              >
                <td>
                  <StatusDot status={r.status} />
                </td>
                <td>
                  <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                    <StructureCanvas smiles={r.compound.smiles} width={70} height={54} />
                    <span className="mono" style={{ wordBreak: "break-all" }}>
                      {r.compound.smiles_canonical ?? r.compound.smiles}
                    </span>
                  </div>
                </td>
                <td>{r.assay.assay_type}</td>
                <td>{r.assay.readout}</td>
                <td>{rawValueLabel(r.assay.value, r.assay.unit)}</td>
              </tr>
            ))}
            {records.length === 0 && !loading && (
              <tr>
                <td colSpan={5} className="muted">
                  No records for this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {selected && (
        <DetailPanel
          record={selected}
          onPatched={() => {
            reload();
          }}
        />
      )}
    </div>
  );
}
