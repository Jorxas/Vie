// Browserprüfung der gebauten Demo (node tools/demo-bauen.mjs vorher). Braucht puppeteer-core und einen installierten Chrome oder Edge (BROWSER_PFAD).
// Die Demo wird wie auf GitHub Pages unter /Vie/ ausgeliefert; externe Anfragen sind nicht erlaubt (nur /api/health des fehlenden Servers wird toleriert).
// Geprüft werden beide Sprachen: Deutsch ist der Standard, ?lang=fr (oder der Umschalter DE | FR) zeigt die französische Originalsprache.
// Optional: --bild=<datei.png> schreibt eine Aufnahme der deutschen Übersicht.
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
// Sprachen: Navigationsnamen, Beispieltexte und was nicht zu sehen sein darf (französische Reste in der deutschen Fassung, deutsche Reste in der französischen).
const FRANZOESISCH = /[éèêëàâçùûôîï]|\b(le|la|les|une|pour|dans|sur|avec|ton|tes|mon|mes|est|pas|aucun|aucune|cette|ces|qui|que|ajouter|modifier|supprimer|semaine)\b/i;
const DEUTSCH = /[äöüß]|\b(und|der|die|das|nicht|für|mit|von|nur|wird|werden)\b/;
const sprachen = {
  de: { html: "de", aufgabe: "Lernlabor: Registrierungsablauf testen", hinweis: "Demo mit erfundenen Daten", nav: ["Meine Woche", "Bewerbungen", "Leben & Gewohnheiten", "Finanzen"], bewerbung: "Nordlicht Software", reste: FRANZOESISCH },
  fr: { html: "fr", aufgabe: "Lernlabor : tester le parcours d’inscription", hinweis: "Démo avec des données fictives", nav: ["Ma semaine", "Candidatures", "Vie & habitudes", "Finances"], bewerbung: "Nordlicht Software", reste: DEUTSCH }
};
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
    const text = () => s.$eval("body", e => e.innerText);
    const navKlick = n => s.evaluate(n => [...document.querySelectorAll("#nav a, #nav button")].find(e => e.textContent.includes(n))?.click(), n);
    const pruefe = async (kuerzel, bildDatei) => {
      const L = sprachen[kuerzel];
      await s.waitForSelector("#nav a, #nav button");
      assert.equal(await s.evaluate(() => document.documentElement.lang), L.html, `lang-Attribut ${kuerzel}`);
      assert((await text()).includes(L.aufgabe), `Beispielaufgabe sichtbar (${kuerzel})`);
      assert((await text()).includes(L.hinweis), `Hinweis auf erfundene Daten (${kuerzel})`);
      assert.equal(await s.$eval('[data-sprachwahl] [aria-current]', e => e.textContent), kuerzel.toUpperCase(), "aktive Sprache im Umschalter");
      if (bildDatei) await s.screenshot({ path: path.resolve(bildDatei) });
      // Aufgabe abhaken: der Zähler der erledigten Aufgaben steigt
      const vorher = await s.$eval(".stats, main", e => e.innerText);
      await s.evaluate(() => document.querySelector(".task input[type=checkbox], input[type=checkbox]")?.click());
      await warte(300);
      assert.notEqual(await s.$eval(".stats, main", e => e.innerText), vorher, "Abhaken verändert die Übersicht");
      // Alle Ansichten durchgehen, auf Reste der jeweils anderen Sprache prüfen
      const namen = await s.$$eval("#nav a, #nav button", els => els.map(e => e.textContent.trim()));
      assert(namen.length >= 8, "Navigation vollständig");
      for (const n of L.nav) assert(namen.some(x => x.includes(n)), `Navigationspunkt „${n}“ (${kuerzel})`);
      for (let i = 0; i < namen.length; i++) {
        await s.evaluate(i => document.querySelectorAll("#nav a, #nav button")[i]?.click(), i);
        await warte(200);
        const t = await text();
        const treffer = t.split("\n").map(z => z.trim()).filter(z => z && L.reste.test(z));
        assert.deepEqual(treffer, [], `Sprachreste in der Ansicht „${namen[i]}“ (${kuerzel})`);
      }
      await navKlick(L.nav[1]);
      await warte(250);
      assert((await text()).includes(L.bewerbung), `Bewerbungen sichtbar (${kuerzel})`);
      // Handy: kein horizontaler Überlauf
      await s.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
      await warte(300);
      assert(!(await s.evaluate(() => document.documentElement.scrollWidth > innerWidth)), `kein horizontaler Überlauf auf dem Handy (${kuerzel})`);
      await s.setViewport({ width: 1400, height: 1000 });
    };
    // 1) Standard ohne Parameter: Deutsch
    await s.goto(basis, { waitUntil: "networkidle0" });
    await pruefe("de", bild);
    // 2) Umschalter auf Französisch (Klick auf FR im Hinweis)
    await Promise.all([s.waitForNavigation({ waitUntil: "networkidle0" }), s.click('[data-sprachwahl] a[lang="fr"]')]);
    assert(new URL(s.url()).searchParams.get("lang") === "fr", "FR-Link setzt ?lang=fr");
    await pruefe("fr");
    // 3) Zurück auf Deutsch
    await Promise.all([s.waitForNavigation({ waitUntil: "networkidle0" }), s.click('[data-sprachwahl] a[lang="de"]')]);
    await pruefe("de");
    // 4) Direktaufruf mit ?lang=fr
    await s.goto(basis + "?lang=fr", { waitUntil: "networkidle0" });
    await pruefe("fr");
  } finally { await browser.close(); server.close(); }
  assert.deepEqual(fehler, [], "keine Laufzeitfehler");
  assert.deepEqual(extern, [], "keine externen Anfragen");
  console.log("Browserprüfung der Vie-Demo bestanden: Deutsch (Standard), Wechsel auf Französisch und zurück, ?lang=fr; Übersicht, Aufgabe abhaken, alle Ansichten ohne Sprachreste, Bewerbungen, Handy; keine Fehler, keine externen Anfragen.");
})().catch(e => { console.error(e); process.exitCode = 1; server.close(); });
