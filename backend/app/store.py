"""Activity store — the single source of truth (spec §2 stage 3).

SQLite, keyed on InChIKey, joining identity ↔ measurement ↔ conditions. Holds
TWO lanes that are never mixed:
  * assay records (ground truth)
  * predictions    (Boltz outputs, §1)

Plus lightweight loop counters and a calibration accumulator.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from typing import Optional

from .ingest import pki
from .schema import (
    AssayRecord,
    ComparabilityGroup,
    CompoundMeasurement,
    CompoundView,
    LoopSummary,
    Metrics,
    Prediction,
    RecordStatus,
)

_LOCK = threading.Lock()


class Store:
    def __init__(self, path: str = ":memory:"):
        self.path = path
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self._init_schema()

    def _init_schema(self) -> None:
        self.conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS records (
                record_id TEXT PRIMARY KEY,
                inchikey  TEXT,
                status    TEXT,
                json      TEXT
            );
            CREATE TABLE IF NOT EXISTS predictions (
                inchikey TEXT PRIMARY KEY,
                json     TEXT
            );
            CREATE TABLE IF NOT EXISTS counters (
                key   TEXT PRIMARY KEY,
                value REAL
            );
            CREATE TABLE IF NOT EXISTS calibration (
                inchikey  TEXT PRIMARY KEY,
                predicted REAL,
                measured  REAL,
                abs_err   REAL
            );
            CREATE INDEX IF NOT EXISTS idx_records_ik ON records(inchikey);
            """
        )
        self.conn.commit()

    # ------------------------------------------------------------------ #
    # Reset / seed
    # ------------------------------------------------------------------ #
    def reset(self) -> None:
        with _LOCK:
            self.conn.executescript(
                "DELETE FROM records; DELETE FROM predictions; "
                "DELETE FROM counters; DELETE FROM calibration;"
            )
            self.conn.commit()

    # ------------------------------------------------------------------ #
    # Assay-record lane
    # ------------------------------------------------------------------ #
    def upsert(self, record: AssayRecord) -> None:
        with _LOCK:
            self.conn.execute(
                "INSERT INTO records (record_id, inchikey, status, json) "
                "VALUES (?,?,?,?) ON CONFLICT(record_id) DO UPDATE SET "
                "inchikey=excluded.inchikey, status=excluded.status, json=excluded.json",
                (
                    record.record_id,
                    record.compound.inchikey,
                    record.status.value,
                    record.model_dump_json(),
                ),
            )
            self.conn.commit()

    def get(self, record_id: str) -> Optional[AssayRecord]:
        row = self.conn.execute(
            "SELECT json FROM records WHERE record_id=?", (record_id,)
        ).fetchone()
        if not row:
            return None
        return AssayRecord.model_validate_json(row["json"])

    def all_records(self) -> list[AssayRecord]:
        rows = self.conn.execute("SELECT json FROM records ORDER BY record_id").fetchall()
        return [AssayRecord.model_validate_json(r["json"]) for r in rows]

    def blocked_records(self) -> list[AssayRecord]:
        return [r for r in self.all_records() if r.status == RecordStatus.blocked]

    def records_for(self, inchikey: str) -> list[AssayRecord]:
        rows = self.conn.execute(
            "SELECT json FROM records WHERE inchikey=? ORDER BY record_id", (inchikey,)
        ).fetchall()
        return [AssayRecord.model_validate_json(r["json"]) for r in rows]

    def model_ready_dataset(self) -> list[tuple[str, float]]:
        """(canonical_smiles, pKi) pairs for surrogate training.

        Includes model_ready and normalizable (soft-QC) records that carry a Ki.
        """
        out: list[tuple[str, float]] = []
        for r in self.all_records():
            if r.status in (RecordStatus.model_ready, RecordStatus.normalizable):
                p = pki(r.ki_M)
                if p is not None and r.compound.smiles_canonical:
                    out.append((r.compound.smiles_canonical, p))
        return out

    # ------------------------------------------------------------------ #
    # Per-compound comparability view
    # ------------------------------------------------------------------ #
    def compound_measurements(self, inchikey: str) -> CompoundView:
        records = self.records_for(inchikey)
        groups: dict[str, list[CompoundMeasurement]] = {}
        smiles_canonical = None
        compound_id = None
        for r in records:
            smiles_canonical = smiles_canonical or r.compound.smiles_canonical
            compound_id = compound_id or r.compound.compound_id
            key = r.comparability_key or f"{r.assay.target_construct}::{r.assay.readout}"
            groups.setdefault(key, []).append(
                CompoundMeasurement(
                    record_id=r.record_id,
                    assay_type=r.assay.assay_type,
                    readout=r.assay.readout,
                    target_construct=r.assay.target_construct,
                    value=r.assay.value,
                    unit=r.assay.unit,
                    ki_M=r.ki_M,
                    status=r.status,
                    comparability_key=r.comparability_key,
                )
            )

        comp_groups = [
            ComparabilityGroup(
                comparability_key=k,
                poolable=len(v) > 1,
                measurements=v,
            )
            for k, v in groups.items()
        ]

        # representative measured Ki = best (lowest) Ki among comparable Ki-space
        measured_ki = None
        for r in records:
            if r.ki_M is not None:
                measured_ki = r.ki_M if measured_ki is None else min(measured_ki, r.ki_M)

        prediction = self.get_prediction(inchikey)
        delta = None
        if prediction is not None and measured_ki is not None and measured_ki > 0:
            import math

            measured_loguM = math.log10(measured_ki) + 6.0  # M -> log µM
            delta = prediction.boltz_affinity_loguM - measured_loguM

        return CompoundView(
            inchikey=inchikey,
            smiles_canonical=smiles_canonical,
            compound_id=compound_id,
            groups=comp_groups,
            prediction=prediction,
            measured_ki_M=measured_ki,
            delta_loguM=delta,
        )

    # ------------------------------------------------------------------ #
    # Predictions lane
    # ------------------------------------------------------------------ #
    def upsert_prediction(self, pred: Prediction) -> None:
        with _LOCK:
            self.conn.execute(
                "INSERT INTO predictions (inchikey, json) VALUES (?,?) "
                "ON CONFLICT(inchikey) DO UPDATE SET json=excluded.json",
                (pred.inchikey, pred.model_dump_json()),
            )
            self.conn.commit()

    def get_prediction(self, inchikey: str) -> Optional[Prediction]:
        row = self.conn.execute(
            "SELECT json FROM predictions WHERE inchikey=?", (inchikey,)
        ).fetchone()
        if not row:
            return None
        return Prediction.model_validate_json(row["json"])

    def all_predictions(self) -> list[Prediction]:
        rows = self.conn.execute("SELECT json FROM predictions").fetchall()
        return [Prediction.model_validate_json(r["json"]) for r in rows]

    # ------------------------------------------------------------------ #
    # Counters (generated, scored, selected, in_synthesis, assayed, timing)
    # ------------------------------------------------------------------ #
    def set_counter(self, key: str, value: float) -> None:
        with _LOCK:
            self.conn.execute(
                "INSERT INTO counters (key, value) VALUES (?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, value),
            )
            self.conn.commit()

    def bump_counter(self, key: str, by: float = 1) -> None:
        self.set_counter(key, self.get_counter(key) + by)

    def get_counter(self, key: str) -> float:
        row = self.conn.execute("SELECT value FROM counters WHERE key=?", (key,)).fetchone()
        return row["value"] if row else 0.0

    # ------------------------------------------------------------------ #
    # Calibration accumulator
    # ------------------------------------------------------------------ #
    def record_calibration(self, inchikey: str, predicted: float, measured: float) -> None:
        with _LOCK:
            self.conn.execute(
                "INSERT INTO calibration (inchikey, predicted, measured, abs_err) "
                "VALUES (?,?,?,?) ON CONFLICT(inchikey) DO UPDATE SET "
                "predicted=excluded.predicted, measured=excluded.measured, abs_err=excluded.abs_err",
                (inchikey, predicted, measured, abs(predicted - measured)),
            )
            self.conn.commit()

    def calibration_error(self) -> tuple[Optional[float], int]:
        rows = self.conn.execute("SELECT abs_err FROM calibration").fetchall()
        if not rows:
            return None, 0
        errs = [r["abs_err"] for r in rows]
        return sum(errs) / len(errs), len(errs)

    # ------------------------------------------------------------------ #
    # Aggregates
    # ------------------------------------------------------------------ #
    def status_counts(self) -> dict[str, int]:
        rows = self.conn.execute(
            "SELECT status, COUNT(*) AS n FROM records GROUP BY status"
        ).fetchall()
        return {r["status"]: r["n"] for r in rows}

    def loop_summary(self) -> LoopSummary:
        sc = self.status_counts()
        ingested = sum(sc.values())
        return LoopSummary(
            generated=int(self.get_counter("generated")),
            scored=int(self.get_counter("scored")),
            selected=int(self.get_counter("selected")),
            in_synthesis=int(self.get_counter("in_synthesis")),
            assayed=int(self.get_counter("assayed")),
            ingested=ingested,
            model_ready=sc.get("model_ready", 0),
            normalizable=sc.get("normalizable", 0),
            blocked=sc.get("blocked", 0),
        )

    def metrics(self, credit_spent: float, credit_cap: float) -> Metrics:
        records = self.all_records()
        total = len(records)
        sc = self.status_counts()
        ready = sc.get("model_ready", 0)
        blocked_by_reason: dict[str, int] = {}
        for r in records:
            if r.status == RecordStatus.blocked and r.blocked_reason:
                k = r.blocked_reason.value
                blocked_by_reason[k] = blocked_by_reason.get(k, 0) + 1
        cal_err, cal_n = self.calibration_error()
        ct = self.get_counter("cycle_time_s")
        return Metrics(
            total_records=total,
            pct_model_ready=round(100.0 * ready / total, 1) if total else 0.0,
            blocked_by_reason=blocked_by_reason,
            queue_depths={
                "in_synthesis": int(self.get_counter("in_synthesis")),
                "selected": int(self.get_counter("selected")),
            },
            cycle_time_s=ct if ct else None,
            credit_spent_usd=round(credit_spent, 2),
            credit_cap_usd=round(credit_cap, 2),
            credit_remaining_usd=round(max(credit_cap - credit_spent, 0.0), 2),
            calibration_error=round(cal_err, 4) if cal_err is not None else None,
            calibration_n=cal_n,
        )


# Process-wide singleton.
_STORE: Optional[Store] = None


def get_store() -> Store:
    global _STORE
    if _STORE is None:
        _STORE = Store()
    return _STORE


def reset_store() -> None:
    global _STORE
    _STORE = Store()
