// Drives the key demo interaction end-to-end in a real browser:
// blocked IC50 -> fill [S]/Km -> turns green -> model-ready count on / rises.
const { chromium } = require("playwright");
const fs = require("fs");

const FE = "http://localhost:5173";
const BE = "http://localhost:8000";
const OUT = __dirname + "/shots";
fs.mkdirSync(OUT, { recursive: true });

const errs = [];

// Authoritative count from the API (the UI renders this exact value).
async function modelReadyCount() {
  const s = await (await fetch(`${BE}/loop/summary`)).json();
  return s.model_ready;
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });

  const before = await modelReadyCount();
  console.log("model-ready BEFORE:", before);
  // capture the overview showing the starting count
  await page.goto(FE + "/", { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/00_overview_before.png`, fullPage: true });

  // Re-snapshot the fixed acquisition view
  await page.goto(FE + "/acquisition", { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/05_acquisition_fixed.png`, fullPage: true });

  // Go to blocked records, open the blocked IC50, screenshot the panel
  await page.goto(FE + "/records?status=blocked", { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await page.locator("tr", { hasText: "enzymatic_IC50" }).first().click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/07_blocked_detail.png`, fullPage: true });

  // Fill [S] and Km, save
  await page.fill('input[placeholder="conditions.substrate_conc_M"]', "1e-5");
  await page.fill('input[placeholder="conditions.km_M"]', "2e-5");
  await page.getByRole("button", { name: /Save & re-ingest/i }).click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/08_after_fix.png`, fullPage: true });

  // Did the panel flip to model-ready? (Derived Ki should now appear.)
  const panelText = await page.locator(".panel").last().innerText();
  const flipped = /Derived Ki|model.ready/i.test(panelText);
  console.log("panel shows derived Ki / model-ready:", flipped);

  const after = await modelReadyCount();
  console.log("model-ready AFTER:", after);
  // capture the overview showing the incremented count
  await page.goto(FE + "/", { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/09_overview_after.png`, fullPage: true });

  const ok = before != null && after != null && after === before + 1 && flipped;
  console.log("\n=== INTERACTION", ok ? "PASS" : "CHECK", "===");
  console.log(JSON.stringify({ before, after, flipped, errs }, null, 2));

  await browser.close();
  process.exit(0);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
