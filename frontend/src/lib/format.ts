// Small formatting helpers for affinity values and labels.

export function fmtMolar(v: number | null | undefined): string {
  if (v == null) return "—";
  // pick a friendly unit
  const abs = Math.abs(v);
  if (abs === 0) return "0 M";
  if (abs >= 1e-3) return `${(v * 1e3).toPrecision(3)} mM`;
  if (abs >= 1e-6) return `${(v * 1e6).toPrecision(3)} µM`;
  if (abs >= 1e-9) return `${(v * 1e9).toPrecision(3)} nM`;
  return `${(v * 1e12).toPrecision(3)} pM`;
}

export function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v == null) return "—";
  return v.toFixed(digits);
}

export function fmtUsd(v: number | null | undefined): string {
  if (v == null) return "—";
  return `$${v.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export const STATUS_LABEL: Record<string, string> = {
  model_ready: "model-ready",
  normalizable: "normalizable",
  blocked: "blocked",
};

export function rawValueLabel(
  value: number | null | undefined,
  unit: string | null | undefined,
): string {
  if (value == null) return "—";
  return `${value.toExponential(2)}${unit ? ` ${unit}` : ""}`;
}
