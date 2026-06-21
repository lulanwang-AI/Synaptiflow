// MSW request handlers generated from the openapi.json data shapes.
// Backed by the in-memory mock store in ./data.ts.

import { http, HttpResponse } from "msw";
import { API_BASE } from "../api/client";
import * as db from "./data";
import type { AssayRecordIn, RecordPatch, ReplayRequest } from "../api/types";

// Match both the configured base URL and same-origin relative paths,
// so the worker intercepts regardless of how the client is configured.
const bases = [API_BASE, ""];
const route = (path: string) => bases.map((b) => `${b}${path}`);

export const handlers = [
  ...route("/loop/summary").map((u) =>
    http.get(u, () => HttpResponse.json(db.loopSummary())),
  ),

  ...route("/loop/queue").map((u) =>
    http.get(u, () => HttpResponse.json(db.queueView())),
  ),

  ...route("/loop/replay").map((u) =>
    http.post(u, async ({ request }) => {
      let body: ReplayRequest = {};
      try {
        body = (await request.json()) as ReplayRequest;
      } catch {
        /* empty body allowed */
      }
      return HttpResponse.json(db.replay(body?.inchikeys ?? null));
    }),
  ),

  ...route("/records").map((u) =>
    http.get(u, ({ request }) => {
      const url = new URL(request.url);
      const status = url.searchParams.get("status") ?? undefined;
      return HttpResponse.json(db.listRecords(status));
    }),
  ),

  ...route("/records").map((u) =>
    http.post(u, async ({ request }) => {
      const body = (await request.json()) as AssayRecordIn;
      return HttpResponse.json({ record: db.postRecord(body) });
    }),
  ),

  ...route("/records/:recordId").map((u) =>
    http.get(u, ({ params }) => {
      const rec = db.getRecord(String(params.recordId));
      if (!rec) return new HttpResponse(null, { status: 404 });
      return HttpResponse.json(rec);
    }),
  ),

  ...route("/records/:recordId").map((u) =>
    http.patch(u, async ({ params, request }) => {
      const patch = (await request.json()) as RecordPatch;
      const rec = db.patchRecord(String(params.recordId), patch);
      if (!rec) return new HttpResponse(null, { status: 404 });
      return HttpResponse.json({ record: rec });
    }),
  ),

  ...route("/compound/:inchikey").map((u) =>
    http.get(u, ({ params }) => {
      const view = db.compoundView(String(params.inchikey));
      if (!view) return new HttpResponse(null, { status: 404 });
      return HttpResponse.json(view);
    }),
  ),

  ...route("/acquisition/batch").map((u) =>
    http.get(u, () => HttpResponse.json(db.acquisitionBatch())),
  ),

  ...route("/acquisition/approve").map((u) =>
    http.post(u, () => HttpResponse.json(db.approveBatch())),
  ),

  ...route("/metrics").map((u) =>
    http.get(u, () => HttpResponse.json(db.metrics())),
  ),

  ...route("/target").map((u) => http.get(u, () => HttpResponse.json(db.TARGET))),

  ...route("/reset").map((u) =>
    http.post(u, () => {
      const n = db.resetState();
      return HttpResponse.json({ ok: true, records: n });
    }),
  ),

  ...route("/health").map((u) =>
    http.get(u, () => HttpResponse.json({ ok: true })),
  ),
];
