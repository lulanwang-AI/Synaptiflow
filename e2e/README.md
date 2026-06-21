# e2e — headless-browser demo verification

Drives the running app in headless Chromium to prove every view renders and the
key interaction works, capturing screenshots and any runtime (console / page)
errors.

## Run
```bash
cd e2e && npm install && npx playwright install chromium
cd .. && bash e2e/run_demo.sh "snap interact"
```
`run_demo.sh` starts the backend (`BOLTZ_MOCK=1`, :8000) and frontend (:5173),
waits for readiness, resets to a clean seed, runs the requested scripts, and
tears everything down — all in one process so the servers and browser share the
network namespace.

## Scripts
- `snap.js` — screenshots all 5 views (`/`, `/records`, `/compound/:ik`,
  `/acquisition`, `/metrics`) and fails loudly on console/page errors or blank pages.
- `interact.js` — performs the demo "aha": opens the blocked IC50, fills `[S]`/`Km`,
  saves, and asserts the record leaves the blocked lane and the model-ready count
  rises (11 → 12). Captures before/after overview screenshots.

Output: `e2e/shots/*.png` and `e2e/shots/problems.json` (gitignored; regenerable).
