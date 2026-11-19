// Tests de régression V6 (correctifs du NO-GO Codex sur la V5 QA4) :
//   P1 — consentement révoqué PENDANT le chargement du moteur (await loadSdk) mais sdk.query() appelé ensuite : génération de consentement, revalidation après l'await
//        et juste avant sdk.query, concurrence, runs en attente. Tests en mémoire (createAgent) ET HTTP (/api/agent/*).
//   P2 — move_path d'un dossier ANCÊTRE de Vie (ou du dossier utilisateur, ou d'une zone protégée) : refus au plan ET à l'exécution, chemins normalisés, jonctions, liens, 8.3.
// Tout se passe dans un répertoire TEMPORAIRE créé et supprimé par ce test. Aucun vrai fichier de l'utilisateur, aucun réseau, aucun vrai moteur, aucune vraie clé, aucune action
// Windows réelle (hors création de jonctions dans le dossier temporaire).
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { createVieServer } = require('./vie-server.cjs');
const { createAgent } = require('./vie-agent.cjs');
const { createPolicy } = require('./vie-policy.cjs');
const { createTools } = require('./vie-tools.cjs');
const { login } = require('./test_vie_auth.cjs');
const { createFakeSdk } = require('./fake_agent_sdk.cjs');

const win = process.platform === 'win32';
const FAKE_KEY = 'FAKE-KEY-NOT-A-SECRET-V6-REGRESS-0123456789';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
let pass = 0, fail = 0; const failures = [];
async function t(name, fn) { try { await fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; failures.push(name); console.log('  KO  ' + name + '\n      ' + String(e && e.stack || e).split('\n').slice(0, 4).join('\n      ')); } }
async function waitFor(fn, ms = 4000) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('délai dépassé en attendant une condition'); await sleep(10); } }
const gate = () => { let release; const promise = new Promise(r => { release = r; }); return { promise, release }; };

// --- Arborescence temporaire : home/Desktop/<parent long>/Vie = « Vie » factice, avec un .env FACTICE ---------------------------------------------------------
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vie-v6-test-')));
const home = path.join(tmp, 'home');
const desktop = path.join(home, 'Desktop');
const parentLong = path.join(desktop, 'Studium Perso Longname');   // espaces + nom long : possède un nom court 8.3 distinct si NTFS 8.3 est actif
const vieRoot = path.join(parentLong, 'Vie');
const sibling = path.join(parentLong, 'Autre projet');             // frère de Vie : déplaçable
const mk = (p, c) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); return p; };
const ENV_CANARY = mk(path.join(vieRoot, '.env'), 'ANTHROPIC_API_KEY=FAKE-ENV-CANARY-NOT-A-SECRET\n');
mk(path.join(vieRoot, 'vie-agent.cjs'), '// faux code de Vie\n');
mk(path.join(sibling, 'note.txt'), 'frère de Vie\n');
mk(path.join(home, 'Documents', 'Cours', 'a.md'), 'cours\n');
mk(path.join(home, '.ssh', 'id_rsa'), 'FAKE-PRIVATE-KEY-BODY-NOT-REAL\n');
mk(path.join(home, 'AppData', 'Roaming', 'Microsoft', 'Credentials', 'x'), 'faux identifiant\n');
mk(path.join(home, 'AppData', 'Roaming', 'Autre', 'y.txt'), 'y\n');
mk(path.join(home, '.config', 'gh', 'hosts.yml'), 'faux\n');
const backups = path.join(tmp, 'backups'); const cfg = path.join(tmp, 'cfg'); fs.mkdirSync(backups, { recursive: true });
const snapshot = () => { const out = []; const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); out.push(path.relative(tmp, p) + (e.isSymbolicLink() ? ' -> lien' : e.isDirectory() ? '/' : ':' + sha(fs.readFileSync(p)))); if (e.isDirectory() && !e.isSymbolicLink()) walk(p); } }; walk(home); return out.sort().join('\n'); };
const before = snapshot();
const link = (target, lnk) => { try { fs.symlinkSync(target, lnk, win ? 'junction' : 'dir'); return true; } catch (e) { console.log('      (lien non créable ici : ' + e.code + ')'); return false; } };
const shortName = p => { if (!win) return null; try { const r = cp.spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', `for %I in ("${p}") do @echo %~sI`], { encoding: 'utf8', windowsHide: true }); const s = String(r.stdout || '').trim(); return s && s.toLowerCase() !== p.toLowerCase() ? s : null; } catch (e) { return null; } };

const pol = createPolicy({ home, cwd: home, vieRoot });
const mv = (from, to) => pol.plan('mcp__vie__move_path', { from, to });
const dest = n => path.join(home, 'Documents', n);

const level = { model: 'claude-haiku-5-5', effort: 'low', label: 'test' };
const chat = { share: false, messages: [{ role: 'user', content: 'analyse' }], view: 'today', today: '2026-11-17' };
const mkAgent = (sdkLoader, extra = {}) => createAgent({ sdkLoader, getKey: () => FAKE_KEY, home, cwd: home, vieRoot, backupRoot: backups, configDir: cfg, pdftotext: null, env: { PATH: process.env.PATH || '' }, ...extra });
const startOpts = (o = {}) => ({ sid: 's1', chat, level, maxUsd: 0.05, ctx: null, ...o });

(async () => {
  console.log('P2 — politique : déplacement d’un ancêtre de Vie');
  await t('témoins positifs : un frère de Vie, un dossier ordinaire et un fichier voisin restent déplaçables avec carte (la règle ne bloque pas tout)', () => {
    assert.equal(mv(sibling, dest('Autre2')).cls, 'write', 'dossier frère de Vie');
    assert.equal(mv(path.join(home, 'Documents', 'Cours'), dest('Cours2')).cls, 'write', 'dossier ordinaire');
    assert.equal(mv(path.join(sibling, 'note.txt'), dest('note2.txt')).cls, 'write', 'fichier voisin');
  });
  await t('REPRO P2 : chaque ancêtre de Vie (parent, grand-parent, Bureau, dossier utilisateur, dossier temporaire) est REFUSÉ, avec un motif lisible', () => {
    for (const anc of [parentLong, desktop, home, tmp]) {
      const p = mv(anc, path.join(path.dirname(anc), 'renomme-' + path.basename(anc)));
      assert.equal(p.cls, 'deny', 'ancêtre : ' + anc + ' → ' + JSON.stringify(p).slice(0, 200));
      assert.match(p.reason, /refusé/);
    }
    assert.match(mv(parentLong, dest('p')).reason, /contient le dossier de Vie/);
    assert.match(mv(home, path.join(tmp, 'home2')).reason, /dossier utilisateur|contient/);
  });
  await t('Vie lui-même et ce qu’il contient restent refusés (source ET destination)', () => {
    assert.equal(mv(vieRoot, dest('v')).cls, 'deny');
    assert.equal(mv(path.join(vieRoot, '.env'), dest('e')).cls, 'deny');
    assert.equal(mv(path.join(sibling, 'note.txt'), path.join(vieRoot, 'x.txt')).cls, 'deny');
    assert.equal(mv(sibling, path.join(vieRoot, 'dedans')).cls, 'deny');
  });
  await t('chemins normalisés : barre finale, double barre, « . », « .. », barres obliques, ~, chemin relatif, casse (Windows) — toutes les écritures de l’ancêtre sont refusées', () => {
    const v = new Set([
      parentLong + path.sep, parentLong + path.sep + path.sep, path.join(parentLong, '.'), path.join(parentLong, 'Vie', '..'), path.join(parentLong, 'Autre projet', '..'),
      path.join(desktop, 'Studium Perso Longname', '..', 'Studium Perso Longname'), parentLong.replace(/\\/g, '/'), parentLong.replace(/\\/g, '/') + '/', path.join(home, 'Desktop', '..', 'Desktop', 'Studium Perso Longname'),
      '~/Desktop/Studium Perso Longname', '~\\Desktop\\Studium Perso Longname', 'Desktop/Studium Perso Longname', 'Desktop\\Studium Perso Longname\\Vie\\..',
    ]);
    if (win) for (const x of [parentLong.toUpperCase(), parentLong.toLowerCase(), parentLong.replace(/Studium/, 'ＳＴＵＤＩＵＭ'), parentLong.replace(/Perso/, 'PERSO').replace(/Longname/, 'LONGNAME')]) v.add(x);
    let n = 0;
    for (const x of v) { n++; assert.equal(mv(x, dest('z' + n)).cls, 'deny', 'source : ' + x); assert.equal(mv(sibling, x).cls, 'deny', 'destination : ' + x); }
    assert.ok(n >= 13, 'variantes : ' + n);
  });
  await t('toutes les écritures sur un ancêtre sont refusées aussi (write_file / edit_file / delete_file) : pas de contournement par un autre outil', () => {
    for (const anc of [parentLong, desktop, home]) {
      assert.equal(pol.plan('mcp__vie__write_file', { path: anc, content: 'x', overwrite: true }).cls, 'deny', anc);
      assert.equal(pol.plan('mcp__vie__delete_file', { path: anc }).cls, 'deny', anc);
      assert.equal(pol.plan('mcp__vie__edit_file', { path: anc, old_string: 'a', new_string: 'b' }).cls, 'deny', anc);
    }
  });
  await t('nom court 8.3 de l’ancêtre (Windows) : refusé comme le nom long', () => {
    const s = shortName(parentLong);
    if (!s) { console.log('      (pas de nom 8.3 distinct sur ce volume : cas non applicable ici)'); return; }
    assert.equal(mv(s, dest('s83')).cls, 'deny', s);
    assert.equal(mv(parentLong.toUpperCase().replace(path.basename(parentLong).toUpperCase(), path.basename(s)), dest('s83b')).cls, 'deny');
  });
  await t('jonction / lien vers l’ancêtre, vers Vie, vers le Bureau ; chaîne de liens : déplacer le lien ou ce qu’il désigne est refusé ; une destination à l’intérieur de Vie via un lien est refusée', () => {
    const l1 = path.join(home, 'Documents', 'vers-parent'), l2 = path.join(home, 'Documents', 'vers-vie'), l3 = path.join(home, 'Documents', 'vers-bureau'), l4 = path.join(home, 'Documents', 'chaine');
    const made = [];
    try {
      for (const [tg, l] of [[parentLong, l1], [vieRoot, l2], [desktop, l3], [l1, l4]]) { if (!link(tg, l)) return; made.push(l); }
      for (const l of [l1, l2, l3, l4]) assert.equal(mv(l, dest('q')).cls, 'deny', 'source = lien ' + l);
      assert.equal(mv(sibling, path.join(l2, 'cible')).cls, 'deny', 'destination dans Vie via un lien');
      assert.equal(mv(path.join(l1, 'Vie'), dest('q2')).cls, 'deny'); assert.equal(mv(path.join(l3, 'Studium Perso Longname'), dest('q3')).cls, 'deny'); assert.equal(mv(path.join(l4, 'Vie', '.env'), dest('q4')).cls, 'deny');
      assert.equal(pol.plan('mcp__vie__write_file', { path: path.join(l1, 'Vie', 'nouveau.txt'), content: 'x' }).cls, 'deny', 'écriture via lien');
      // témoin : une destination qui, via un lien, tombe à côté de Vie (pas dedans) reste un déplacement ordinaire, et le plan montre le chemin RÉEL
      const ok = mv(sibling, path.join(l1, 'cible')); assert.equal(ok.cls, 'write'); assert.equal(ok.input.to, path.join(parentLong, 'cible'));
    } finally { for (const l of made.reverse()) { try { fs.rmdirSync(l); } catch (e) { /* lien déjà retiré */ } } }   // retire seulement les liens (jamais leur cible)
  });
  await t('lien déposé DANS un dossier ordinaire qui pointe vers Vie : déplacer le dossier ordinaire reste permis (il ne déplace que le lien) — mais le lien lui-même est refusé', () => {
    const d = path.join(home, 'Documents', 'contient-lien'); fs.mkdirSync(d, { recursive: true }); const l = path.join(d, 'raccourci');
    if (!link(vieRoot, l)) return;
    assert.equal(mv(l, dest('r')).cls, 'deny', 'le lien lui-même');
    assert.equal(mv(d, dest('contient-lien2')).cls, 'write', 'le dossier ne contient que le lien, pas Vie');
    fs.rmdirSync(l); fs.rmdirSync(d);
  });
  await t('zones protégées ANCRÉES dans le dossier utilisateur : AppData, AppData/Roaming, AppData/Roaming/Microsoft, .config sont des ancêtres refusés ; leurs voisins ordinaires restent déplaçables', () => {
    for (const rel of ['AppData', 'AppData/Roaming', 'AppData/Roaming/Microsoft', '.config', '.ssh']) assert.equal(mv(path.join(home, ...rel.split('/')), dest('m')).cls, 'deny', rel);
    assert.equal(mv(path.join(home, 'AppData', 'Roaming', 'Autre'), dest('autre-roaming')).cls, 'write', 'voisin ordinaire sous AppData');
  });

  console.log('P2 — exécution : le contrôle est refait au moment du déplacement');
  const tools = createTools({ policy: pol, backupRoot: backups, pdftotext: null });
  await t('REPRO P2 (outil) : un plan forgé ou périmé qui déplace un ancêtre est refusé à l’exécution ; rien ne bouge', () => {
    const target = path.join(tmp, 'deplace-parent');
    const r = tools.write.move_path({ input: { from: parentLong, to: target } }, 'run_x');
    assert.equal(r.isError, true); assert.match(r.text, /refusé|Rien déplacé/);
    assert.ok(fs.existsSync(ENV_CANARY) && !fs.existsSync(target));
    const r2 = tools.write.move_path({ input: { from: home, to: path.join(tmp, 'home-deplace') } }, 'run_x');
    assert.equal(r2.isError, true); assert.ok(fs.existsSync(ENV_CANARY) && !fs.existsSync(path.join(tmp, 'home-deplace')));
  });
  await t('outil : jonction repointée après la carte vers un ancêtre — refusée à l’exécution ; un déplacement ordinaire fonctionne encore (témoin)', () => {
    const l = path.join(home, 'Documents', 'jx');
    if (!link(parentLong, l)) return;
    const r = tools.write.move_path({ input: { from: l, to: path.join(tmp, 'jx-deplace') } }, 'run_x');
    assert.equal(r.isError, true); assert.ok(fs.existsSync(ENV_CANARY)); assert.ok(!fs.existsSync(path.join(tmp, 'jx-deplace')));
    fs.rmdirSync(l);
    const a = path.join(home, 'Documents', 'ordinaire-a'), b = path.join(home, 'Documents', 'ordinaire-b'); fs.mkdirSync(a);
    const ok = tools.write.move_path({ input: { from: a, to: b } }, 'run_x'); assert.equal(ok.isError, false, ok.text); assert.ok(fs.existsSync(b) && !fs.existsSync(a)); fs.rmdirSync(b);
  });

  console.log('P1 — agent en mémoire : consentement révoqué pendant le chargement du moteur');
  await t('témoin : consentement accordé, moteur chargé normalement -> sdk.query appelé une fois', async () => {
    const fake = createFakeSdk({ script: async () => 'ok' }); const a = mkAgent(fake.sdkLoader);
    a.setConsent(true, 1); const r = await a.start(startOpts());
    await waitFor(() => !a.isActive()); assert.equal(fake.calls.queries.length, 1); assert.ok(r.runId);
  });
  await t('REPRO P1 : révoqué PENDANT await loadSdk() -> start refusé (403), AUCUNE exécution créée, sdk.query jamais appelé', async () => {
    const fake = createFakeSdk({ script: async () => 'ok' }); const g = gate();
    const a = mkAgent(async () => { await g.promise; return fake.sdkLoader(); });
    a.setConsent(true, 1);
    const p = a.start(startOpts()); p.catch(() => {});
    await sleep(20); a.setConsent(false); g.release();
    await assert.rejects(p, e => e.status === 403 && e.code === 'agent_consent_required');
    await sleep(30);
    assert.equal(fake.calls.queries.length, 0, 'sdk.query ne doit JAMAIS être appelé'); assert.equal(a._runs.size, 0); assert.equal(a.isActive(), false);
    assert.deepEqual(a.consentState().given, false);
  });
  await t('A-B-A : révoqué puis ré-accordé pendant le chargement -> l’ancien démarrage reste refusé (l’autorisation d’origine n’existe plus)', async () => {
    const fake = createFakeSdk({ script: async () => 'ok' }); const g = gate();
    const a = mkAgent(async () => { await g.promise; return fake.sdkLoader(); });
    a.setConsent(true, 1); const p = a.start(startOpts()); p.catch(() => {});
    await sleep(20); a.setConsent(false); a.setConsent(true, 1); g.release();
    await assert.rejects(p, e => e.status === 403); await sleep(30);
    assert.equal(fake.calls.queries.length, 0); assert.equal(a._runs.size, 0);
  });
  await t('concurrence : un 2e démarrage pendant l’attente est refusé (429) ; après l’échec du 1er, le verrou est libéré et un nouveau démarrage fonctionne', async () => {
    const fake = createFakeSdk({ script: async () => 'ok' }); const g = gate(); let calls = 0;
    const a = mkAgent(async () => { if (++calls === 1) await g.promise; return fake.sdkLoader(); });
    a.setConsent(true, 1); const p1 = a.start(startOpts()); p1.catch(() => {});
    await sleep(20);
    await assert.rejects(a.start(startOpts({ sid: 's2' })), e => e.status === 429 && e.code === 'agent_busy');
    a.setConsent(false); g.release(); await assert.rejects(p1, e => e.status === 403);
    a.setConsent(true, 1); const r = await a.start(startOpts()); assert.ok(r.runId); await waitFor(() => !a.isActive());
    assert.equal(fake.calls.queries.length, 1, 'une seule requête : celle du démarrage valide');
  });
  await t('plusieurs démarrages simultanés et révocation : une seule requête au plus, et seulement si le consentement est resté valable', async () => {
    const fake = createFakeSdk({ script: async () => 'ok' }); const g = gate();
    const a = mkAgent(async () => { await g.promise; return fake.sdkLoader(); });
    a.setConsent(true, 1);
    const ps = [1, 2, 3].map(i => { const p = a.start(startOpts({ sid: 's' + i })); p.catch(() => {}); return p; });
    await sleep(20); g.release(); const res = await Promise.allSettled(ps);
    assert.equal(res.filter(x => x.status === 'fulfilled').length, 1); assert.equal(res.filter(x => x.status === 'rejected' && x.reason.status === 429).length, 2);
    await waitFor(() => !a.isActive()); assert.equal(fake.calls.queries.length, 1);
  });
  await t('REPRO P1 (run en attente) : consentement révoqué entre la création de l’exécution et sdk.query -> query jamais appelée, état « cancelled », coût 0', async () => {
    const fake = createFakeSdk({ script: async () => 'ok' }); let a; let settled = null;
    const sdk = { ...fake.sdk, createSdkMcpServer: o => { a.setConsent(false); return fake.sdk.createSdkMcpServer(o); } };   // la révocation tombe dans le dernier tour avant la requête
    a = mkAgent(async () => ({ sdk, z: (await fake.sdkLoader()).z }), { onSettle: s => { settled = s; } });
    a.setConsent(true, 1); const r = await a.start(startOpts({ ctx: { c: 1 } }));
    await waitFor(() => !a.isActive() && settled);
    assert.equal(fake.calls.queries.length, 0, 'sdk.query ne doit pas être appelé'); const run = a._runs.get(r.runId);
    assert.equal(run.state, 'cancelled'); assert.match(run.final.note, /révoqué/); assert.deepEqual(run.final.usage, { usd: 0, estimated: false }); assert.equal(settled.usd, 0); assert.equal(settled.estimated, false);
  });
  await t('annulation (cancel) entre la création de l’exécution et sdk.query : la requête ne part pas non plus, coût 0', async () => {
    const fake = createFakeSdk({ script: async () => 'ok' }); let a;
    const sdk = { ...fake.sdk, createSdkMcpServer: o => { a.cancel([...a._runs.keys()][0], 's1'); return fake.sdk.createSdkMcpServer(o); } };
    a = mkAgent(async () => ({ sdk, z: (await fake.sdkLoader()).z })); a.setConsent(true, 1);
    const r = await a.start(startOpts()); await waitFor(() => !a.isActive());
    assert.equal(fake.calls.queries.length, 0); const run = a._runs.get(r.runId); assert.equal(run.state, 'cancelled'); assert.deepEqual(run.final.usage, { usd: 0, estimated: false });
  });
  await t('consentement ré-accepté alors qu’il est déjà actif : une exécution en cours n’est PAS tuée (pas de fausse révocation)', async () => {
    const fake = createFakeSdk({ script: async api => { await sleep(120); return 'fini'; } }); const a = mkAgent(fake.sdkLoader);
    a.setConsent(true, 1); const r = await a.start(startOpts()); await sleep(30); const g0 = a.consentState().gen; a.setConsent(true, 1); assert.equal(a.consentState().gen, g0);
    await waitFor(() => !a.isActive()); assert.equal(a._runs.get(r.runId).state, 'done');
  });
  await t('révocation pendant une exécution en cours : interrompue (état conservé du comportement V5) ; un nouveau démarrage est refusé', async () => {
    const fake = createFakeSdk({ noResult: true, script: async api => { await api.use('mcp__vie__list_dir', { path: home }); await sleep(1500); await api.use('mcp__vie__list_dir', { path: home }); return ''; } });
    const a = mkAgent(fake.sdkLoader); a.setConsent(true, 1); const r = await a.start(startOpts()); await sleep(100); a.setConsent(false);
    await waitFor(() => !a.isActive()); assert.equal(a._runs.get(r.runId).state, 'cancelled');
    await assert.rejects(a.start(startOpts()), e => e.status === 403);
  });
  await t('close() pendant le chargement : démarrage refusé, plus aucun démarrage ensuite', async () => {
    const fake = createFakeSdk({ script: async () => 'ok' }); const g = gate();
    const a = mkAgent(async () => { await g.promise; return fake.sdkLoader(); }); a.setConsent(true, 1);
    const p = a.start(startOpts()); p.catch(() => {}); await sleep(20); await a.close(); g.release();
    await assert.rejects(p, e => e.status === 403); await sleep(30); assert.equal(fake.calls.queries.length, 0);
    await assert.rejects(a.start(startOpts()), e => e.status === 403 || e.status === 429);
  });
  await t('moteur manquant : toujours 503 et le verrou « starting » est libéré (pas de blocage définitif)', async () => {
    let n = 0; const fake = createFakeSdk({ script: async () => 'ok' });
    const a = mkAgent(async () => { if (++n === 1) throw new Error('Cannot find package'); return fake.sdkLoader(); }, { now: (() => { let c = 0; return () => (c += 10000); })() });
    a.setConsent(true, 1); await assert.rejects(a.start(startOpts()), e => e.status === 503 && e.code === 'sdk_missing');
    const r = await a.start(startOpts()); assert.ok(r.runId); await waitFor(() => !a.isActive());
  });

  console.log('P1 — HTTP : /api/agent/consent et /api/agent/run');
  async function boot(sdkLoader) {
    const srv = createVieServer({ env: { ANTHROPIC_API_KEY: FAKE_KEY }, envFile: path.join(tmp, 'absent.env'), fetch: () => { throw new Error('APPEL RÉSEAU INTERDIT DANS LES TESTS'); }, log: () => {}, root: vieRoot, agent: { sdkLoader, home, cwd: home, backupRoot: backups, configDir: cfg, pdftotext: null } });
    const port = await srv.listen(0); const sess = await login(srv);
    return { srv, port, sid: sess.cookie.split('=')[1], token: sess.token };
  }
  const call = (c, method, p, body) => new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const h = { host: `127.0.0.1:${c.port}`, cookie: `vie_sid_${c.port}=${c.sid}`, 'x-vie-token': c.token, 'sec-fetch-site': 'same-origin' };
    if (method === 'POST') { h.origin = `http://127.0.0.1:${c.port}`; h['content-type'] = 'application/json'; h['content-length'] = data.length; }
    const r = http.request({ host: '127.0.0.1', port: c.port, method, path: p, headers: h }, res => { const ch = []; res.on('data', x => ch.push(x)); res.on('end', () => { const text = Buffer.concat(ch).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch (e) { /* non JSON */ } resolve({ status: res.statusCode, json, text }); }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
  const chatBody = { mode: 'custom', model: 'default', effort: 'medium', share: false, messages: [{ role: 'user', content: 'analyse' }], view: 'today', today: '2026-11-17' };
  const waitDone = async (c, id) => waitFor(async () => { const j = (await call(c, 'GET', `/api/agent/events?run=${id}&since=0`)).json; return j.state !== 'running' ? j : null; });

  await t('REPRO P1 (HTTP) : révocation pendant le chargement du moteur -> 403 agent_consent_required, sdk.query jamais appelé, réserve de budget rendue', async () => {
    const fake = createFakeSdk({ script: async () => 'ok' }); const g = gate(); let loads = 0;
    const c = await boot(async () => { loads++; await g.promise; return fake.sdkLoader(); });
    c.srv.agent.setConsent(true, 1);   // en processus : l'état du moteur n'est pas lu (status() attendrait le chargement)
    const run = call(c, 'POST', '/api/agent/run', chatBody);
    await waitFor(() => loads >= 1);
    assert.ok(c.srv.budgetInfo().reservedUsd > 0, 'une réserve est posée pendant l’attente');
    const rev = call(c, 'POST', '/api/agent/consent', { accept: false });
    await waitFor(() => c.srv.agent.consentState().given === false);
    g.release();
    const [r, v] = await Promise.all([run, rev]);
    assert.equal(r.status, 403, r.text); assert.equal(r.json.error, 'agent_consent_required'); assert.equal(v.status, 200); assert.equal(v.json.consent.given, false);
    await sleep(30);
    assert.equal(fake.calls.queries.length, 0, 'sdk.query ne doit JAMAIS être appelé'); assert.equal(c.srv.budgetInfo().reservedUsd, 0, 'réserve rendue'); assert.equal(c.srv.budgetInfo().spentUsd, 0);
    assert.equal(c.srv.agent.isActive(), false); await c.srv.close();
  });
  await t('HTTP concurrence : 2e /run pendant l’attente = 429 agent_busy (réserve rendue) ; révocation ; puis re-consentement et exécution normale', async () => {
    const fake = createFakeSdk({ script: async () => 'résultat' }); const g = gate(); let loads = 0;
    const c = await boot(async () => { if (++loads === 1) await g.promise; return fake.sdkLoader(); });
    c.srv.agent.setConsent(true, 1);
    const first = call(c, 'POST', '/api/agent/run', chatBody); await waitFor(() => loads >= 1);
    const second = await call(c, 'POST', '/api/agent/run', chatBody); assert.equal(second.status, 429); assert.equal(second.json.error, 'agent_busy');
    c.srv.agent.setConsent(false); g.release(); assert.equal((await first).status, 403); await sleep(30);
    assert.equal(c.srv.budgetInfo().reservedUsd, 0); assert.equal(fake.calls.queries.length, 0);
    assert.equal((await call(c, 'POST', '/api/agent/consent', { accept: true, v: 1 })).status, 200);
    const ok = await call(c, 'POST', '/api/agent/run', chatBody); assert.equal(ok.status, 200, ok.text);
    const j = await waitDone(c, ok.json.runId); assert.equal(j.state, 'done'); assert.equal(fake.calls.queries.length, 1); await c.srv.close();
  });
  await t('HTTP : sans consentement initial, /run = 403 et aucune requête ; le consentement s’applique à la génération courante uniquement', async () => {
    const fake = createFakeSdk({ script: async () => 'ok' }); const c = await boot(fake.sdkLoader);
    const r = await call(c, 'POST', '/api/agent/run', chatBody); assert.equal(r.status, 403); assert.equal(r.json.error, 'agent_consent_required'); assert.equal(fake.calls.queries.length, 0); assert.equal(c.srv.budgetInfo().reservedUsd, 0); await c.srv.close();
  });

  console.log('P2 — HTTP : l’agent ne déplace jamais un ancêtre de Vie');
  await t('REPRO P2 (HTTP) : move_path du dossier parent de Vie, par l’agent -> aucune carte, refus, répertoire intact ; appel direct du gestionnaire (moteur défaillant) refusé aussi', async () => {
    const targetP = path.join(tmp, 'parent-deplace'), targetH = path.join(tmp, 'home-deplace');
    const fake = createFakeSdk({ script: async api => {
      const a = await api.use('mcp__vie__move_path', { from: parentLong, to: targetP });
      const b = await api.use('mcp__vie__move_path', { from: home, to: targetH });
      const d = await api.rawHandler('move_path', { from: parentLong, to: targetP });
      return `a:${a.allowed} b:${b.allowed} raw:${d.isError}`;
    } });
    const c = await boot(fake.sdkLoader); c.srv.agent.setConsent(true, 1);
    const r = await call(c, 'POST', '/api/agent/run', chatBody); assert.equal(r.status, 200, r.text);
    const j = await waitDone(c, r.json.runId);
    assert.equal(j.events.filter(e => e.type === 'approval').length, 0, 'aucune carte d’approbation : rien à valider');
    assert.match(j.events.find(e => e.type === 'done').reply, /a:false b:false raw:true/);
    assert.ok(j.events.filter(e => e.type === 'receipt' && e.result === 'refused').length >= 2);
    assert.ok(fs.existsSync(ENV_CANARY) && !fs.existsSync(targetP) && !fs.existsSync(targetH)); await c.srv.close();
  });

  console.log('Intégrité : aucune modification de l’arborescence de test, sauf ce que les témoins ont déplacé puis remis');
  await t('le .env factice, le code factice de Vie et toute l’arborescence (hors dossiers témoins) sont inchangés', () => {
    assert.equal(fs.readFileSync(ENV_CANARY, 'utf8'), 'ANTHROPIC_API_KEY=FAKE-ENV-CANARY-NOT-A-SECRET\n');
    assert.equal(snapshot(), before);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass + fail} tests, ${pass} OK, ${fail} KO${fail ? ' : ' + failures.join(' | ') : ''}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (x) { /* nettoyage au mieux */ } process.exit(1); });
