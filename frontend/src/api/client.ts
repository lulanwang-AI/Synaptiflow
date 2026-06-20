// Typed API client for the Closed-Loop Discovery MVP backend.
// Base URL is configurable via VITE_API_BASE (default http://localhost:8000).
// When MSW is active (see src/mocks), these same fetch calls are intercepted
// transparently so the UI is fully clickable with no backend.

import type {
  AcquisitionBatch,
  AssayRecord,
  AssayRecordIn,
  CompoundView,
  IngestResponse,
  LoopSummary,
  Metrics,
  RecordPatch,
  ReplayRequest,
  ReplayResponse,
  ResetResponse,
  Target,
} from "./types";

export const API_BASE: string =
  (import.meta.env.VITE_API_BASE as string | undefined) ??
  "http://localhost:8000";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${API_BASE}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    // Network failure (backend down and no mock intercepting).
    throw new ApiError(
      `Network error reaching ${url}. Is the backend running? ` +
        `(set VITE_USE_MOCK=1 to use the mock backend)`,
      0,
    );
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      /* ignore */
    }
    throw new ApiError(`${res.status} ${res.statusText} ${detail}`, res.status);
  }
  // /reset and others always return JSON in this API.
  return (await res.json()) as T;
}

export const api = {
  loopSummary: () => request<LoopSummary>("/loop/summary"),

  listRecords: (status?: string) =>
    request<AssayRecord[]>(
      `/records${status ? `?status=${encodeURIComponent(status)}` : ""}`,
    ),

  getRecord: (recordId: string) =>
    request<AssayRecord>(`/records/${encodeURIComponent(recordId)}`),

  postRecord: (body: AssayRecordIn) =>
    request<IngestResponse>("/records", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  patchRecord: (recordId: string, body: RecordPatch) =>
    request<IngestResponse>(`/records/${encodeURIComponent(recordId)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  getCompound: (inchikey: string) =>
    request<CompoundView>(`/compound/${encodeURIComponent(inchikey)}`),

  acquisitionBatch: () => request<AcquisitionBatch>("/acquisition/batch"),

  acquisitionApprove: () =>
    request<LoopSummary>("/acquisition/approve", { method: "POST" }),

  loopReplay: (body?: ReplayRequest) =>
    request<ReplayResponse>("/loop/replay", {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    }),

  metrics: () => request<Metrics>("/metrics"),

  target: () => request<Target>("/target"),

  reset: () => request<ResetResponse>("/reset", { method: "POST" }),
};

export type Api = typeof api;
