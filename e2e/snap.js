// Drives the running app, screenshots every view, captures runtime errors.
const { chromium } = require("playwright");
const fs = require("fs");

const FE = "http://localhost:5173";
const BE = "http://localhost:8000";
const OUT = __dirname + "/shots";
fs.mkdirSync(OUT, { recursive: true });

const problems = [];

async function snap(page, path, name) {
  const errs = [];
  const onConsole = (m) => { if (m.type() === "error") errs.push("console: " + m.text()); };
  const onPageErr = (e) => errs.push("pageerror: " + e.message);
  page.on("console", onConsole);
  page.on("pageerror", onPageErr);
  await page.goto(FE + path, { waitUntil: "networkidle", timeout: 20000 });
  await page.waitForTimeout(1200); // let SMILES canvases + data settle
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  // crude crash detection: blank body or error boundary text
  const bodyText = (await page.locator("body").innerText().catch(() => "")) || "";
  if (bodyText.trim().length < 20) errs.push("blank/empty page (body text < 20 chars)");
  if (/something went wrong|error boundary|cannot read|undefined is not/i.test(bodyText))
    errs.push("error text on page: " + bodyText.slice(0, 200));
  page.off("console", onConsole);
  page.off("pageerror", onPageErr);
  if (errs.length) problems.push({ view: name, path, errs });
  console.log(`[snap] ${name.padEnd(18)} ${errs.length ? "ISSUES: " + errs.join(" | ") : "ok"}`);
}

(async () => {
  // grab a compound inchikey + a blocked IC50 record id from the API
  const recs = await (await fetch(`${BE}/records`)).json();
  const anyIk = recs.find((r) => r.compound.inchikey)?.compound.inchikey;
  const blockedIc50 = recs.find((r) => r.status === "blocked" && r.assay.readout === "IC50");
  console.log("compound inchikey:", anyIk, "| blocked IC50:", blockedIc50?.record_id);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  await snap(page, "/", "01_overview");
  await snap(page, "/records", "02_records");
  await snap(page, "/records?status=blocked", "03_records_blocked");
  if (anyIk) await snap(page, `/compound/${anyIk}`, "04_compound");
  await snap(page, "/acquisition", "05_acquisition");
  await snap(page, "/metrics", "06_metrics");

  await browser.close();

  fs.writeFileSync(`${OUT}/problems.json`, JSON.stringify(problems, null, 2));
  console.log("\n=== SUMMARY ===");
  console.log(problems.length ? JSON.stringify(problems, null, 2) : "All views rendered with no runtime errors.");
  process.exit(0);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
