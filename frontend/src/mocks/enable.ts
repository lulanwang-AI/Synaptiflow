// Decides whether the MSW mock backend should be active, and starts it.
//
// Mock is enabled when ANY of:
//   - VITE_USE_MOCK=1 at build/dev time, OR
//   - localStorage "useMock" === "1" (runtime toggle in the nav bar), OR
//   - the live backend health check fails (auto-fallback so the UI is never
//     a dead page when the backend is down).

import { API_BASE } from "../api/client";

const LS_KEY = "useMock";

export function mockForced(): boolean {
  return (import.meta.env.VITE_USE_MOCK as string | undefined) === "1";
}

export function mockToggledOn(): boolean {
  try {
    return localStorage.getItem(LS_KEY) === "1";
  } catch {
    return false;
  }
}

export function setMockToggle(on: boolean) {
  try {
    if (on) localStorage.setItem(LS_KEY, "1");
    else localStorage.removeItem(LS_KEY);
  } catch {
    /* ignore */
  }
}

async function backendAlive(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`${API_BASE}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

let started = false;

// Returns true if the mock backend is active for this session.
export async function maybeStartMock(): Promise<boolean> {
  if (started) return true;

  let shouldMock = mockForced() || mockToggledOn();

  if (!shouldMock) {
    // auto-fallback when the real backend is unreachable
    const alive = await backendAlive();
    if (!alive) {
      shouldMock = true;
      console.warn(
        "[mock] backend not reachable at " +
          API_BASE +
          " — falling back to MSW mock backend.",
      );
    }
  }

  if (shouldMock) {
    const { worker } = await import("./browser");
    await worker.start({
      onUnhandledRequest: "bypass",
      quiet: true,
    });
    started = true;
    return true;
  }
  return false;
}

export function isMockActive(): boolean {
  return started;
}
