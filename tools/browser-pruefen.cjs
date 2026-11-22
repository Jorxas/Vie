// Browserprüfung der gebauten Demo (node tools/demo-bauen.mjs vorher). Braucht puppeteer-core und einen installierten Chrome oder Edge (BROWSER_PFAD).
// Die Demo wird wie auf GitHub Pages unter /Vie/ ausgeliefert; externe Anfragen sind nicht erlaubt (nur /api/health des fehlenden Servers wird toleriert).
// Optional: --bild=<datei.png> schreibt eine Aufnahme der Übersicht.
const fs = require("node:fs"), path = require("node:path"), http = require("node:http"), assert = require("node:assert/strict");
const puppeteer = require("puppeteer-core");
const dist = path.resolve(__dirname, "../dist");
const bild = process.argv.find(a => a.startsWith("--bild="))?.slice(7);
const typen = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const server = http.createServer((q, r) => {
  let p = decodeURIComponent(new URL(q.url, "http://x").pathname).replace(/^\/Vie/, "") || "/";
  if (p.endsWith("/")) p += "index.html";
  const f = path.join(dist, p);
  if (!f.startsWith(dist) || !fs.existsSync(f)) { r.statusCode = 404; return r.end("nicht gefunden"); }
  r.setHeader("Content-Type", typen[path.extname(f)] || "application/octet-stream");
  r.end(fs.readFileSync(f));
});
const browserPfad = process.env.BROWSER_PFAD || ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(f => fs.existsSync(f));
if (!browserPfad) throw new Error("BROWSER_PFAD auf einen installierten Chrome oder Edge setzen.");
const warte = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const basis = `http://127.0.0.1:${server.address().port}/Vie/`;
  const browser = await puppeteer.launch({ executablePath: browserPfad, headless: true });
  const fehler = [], extern = [];
  try {
    const s = await browser.newPage();
    s.on("pageerror", e => fehler.push("Seitenfehler: " + e.message));
    s.on("request", r => { if (new URL(r.url()).hostname !== "127.0.0.1") extern.push(r.url()); });
    await s.setViewport({ width: 1400, height: 1000 });
    await s.goto(basis, { waitUntil: "networkidle0" });
    await s.waitForSelector("#nav a, #nav button");
    const text = () => s.$eval("body", e => e.innerText);
    assert((await text()).includes("Lernlabor : tester le parcours"), "Beispielaufgaben sichtbar");
    assert((await text()).includes("Demo mit erfundenen Daten"), "Hinweis auf erfundene Daten");
    if (bild) await s.screenshot({ path: path.resolve(bild) });
    // Aufgabe abhaken: der Zähler der erledigten Aufgaben steigt
    const vorher = await s.$eval(".stats, main", e => e.innerText);
    await s.evaluate(() => document.querySelector(".task input[type=checkbox], input[type=checkbox]")?.click());
    await warte(300);
    assert.notEqual(await s.$eval(".stats, main", e => e.innerText), vorher, "Abhaken verändert die Übersicht");
    // Ansichten
    for (const name of ["Ma semaine", "Candidatures", "Vie & habitudes", "Finances"]) {
      await s.evaluate(n => [...document.querySelectorAll("#nav a, #nav button")].find(e => e.textContent.includes(n))?.click(), name);
      await warte(250);
    }
    await s.evaluate(() => [...document.querySelectorAll("#nav a, #nav button")].find(e => e.textContent.includes("Candidatures"))?.click());
    await warte(250);
    assert((await text()).includes("Nordlicht Software"), "Bewerbungen sichtbar");
    // Handy
    await s.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
    await warte(300);
    assert(!(await s.evaluate(() => document.documentElement.scrollWidth > innerWidth)), "kein horizontaler Überlauf auf dem Handy");
  } finally { await browser.close(); server.close(); }
  assert.deepEqual(fehler, [], "keine Laufzeitfehler");
  assert.deepEqual(extern, [], "keine externen Anfragen");
  console.log("Browserprüfung der Vie-Demo bestanden: Übersicht, Aufgabe abhaken, Wochenansicht, Bewerbungen, Handy; keine Fehler, keine externen Anfragen.");
})().catch(e => { console.error(e); process.exitCode = 1; server.close(); });
