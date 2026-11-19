// Tests de régression V7 (correctifs du NO-GO Codex m_2b19be311c78efff7b97e0dfea7d5d8c sur la V6) :
//   P1 #1 — le limiteur de débit renvoyait 429 à « Révoquer » et « Annuler » : l'utilisateur ne pouvait plus arrêter un agent actif. Maintenant ces deux actions (et elles seules)
//           ne dépendent plus du quota ordinaire, mais gardent Host + Origin + Sec-Fetch-Site + cookie + jeton CSRF + Content-Type ; l'interface affiche tout échec.
//   P1 #2 — canUseTool reprenait après l'approbation et renvoyait « allow » (donc le SDK pouvait exécuter la commande) alors que le consentement avait été révoqué entre le clic et la reprise.
//   P2    — move_path d'un dossier ORDINAIRE qui contient un descendant protégé (.git, .env, .ssh, clés…) : refus explicite, inspection bornée, refus si l'inspection est incomplète
//           (profondeur, nombre d'entrées, erreur de lecture, lien cassé), contrôle refait à l'exécution (TOCTOU, jonctions).
//   P3    — la carte d'approbation ne dit plus « exécutée » avant qu'un reçu le prouve.
// Tout se passe dans un répertoire TEMPORAIRE créé et supprimé par ce test : données synthétiques, aucun vrai fichier de l'utilisateur, aucun .env réel, aucun réseau Internet (sockets 127.0.0.1
// uniquement), aucun vrai moteur (faux SDK), aucune vraie clé, aucune commande Windows réelle (la « commande » est exécutée par un simulateur).
// Les tests marqués REPRO échouent sur les fichiers V6 (voir VIE_ASSISTANT.md §19).
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createVieServer } = require('./vie-server.cjs');
const { createAgent } = require('./vie-agent.cjs');
const { createPolicy } = require('./vie-policy.cjs');
const { createTools } = require('./vie-tools.cjs');
const { login } = require('./test_vie_auth.cjs');
const { createFakeSdk } = require('./fake_agent_sdk.cjs');

const win = process.platform === 'win32';
const FAKE_KEY = 'FAKE-KEY-NOT-A-SECRET-V7-REGRESS-0123456789';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
let pass = 0, fail = 0; const failures = [];
async function t(name, fn) { try { await fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; failures.push(name); console.log('  KO  ' + name + '\n      ' + String(e && e.stack || e).split('\n').slice(0, 4).join('\n      ')); } }
async function waitFor(fn, ms = 4000) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('délai dépassé en attendant une condition'); await sleep(10); } }
const gate = () => { let release; const promise = new Promise(r => { release = r; }); return { promise, release }; };

// --- Arborescence temporaire synthétique -------------------------------------------------------------------------------------------------------------------------
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vie-v7-test-')));
const home = path.join(tmp, 'home');
const vieRoot = path.join(home, 'Desktop', 'Vie');
const docs = path.join(home, 'Documents');
const mk = (p, c = 'x\n') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); return p; };
const mkd = p => { fs.mkdirSync(p, { recursive: true }); return p; };
mk(path.join(vieRoot, '.env'), 'ANTHROPIC_API_KEY=FAKE-ENV-CANARY-NOT-A-SECRET\n'); mk(path.join(vieRoot, 'vie-agent.cjs'), '// faux code\n');
mk(path.join(docs, 'Cours', 'algo.md'), 'cours synthétique\n');
mk(path.join(home, '.ssh', 'id_rsa'), 'FAKE-PRIVATE-KEY-BODY-NOT-REAL\n');
const backups = mkd(path.join(tmp, 'backups')); const cfg = path.join(tmp, 'cfg');
const link = (target, lnk) => { try { fs.symlinkSync(target, lnk, win ? 'junction' : 'dir'); return true; } catch (e) { console.log('      (lien non créable ici : ' + e.code + ')'); return false; } };
const unlink = l => { try { fs.rmdirSync(l); } catch (e) { /* déjà retiré (jamais récursif : la cible ne doit pas être touchée) */ } };
const pol = createPolicy({ home, cwd: home, vieRoot });
const mv = (from, to, p = pol) => p.plan('mcp__vie__move_path', { from, to });
let seq = 0; const dest = n => path.join(docs, 'dest-' + n + '-' + (++seq));
const level = { model: 'claude-haiku-5-5', effort: 'low', label: 'test' };
const chat = { share: false, messages: [{ role: 'user', content: 'analyse' }], view: 'today', today: '2026-11-18' };
const mkAgent = (sdkLoader, extra = {}) => createAgent({ sdkLoader, getKey: () => FAKE_KEY, home, cwd: home, vieRoot, backupRoot: backups, configDir: cfg, pdftotext: null, env: { PATH: process.env.PATH || '' }, ...extra });
const startOpts = (o = {}) => ({ sid: 's1', chat, level, maxUsd: 0.05, ctx: null, ...o });
const CMD = 'Write-Output SYNTHETIC_ONLY';

// Lit la carte d'approbation en attente d'une exécution (identifiants nécessaires à la décision) et la décide, comme le ferait le serveur HTTP.
async function pendingApproval(a, runId, sid = 's1') { return waitFor(() => { const ev = a.events(runId, sid, 0).events.filter(e => e.type === 'approval'); return ev.length ? ev[ev.length - 1] : null; }); }
const decideOk = (a, runId, ap, sid = 's1') => a.decide({ runId, sid, id: ap.id, nonce: ap.nonce, hash: ap.hash, allow: true });
const recs = (a, runId, sid = 's1') => a.events(runId, sid, 0).events;

(async () => {
  // ==============================================================================================================================================================
  console.log('P1 #2 — agent en mémoire : révocation entre le clic APPROUVER et la reprise de canUseTool');
  async function shellScenario(act) {
    const shellMock = []; const fake = createFakeSdk({ shell: c => { shellMock.push(c); return { out: 'ok' }; }, script: async api => { const r = await api.use('PowerShell', { command: CMD }); return 'allowed:' + r.allowed; } });
    const a = mkAgent(fake.sdkLoader); a.setConsent(true, 1);
    const r = await a.start(startOpts()); const ap = await pendingApproval(a, r.runId);
    const dec = decideOk(a, r.runId, ap); assert.equal(dec.ok, true, JSON.stringify(dec));
    if (act) act(a, r.runId);   // SYNCHRONE : aucun tour de boucle d'événements entre la décision et l'action, donc canUseTool n'a pas encore repris
    await waitFor(() => !a.isActive());
    return { a, fake, shellMock, runId: r.runId, run: a._runs.get(r.runId), events: recs(a, r.runId) };
  }
  await t('témoin : APPROUVER sans révocation -> la commande simulée est exécutée une seule fois (le correctif ne bloque pas tout)', async () => {
    const x = await shellScenario(null);
    assert.deepEqual(x.shellMock, [CMD]); assert.equal(x.run.state, 'done'); assert.deepEqual(x.fake.calls.canUse.map(c => c.behavior), ['allow']);
    assert.ok(x.events.some(e => e.type === 'receipt' && e.result === 'done'), 'reçu de succès');
  });
  await t('REPRO P1 #2 : APPROUVER puis RÉVOQUER avant la reprise -> canUseTool renvoie deny, la commande simulée n’est JAMAIS exécutée', async () => {
    const x = await shellScenario(a => a.setConsent(false));
    assert.deepEqual(x.shellMock, [], 'shellMock ne doit jamais être appelé après une révocation');
    assert.deepEqual(x.fake.calls.canUse.map(c => c.behavior), ['deny'], 'comportement renvoyé au moteur');
    assert.equal(x.run.state, 'cancelled'); assert.equal(x.run.ac.signal.aborted, true);
    assert.equal(x.events.filter(e => e.type === 'receipt' && e.result === 'done').length, 0, 'aucun reçu de succès');
    assert.equal(x.events.filter(e => e.type === 'receipt' && e.result === 'unconfirmed').length, 0, 'aucune commande « approuvée mais non confirmée » : elle n’a jamais été autorisée');
    assert.equal(x.run.shellPending.size, 0, 'rien n’est enregistré comme commande autorisée');
  });
  await t('REPRO P1 #2 : APPROUVER puis ANNULER (cancel) avant la reprise -> deny, aucune exécution', async () => {
    const x = await shellScenario((a, id) => a.cancel(id, 's1'));
    assert.deepEqual(x.shellMock, []); assert.deepEqual(x.fake.calls.canUse.map(c => c.behavior), ['deny']); assert.equal(x.run.state, 'cancelled');
  });
  await t('REPRO P1 #2 (A-B-A) : APPROUVER, révoquer puis ré-accorder avant la reprise -> deny (l’autorisation d’origine n’existe plus), aucune exécution', async () => {
    const x = await shellScenario(a => { a.setConsent(false); a.setConsent(true, 1); });
    assert.deepEqual(x.shellMock, []); assert.deepEqual(x.fake.calls.canUse.map(c => c.behavior), ['deny']);
  });
  await t('fermeture du serveur (close) entre APPROUVER et la reprise : deny, aucune exécution', async () => {
    const x = await shellScenario(a => { a.close(); });
    assert.deepEqual(x.shellMock, []); assert.deepEqual(x.fake.calls.canUse.map(c => c.behavior), ['deny']);
  });
  await t('écriture de fichier : APPROUVER puis RÉVOQUER -> aucun fichier, aucun gestionnaire appelé, deny dès canUseTool (plus de grant inutilisé)', async () => {
    const target = path.join(docs, 'revoque.md'); const fake = createFakeSdk({ script: async api => { const r = await api.use('mcp__vie__write_file', { path: target, content: 'x\n' }); return 'allowed:' + r.allowed; } });
    const a = mkAgent(fake.sdkLoader); a.setConsent(true, 1); const r = await a.start(startOpts()); const ap = await pendingApproval(a, r.runId);
    decideOk(a, r.runId, ap); a.setConsent(false); await waitFor(() => !a.isActive());
    assert.equal(fs.existsSync(target), false); assert.deepEqual(fake.calls.handlerCalls, []); assert.deepEqual(fake.calls.canUse.map(c => c.behavior), ['deny']);
    assert.equal(a._runs.get(r.runId).grants.size, 0, 'aucun droit d’exécution conservé');
  });

  // ==============================================================================================================================================================
  console.log('P1 #1 — HTTP : « Révoquer » et « Annuler » ne sont plus bloquées par le quota ordinaire (sockets 127.0.0.1)');
  async function boot(sdkLoader, extra = {}) {
    const srv = createVieServer({ env: { ANTHROPIC_API_KEY: FAKE_KEY }, envFile: path.join(tmp, 'absent.env'), fetch: () => { throw new Error('APPEL RÉSEAU INTERDIT DANS LES TESTS'); }, log: () => {}, root: vieRoot, agent: { sdkLoader, home, cwd: home, backupRoot: backups, configDir: cfg, pdftotext: null }, ...extra });
    const port = await srv.listen(0); const sess = await login(srv);
    return { srv, port, sid: sess.cookie.split('=')[1], token: sess.token, sess };
  }
  // Requête brute : tous les en-têtes sont modifiables (sans cookie, mauvais jeton, mauvaise origine, etc.).
  const raw = (c, method, p, body, over = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const h = { host: `127.0.0.1:${c.port}`, cookie: `vie_sid_${c.port}=${c.sid}`, 'x-vie-token': c.token, 'sec-fetch-site': 'same-origin' };
    if (method === 'POST') { h.origin = `http://127.0.0.1:${c.port}`; h['content-type'] = 'application/json'; if (data) h['content-length'] = data.length; }
    for (const [k, v] of Object.entries(over)) { if (v === null) delete h[k]; else h[k] = v; }
    const r = http.request({ host: '127.0.0.1', port: c.port, method, path: p, agent: false, headers: h }, res => { const ch = []; res.on('data', x => ch.push(x)); res.on('end', () => { const text = Buffer.concat(ch).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch (e) { /* non JSON */ } resolve({ status: res.statusCode, json, text }); }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
  const chatBody = { mode: 'custom', model: 'default', effort: 'medium', share: false, messages: [{ role: 'user', content: 'analyse' }], view: 'today', today: '2026-11-18' };
  // Épuise le quota ordinaire (20 requêtes POST / minute) avec une requête ordinaire authentifiée ; renvoie le nombre de requêtes acceptées.
  async function exhaust(c) { let n = 0; for (;;) { const r = await raw(c, 'POST', '/api/agent/scope/clear', {}); if (r.status === 429) return n; assert.equal(r.status, 200, r.text); if (++n > 60) throw new Error('quota jamais atteint'); } }
  // Un run « bloqué » : le faux moteur attend une porte, ce qui permet de révoquer / annuler pendant qu'il est actif.
  async function bootRunning() {
    const g = gate(); const fake = createFakeSdk({ noResult: true, script: async api => { await api.use('mcp__vie__list_dir', { path: home }); await g.promise; return ''; } });
    const c = await boot(fake.sdkLoader); c.srv.agent.setConsent(true, 1);
    const r = await raw(c, 'POST', '/api/agent/run', chatBody); assert.equal(r.status, 200, r.text);
    c.runId = r.json.runId; c.gate = g; c.fake = fake; c.run = () => c.srv.agent._runs.get(c.runId); return c;
  }
  const stateOf = async c => (await raw(c, 'GET', `/api/agent/events?run=${c.runId}&since=0`)).json.state;

  await t('témoin : le quota ordinaire existe toujours (21e requête ordinaire = 429 rate_limited) et ne s’applique pas aux lectures de suivi', async () => {
    const c = await boot(createFakeSdk({}).sdkLoader);
    const n = await exhaust(c); assert.ok(n >= 15 && n <= 20, 'requêtes acceptées : ' + n);
    const r = await raw(c, 'POST', '/api/agent/scope/clear', {}); assert.equal(r.status, 429); assert.equal(r.json.error, 'rate_limited');
    assert.equal((await raw(c, 'GET', '/api/agent/status')).status, 200); await c.srv.close();
  });
  await t('REPRO P1 #1 : quota épuisé -> « Révoquer » répond 200, le consentement tombe, l’exécution est interrompue (signal d’arrêt levé)', async () => {
    const c = await bootRunning(); await exhaust(c);
    assert.equal(c.srv.agent.consentState().given, true); assert.equal(c.run().state, 'running');
    const r = await raw(c, 'POST', '/api/agent/consent', { accept: false });
    assert.equal(r.status, 200, 'révocation bloquée par le quota : ' + r.text); assert.equal(r.json.consent.given, false);
    assert.equal(c.srv.agent.consentState().given, false); assert.equal(c.run().ac.signal.aborted, true);
    await waitFor(async () => (await stateOf(c)) !== 'running'); assert.equal(await stateOf(c), 'cancelled'); c.gate.release(); await c.srv.close();
  });
  await t('REPRO P1 #1 : quota épuisé -> « Annuler » répond 200, l’exécution passe à « cancelled » et le signal d’arrêt est levé', async () => {
    const c = await bootRunning(); await exhaust(c);
    const r = await raw(c, 'POST', '/api/agent/cancel', { runId: c.runId });
    assert.equal(r.status, 200, 'annulation bloquée par le quota : ' + r.text); assert.equal(c.run().ac.signal.aborted, true);
    await waitFor(async () => (await stateOf(c)) !== 'running'); assert.equal(await stateOf(c), 'cancelled');
    assert.equal(c.srv.agent.consentState().given, true, 'annuler n’est pas révoquer'); c.gate.release(); await c.srv.close();
  });
  await t('priorité bornée à ces deux actions : consentement ACCORDÉ, décision, run et vidage du périmètre restent soumis au quota (429)', async () => {
    const c = await boot(createFakeSdk({}).sdkLoader); await exhaust(c);
    for (const [p, b] of [['/api/agent/consent', { accept: true, v: 1 }], ['/api/agent/decision', { runId: 'x', id: 'x', nonce: 'x', hash: 'x', allow: true }], ['/api/agent/run', chatBody], ['/api/agent/scope/clear', {}]]) {
      const r = await raw(c, 'POST', p, b); assert.equal(r.status, 429, p + ' : ' + r.text);
    }
    assert.equal(c.srv.agent.consentState().given, false, 'un consentement ne peut pas être accordé quand le quota est épuisé'); await c.srv.close();
  });
  await t('les actions prioritaires ne consomment PAS le quota ordinaire (60 révocations + 60 annulations, puis le quota ordinaire est intact) et restent toutes à 200', async () => {
    const c = await bootRunning();
    for (let i = 0; i < 60; i++) { const r = await raw(c, 'POST', '/api/agent/consent', { accept: false }); assert.equal(r.status, 200, 'révocation ' + i + ' : ' + r.text); }
    for (let i = 0; i < 60; i++) { const r = await raw(c, 'POST', '/api/agent/cancel', { runId: c.runId }); assert.equal(r.status, 200, 'annulation ' + i + ' : ' + r.text); }
    const n = await exhaust(c); assert.ok(n >= 14, 'quota ordinaire intact après 120 actions prioritaires : ' + n); c.gate.release(); await c.srv.close();
  });
  await t('l’authentification reste OBLIGATOIRE sous quota épuisé : sans cookie, mauvais jeton, sans jeton, Origin tiers/absente, Sec-Fetch-Site cross-site, mauvais Host, mauvais Content-Type -> refus, rien ne change', async () => {
    const c = await bootRunning(); await exhaust(c);
    const bad = [
      ['sans cookie', { cookie: null }, 403, 'bad_session'], ['cookie inconnu', { cookie: `vie_sid_${c.port}=INCONNU` }, 403, 'bad_session'],
      ['mauvais jeton', { 'x-vie-token': 'x'.repeat(String(c.token).length) }, 403, 'bad_token'], ['sans jeton', { 'x-vie-token': null }, 403, 'bad_token'],
      ['Origin tierce', { origin: 'http://evil.example' }, 403, 'bad_origin'], ['Origin absente', { origin: null }, 403, 'bad_origin'], ['Origin « null »', { origin: 'null' }, 403, 'bad_origin'],
      ['cross-site', { 'sec-fetch-site': 'cross-site' }, 403, 'cross_site'], ['same-site', { 'sec-fetch-site': 'same-site' }, 403, 'cross_site'],
      ['mauvais Host', { host: 'evil.example' }, 403, 'bad_host'], ['mauvais Content-Type', { 'content-type': 'text/plain' }, 415, 'bad_content_type'],
    ];
    for (const [sub, body] of [['consent', { accept: false }], ['cancel', { runId: c.runId }]]) {
      for (const [what, over, status, code] of bad) { const r = await raw(c, 'POST', '/api/agent/' + sub, body, over); assert.equal(r.status, status, `${sub} / ${what} : ${r.text}`); assert.equal(r.json && r.json.error, code, `${sub} / ${what}`); }
    }
    assert.equal(c.srv.agent.consentState().given, true, 'une requête refusée ne révoque rien'); assert.equal(c.run().ac.signal.aborted, false, 'une requête refusée n’annule rien');
    // même ensemble SANS quota épuisé : mêmes refus (le contournement du quota n’a pas assoupli l’authentification)
    const c2 = await bootRunning();
    for (const [what, over, status, code] of bad) { const r = await raw(c2, 'POST', '/api/agent/consent', { accept: false }, over); assert.equal(r.status, status, what); assert.equal(r.json.error, code, what); }
    assert.equal(c2.srv.agent.consentState().given, true); c.gate.release(); c2.gate.release(); await c.srv.close(); await c2.srv.close();
  });
  await t('une requête non authentifiée ne consomme ni ne contourne rien : inondation de 60 révocations sans cookie = 60 refus 403, puis la vraie révocation passe', async () => {
    const c = await bootRunning();
    for (let i = 0; i < 60; i++) { const r = await raw(c, 'POST', '/api/agent/consent', { accept: false }, { cookie: null }); assert.equal(r.status, 403); }
    assert.equal(c.srv.agent.consentState().given, true);
    assert.equal((await raw(c, 'POST', '/api/agent/consent', { accept: false })).status, 200); c.gate.release(); await c.srv.close();
  });
  await t('corps validé comme avant : clé inconnue, accept non booléen, JSON invalide, corps trop gros -> 400/413 (pas de contournement par le chemin prioritaire) ; annulation d’un run inconnu -> 404', async () => {
    const c = await bootRunning(); await exhaust(c);
    assert.equal((await raw(c, 'POST', '/api/agent/consent', { accept: false, extra: 1 })).status, 400);
    assert.equal((await raw(c, 'POST', '/api/agent/consent', { accept: 'false' })).status, 400);
    assert.equal((await raw(c, 'POST', '/api/agent/consent', {})).status, 400);
    assert.equal((await raw(c, 'POST', '/api/agent/consent', '{pas du json')).status, 400);
    assert.equal((await raw(c, 'POST', '/api/agent/consent', { accept: false, pad: 'x'.repeat(120000) })).status, 413);
    assert.equal((await raw(c, 'POST', '/api/agent/cancel', { runId: 'run_inconnu' })).status, 404);
    assert.equal((await raw(c, 'POST', '/api/agent/cancel', { runId: c.runId, x: 1 })).status, 400);
    assert.equal(c.srv.agent.consentState().given, true); assert.equal(c.run().ac.signal.aborted, false); c.gate.release(); await c.srv.close();
  });
  await t('annulation du run d’UNE AUTRE session : 404 (isolation conservée), même sous quota épuisé', async () => {
    const c = await bootRunning(); const s2 = await login(c.srv); const other = { port: c.port, sid: s2.cookie.split('=')[1], token: s2.token };
    await exhaust(c); const r = await raw(other, 'POST', '/api/agent/cancel', { runId: c.runId });
    assert.ok(r.status === 404 || r.status === 429, String(r.status)); assert.equal(c.run().ac.signal.aborted, false);
    const r2 = await raw(other, 'POST', '/api/agent/cancel', { runId: c.runId }); assert.equal(r2.status, 404, 'la 2e session ne voit pas le run de la 1re'); c.gate.release(); await c.srv.close();
  });
  await t('révocation pendant le CHARGEMENT du moteur sous quota épuisé : 200, puis le démarrage est refusé (403) et sdk.query n’est jamais appelé', async () => {
    const fake = createFakeSdk({ script: async () => 'ok' }); const g = gate(); let loads = 0;
    const c = await boot(async () => { loads++; await g.promise; return fake.sdkLoader(); }); c.srv.agent.setConsent(true, 1);
    const run = raw(c, 'POST', '/api/agent/run', chatBody); await waitFor(() => loads >= 1); await exhaust(c);
    const rev = await raw(c, 'POST', '/api/agent/consent', { accept: false }); assert.equal(rev.status, 200, rev.text);
    g.release(); const r = await run; assert.equal(r.status, 403); await sleep(30); assert.equal(fake.calls.queries.length, 0); await c.srv.close();
  });
  await t('hors du serveur Vie, le journal serveur ne contient pas le jeton ni le cookie : (aucune fuite pendant la révocation sous quota)', async () => {
    const lines = []; const g = gate(); const fake = createFakeSdk({ noResult: true, script: async () => { await g.promise; return ''; } });
    const c = await boot(fake.sdkLoader, { log: s => lines.push(String(s)) }); c.srv.agent.setConsent(true, 1); await exhaust(c);
    assert.equal((await raw(c, 'POST', '/api/agent/consent', { accept: false })).status, 200);
    const all = lines.join('\n'); assert.ok(!all.includes(c.token) && !all.includes(c.sid)); g.release(); await c.srv.close();
  });

  // ==============================================================================================================================================================
  console.log('P1 #1 (interface) — le panneau affiche l’échec d’une révocation / annulation au lieu de l’ignorer ; P3 — libellé « exécutée » seulement après un reçu');
  // Le VRAI vie-agent-ui.js est exécuté dans un contexte vm minimal (DOM factice) ; ses requêtes vont vers un vrai serveur sur 127.0.0.1.
  function uiHarness(c, { fetchOverride } = {}) {
    const toasts = [], handlers = {}, finished = [], failed = []; const confirmAnswers = []; let renders = 0;
    const realFetch = (u, o = {}) => new Promise(resolve => {
      const data = o.body === undefined ? undefined : Buffer.from(String(o.body)); const h = { host: `127.0.0.1:${c.port}`, cookie: `vie_sid_${c.port}=${c.sid}`, 'sec-fetch-site': 'same-origin', ...(o.headers || {}) };
      if (o.method === 'POST') { h.origin = `http://127.0.0.1:${c.port}`; if (data) h['content-length'] = data.length; }
      const r = http.request({ host: '127.0.0.1', port: c.port, method: o.method || 'GET', path: u, agent: false, headers: h }, res => { const ch = []; res.on('data', x => ch.push(x)); res.on('end', () => { const text = Buffer.concat(ch).toString('utf8'); resolve({ ok: res.statusCode < 300, status: res.statusCode, json: async () => JSON.parse(text) }); }); });
      r.on('error', () => resolve({ ok: false, status: 0, json: async () => { throw new Error('réseau'); } })); if (data) r.write(data); r.end();
    });
    const sandbox = { setTimeout, clearTimeout, setInterval: () => 1, encodeURIComponent, Intl, Date, JSON, Math, confirm: () => { confirmAnswers.push(true); return true; }, CSS: { escape: s => String(s) }, location: { protocol: 'http:' }, document: { querySelectorAll: () => [], addEventListener: () => {}, visibilityState: 'visible' }, addEventListener: () => {}, fetch: fetchOverride ? (u, o) => fetchOverride(u, o, realFetch) : realFetch };
    sandbox.window = sandbox; vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'vie-agent-ui.js'), 'utf8'), sandbox, { filename: 'vie-agent-ui.js' });
    const br = { panel: { addEventListener: (k, fn) => { handlers[k] = fn; }, querySelector: () => null }, token: () => c.token, locked: () => false, toast: m => toasts.push(String(m)), render: () => { renders++; }, renderAll: () => { renders++; }, budget: () => {}, setMode: () => {}, fail: (m, msg) => failed.push(msg), finish: (m, d) => finished.push(d) };
    const ui = sandbox.VieAgentUI; ui.attach(br);
    const click = ag => handlers.click({ target: { tagName: 'BUTTON', closest: () => ({ tagName: 'BUTTON', dataset: { ag, id: ag === 'approve' || ag === 'deny' ? 'x' : undefined } }) } });
    return { ui, toasts, click, finished, failed, br, renders: () => renders, handlers, clickCard: (ag, id) => handlers.click({ target: { tagName: 'BUTTON', closest: () => ({ tagName: 'BUTTON', dataset: { ag, id } }) } }) };
  }
  const failingConsent = (u, o, real) => (/\/api\/agent\/consent$/.test(u) && o && o.method === 'POST' ? Promise.resolve({ ok: false, status: 429, json: async () => ({ ok: false, error: 'rate_limited', message: 'Trop de demandes en une minute. Patiente un instant.' }) }) : real(u, o));
  await t('REPRO P1 #1 (UI) : « Révoquer » refusée par le serveur (429) -> toast explicite ET bandeau d’alerte persistant « accès toujours actif » ; l’interface ne prétend pas que c’est révoqué', async () => {
    const c = await boot(createFakeSdk({}).sdkLoader); c.srv.agent.setConsent(true, 1);
    const h = uiHarness(c, { fetchOverride: failingConsent }); await h.ui.refresh(); assert.equal(h.ui.consented(), true);
    await h.click('consent-revoke');
    assert.ok(h.toasts.some(m => /révocation|révoqu/i.test(m) && /pas|non/i.test(m)), 'toast : ' + JSON.stringify(h.toasts));
    assert.equal(h.ui.consented(), true, 'le serveur a gardé le consentement : l’interface le montre encore actif');
    const html = h.ui.panelHtml(); assert.match(html, /role="alert"/); assert.match(html, /NON enregistrée|n’a PAS été révoqué|reste actif/i);
    assert.equal(c.srv.agent.consentState().given, true); await c.srv.close();
  });
  await t('REPRO P1 #1 (UI) : serveur injoignable pendant « Révoquer » (statut 0) -> même alerte ; puis la révocation réussie efface l’alerte', async () => {
    const c = await boot(createFakeSdk({}).sdkLoader); c.srv.agent.setConsent(true, 1);
    let down = true; const h = uiHarness(c, { fetchOverride: (u, o, real) => (down && /consent$/.test(u) && o && o.method === 'POST' ? Promise.resolve({ ok: false, status: 0, json: async () => { throw new Error('x'); } }) : real(u, o)) });
    await h.ui.refresh(); await h.click('consent-revoke'); assert.match(h.ui.panelHtml(), /role="alert"/); assert.ok(h.toasts.length >= 1);
    down = false; await h.click('consent-revoke'); assert.equal(h.ui.consented(), false); assert.doesNotMatch(h.ui.panelHtml(), /NON enregistrée|n’a PAS été révoqué/, 'alerte effacée après succès'); await c.srv.close();
  });
  await t('UI + serveur réels, quota épuisé : le clic « Révoquer » révoque vraiment (le serveur répond 200) et aucune alerte d’échec n’est affichée', async () => {
    const c = await bootRunning(); await exhaust(c);
    const h = uiHarness(c); await h.ui.refresh(); await h.click('consent-revoke');
    assert.equal(c.srv.agent.consentState().given, false); assert.equal(h.ui.consented(), false); assert.deepEqual(h.toasts, []); assert.doesNotMatch(h.ui.panelHtml(), /NON enregistrée|n’a PAS été révoqué/); c.gate.release(); await c.srv.close();
  });
  await t('REPRO P1 #1 (UI) : « Annuler » refusée (429) -> message explicite « annulation NON confirmée » visible dans le panneau ; réussie sous quota épuisé -> aucune alerte', async () => {
    const g = gate(); const fake = createFakeSdk({ noResult: true, script: async api => { await api.use('mcp__vie__list_dir', { path: home }); await g.promise; return ''; } }); const c = await boot(fake.sdkLoader); c.srv.agent.setConsent(true, 1);
    const h = uiHarness(c, { fetchOverride: (u, o, real) => (/agent\/cancel$/.test(u) ? Promise.resolve({ ok: false, status: 429, json: async () => ({ ok: false, error: 'rate_limited', message: 'Trop de demandes' }) }) : real(u, o)) });
    await h.ui.refresh(); const m = { agent: { items: [], state: 'starting', since: 0 } }; await h.ui.start(chatBody, m); assert.ok(h.ui.active());
    await h.ui.cancel(); assert.ok(h.toasts.some(m2 => /annulation/i.test(m2)), JSON.stringify(h.toasts)); assert.match(h.ui.panelHtml(), /role="alert"[\s\S]*annulation/i);
    h.ui.stop(); g.release(); await c.srv.close();
  });
  await t('REPRO P3 : la carte approuvée ne dit PAS « exécutée » tant qu’aucun reçu n’existe ; le reçu « ✓ Fait » la fait passer à « approuvée et exécutée » (corrélation par empreinte)', async () => {
    const hold = gate(); const shellMock = [];
    const fake = createFakeSdk({ shell: async cmd => { shellMock.push(cmd); await hold.promise; return { out: 'ok' }; }, script: async api => { const r = await api.use('PowerShell', { command: CMD }); return 'allowed:' + r.allowed; } });
    const c = await boot(fake.sdkLoader); c.srv.agent.setConsent(true, 1); const h = uiHarness(c); await h.ui.refresh();
    const m = { agent: { items: [], state: 'starting', since: 0 } }; await h.ui.start(chatBody, m);
    await waitFor(() => m.agent.items.some(i => i.kind === 'approval'), 6000); const it = m.agent.items.find(i => i.kind === 'approval');
    const hh = { fmt: x => x, cards: () => '' };
    await h.clickCard('approve', it.id); await waitFor(() => shellMock.length === 1 && it.state === 'approved', 6000);   // la commande est « en cours » (suspendue par le simulateur)
    const htmlPending = h.ui.msgHtml(m, hh);
    assert.match(htmlPending, /approuvée/); assert.doesNotMatch(htmlPending, /exécutée/, 'aucune exécution confirmée : le mot « exécutée » est interdit'); assert.doesNotMatch(htmlPending, /✓ Fait/);
    assert.equal(m.agent.items.filter(i => i.kind === 'receipt').length, 0, 'aucun reçu pour l’instant');
    hold.release(); await waitFor(() => m.agent.items.some(i => i.kind === 'receipt' && i.e.result === 'done'), 6000);
    const htmlDone = h.ui.msgHtml(m, hh); assert.match(htmlDone, /approuvée et exécutée/); assert.match(htmlDone, /✓ Fait/);
    await waitFor(() => h.finished.length === 1); h.ui.stop(); await c.srv.close();
  });
  await t('P3 : commande approuvée mais échec -> « approuvée mais en échec » ; commande approuvée puis révoquée avant reprise -> « approuvée mais NON exécutée », jamais « exécutée »', async () => {
    const fake = createFakeSdk({ shell: () => ({ out: 'boom', error: true }), script: async api => { const r = await api.use('PowerShell', { command: CMD }); return 'allowed:' + r.allowed; } });
    const c = await boot(fake.sdkLoader); c.srv.agent.setConsent(true, 1); const h = uiHarness(c); await h.ui.refresh();
    const m = { agent: { items: [], state: 'starting', since: 0 } }; await h.ui.start(chatBody, m);
    await waitFor(() => m.agent.items.some(i => i.kind === 'approval'), 6000); const it = m.agent.items.find(i => i.kind === 'approval');
    await h.clickCard('approve', it.id); await waitFor(() => h.finished.length === 1, 6000);
    const html = h.ui.msgHtml(m, { fmt: x => x, cards: () => '' }); assert.match(html, /approuvée mais en échec/); assert.doesNotMatch(html, /approuvée et exécutée/); await c.srv.close();
    // révocation entre le clic et la reprise (en processus : séquence déterministe)
    const shellMock = []; const fake2 = createFakeSdk({ shell: cmd => { shellMock.push(cmd); return { out: 'ok' }; }, script: async api => { const r = await api.use('PowerShell', { command: CMD }); return 'allowed:' + r.allowed; } });
    const a = mkAgent(fake2.sdkLoader); a.setConsent(true, 1); const r = await a.start(startOpts()); const ap = await pendingApproval(a, r.runId); decideOk(a, r.runId, ap); a.setConsent(false); await waitFor(() => !a.isActive());
    const rc = recs(a, r.runId).filter(e => e.type === 'receipt'); assert.equal(shellMock.length, 0); assert.ok(rc.length >= 1 && rc.every(e => e.ok === false), JSON.stringify(rc.map(e => e.result)));
    assert.ok(rc.every(e => e.hash === ap.hash), 'le reçu porte l’empreinte de la carte (corrélation)');
  });

  // ==============================================================================================================================================================
  console.log('P2 — politique : déplacer un dossier ORDINAIRE qui contient un descendant protégé');
  const repo = (name, rel = '.git/config') => { const d = mkd(path.join(docs, name)); mk(path.join(d, ...rel.split('/')), '[core]\n'); mk(path.join(d, 'README.md'), 'x\n'); return d; };
  await t('témoins positifs : dossier de cours ordinaire, dossier avec fichiers .env.example / .md / sous-dossiers, fichier dans un dépôt : toujours déplaçables avec carte', () => {
    assert.equal(mv(path.join(docs, 'Cours'), dest('cours')).cls, 'write');
    const ok = mkd(path.join(docs, 'projet-propre')); mk(path.join(ok, 'a', 'b', 'c.md')); mk(path.join(ok, '.env.example'), 'KEY=\n'); mk(path.join(ok, 'notes', 'x.txt'));
    assert.equal(mv(ok, dest('propre')).cls, 'write', 'dossier propre'); const rp = repo('depot-a'); assert.equal(mv(path.join(rp, 'README.md'), dest('readme')).cls, 'write', 'un fichier du dépôt n’emporte rien d’autre');
  });
  await t('REPRO P2 : dossier ordinaire contenant .git (même à plusieurs niveaux) -> REFUSÉ, motif explicite (« contient … .git »), aucune carte', () => {
    for (const [name, rel] of [['rp1', '.git/config'], ['rp2', 'sous/dossier/.git/config'], ['rp3', 'a/b/c/d/.git/HEAD']]) {
      const d = repo(name, rel); const p = mv(d, dest(name)); assert.equal(p.cls, 'deny', name + ' : ' + JSON.stringify(p).slice(0, 160));
      assert.match(p.reason, /contient/); assert.match(p.reason, /\.git/); assert.match(p.reason, /dossier protégé/);
    }
  });
  await t('REPRO P2 : autres descendants protégés (.env, .env.local, .ssh, clé .pem, id_rsa, credentials.json, .aws) -> refusés ; .env.example reste autorisé', () => {
    for (const [i, rel] of ['.env', '.env.local', 'cfg/.ssh/known_hosts', 'certs/serveur.pem', 'k/id_rsa', 'x/credentials.json', 'y/.aws/config', 'z/.kube/config'].entries()) {
      const d = mkd(path.join(docs, 'prot' + i)); mk(path.join(d, ...rel.split('/')), 'x\n'); const p = mv(d, dest('p' + i)); assert.equal(p.cls, 'deny', rel); assert.match(p.reason, /contient/, rel);
    }
  });
  await t('un dossier dont un ANCÊTRE n’est pas protégé mais dont le NOM l’est reste refusé comme avant ; la destination n’est jamais inspectée (elle n’existe pas)', () => {
    assert.equal(mv(path.join(docs, 'rp1', '.git'), dest('g')).cls, 'deny'); assert.equal(mv(path.join(docs, 'Cours'), path.join(docs, 'rp1', '.git', 'x')).cls, 'deny');
  });
  await t('profondeur BORNÉE : .git à la profondeur maximale est trouvé ; un arbre plus profond que la limite est REFUSÉ (inspection incomplète, échec fermé) même sans .git', () => {
    const lim = pol.moveScan; assert.ok(lim && lim.depth >= 4 && lim.depth <= 32, 'limites exposées : ' + JSON.stringify(lim));
    const nest = (root, n) => { let d = mkd(root); for (let i = 0; i < n; i++) d = mkd(path.join(d, 'n' + i)); return d; };
    const atMax = nest(path.join(docs, 'prof-max'), lim.depth - 1); mkd(path.join(atMax, '.git'));   // .git à la profondeur exacte
    const pm = mv(path.join(docs, 'prof-max'), dest('pm')); assert.equal(pm.cls, 'deny'); assert.match(pm.reason, /\.git/);
    const okDepth = nest(path.join(docs, 'prof-ok'), lim.depth - 1); assert.equal(mv(path.join(docs, 'prof-ok'), dest('po')).cls, 'write', 'arbre qui tient dans la limite et sans zone protégée : autorisé'); void okDepth;
    const tooDeep = nest(path.join(docs, 'prof-trop'), lim.depth + 2); mkd(path.join(tooDeep, '.git'));   // le .git est au-delà de ce que l'inspection peut voir
    const pt = mv(path.join(docs, 'prof-trop'), dest('pt')); assert.equal(pt.cls, 'deny', 'un .git trop profond pour être vu ne doit PAS rendre le déplacement permis'); assert.match(pt.reason, /incomplète|trop profond|profondeur/i);
    const tooDeepClean = nest(path.join(docs, 'prof-trop2'), lim.depth + 2); void tooDeepClean; assert.equal(mv(path.join(docs, 'prof-trop2'), dest('pt2')).cls, 'deny', 'même sans .git : refus fail-closed'); assert.match(mv(path.join(docs, 'prof-trop2'), dest('pt3')).reason, /incomplète|profondeur/i);
  });
  await t('nombre d’entrées BORNÉ : au-delà de la limite -> refus « inspection incomplète » ; en dessous -> autorisé (limites réduites par option pour le test)', () => {
    const small = createPolicy({ home, cwd: home, vieRoot, moveScan: { depth: 6, entries: 40 } });
    const big = mkd(path.join(docs, 'beaucoup')); for (let i = 0; i < 41; i++) mk(path.join(big, 'f' + i + '.txt'));
    const few = mkd(path.join(docs, 'peu')); for (let i = 0; i < 20; i++) mk(path.join(few, 'f' + i + '.txt'));
    const pb = mv(big, dest('big'), small); assert.equal(pb.cls, 'deny'); assert.match(pb.reason, /incomplète|trop d’entrées|entrées/i);
    assert.equal(mv(few, dest('few'), small).cls, 'write'); assert.deepEqual({ ...small.moveScan }, { depth: 6, entries: 40 });
    assert.ok(pol.moveScan.entries >= 5000 && pol.moveScan.entries <= 200000, 'limite par défaut raisonnable : ' + pol.moveScan.entries);
  });
  await t('erreur de lecture d’un sous-dossier (EACCES simulé) -> REFUS fail-closed, jamais « rien trouvé donc permis »', () => {
    const d = mkd(path.join(docs, 'illisible')); mk(path.join(d, 'a', 'x.txt')); const opaque = mkd(path.join(d, 'opaque')); mk(path.join(opaque, 'notes.txt'));
    const fsDeny = { ...fs, readdirSync: (p, o) => { if (path.resolve(String(p)) === opaque) { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; } return fs.readdirSync(p, o); } };
    const p2 = createPolicy({ home, cwd: home, vieRoot, fs: fsDeny }); const pl = mv(d, dest('ill'), p2); assert.equal(pl.cls, 'deny'); assert.match(pl.reason, /incomplète|illisible|inspection/i);
    assert.equal(mv(d, dest('ill2')).cls, 'write', 'témoin : sans l’erreur de lecture, le même dossier est autorisé');
  });
  await t('jonctions DANS le dossier : lien vers une zone protégée (.ssh) -> refus ; lien vers un dossier ordinaire (même s’il contient un .git ailleurs) -> permis (seul le lien bouge) ; lien CASSÉ -> refus (inspection incomplète) ; lien nommé « .git » -> refus', () => {
    const base = mkd(path.join(docs, 'avec-liens')); const ext = repo('depot-externe'); const plain = mkd(path.join(tmp, 'ailleurs', 'neutre')); mk(path.join(plain, 'z.txt'));
    const l1 = path.join(base, 'vers-ssh'), l2 = path.join(base, 'vers-depot'), l3 = path.join(base, 'vers-neutre'), l4 = path.join(base, 'cassé'), l5 = path.join(base, '.git'); const made = [];
    try {
      if (!link(plain, l3)) return; made.push(l3); assert.equal(mv(base, dest('l')).cls, 'write', 'lien vers un dossier ordinaire : seul le lien serait déplacé');
      if (!link(ext, l2)) return; made.push(l2); assert.equal(mv(base, dest('l2')).cls, 'write', 'lien vers un dépôt EXTÉRIEUR : le dépôt ne bouge pas');
      if (!link(path.join(home, '.ssh'), l1)) return; made.push(l1); const p1 = mv(base, dest('l1')); assert.equal(p1.cls, 'deny', 'lien vers .ssh'); assert.match(p1.reason, /contient|protég/);
      unlink(l1); made.pop(); const gone = mkd(path.join(tmp, 'ephemere')); if (!link(gone, l4)) return; made.push(l4); fs.rmdirSync(gone); const p4 = mv(base, dest('l4')); assert.equal(p4.cls, 'deny', 'lien cassé'); assert.match(p4.reason, /incomplète|cassé|lien/i);
      unlink(l4); made.splice(made.indexOf(l4), 1); if (!link(plain, l5)) return; made.push(l5); const p5 = mv(base, dest('l5')); assert.equal(p5.cls, 'deny', 'lien nommé .git'); assert.match(p5.reason, /\.git/);
    } finally { for (const l of made.reverse()) unlink(l); }
  });
  await t('source = jonction vers un dépôt : le plan travaille sur le chemin RÉEL (c’est lui qui serait déplacé) -> refus', () => {
    const ext = repo('depot-via-lien'); const l = path.join(docs, 'raccourci-depot'); if (!link(ext, l)) return;
    try { const p = mv(l, dest('via')); assert.equal(p.cls, 'deny'); assert.match(p.reason, /\.git/); } finally { unlink(l); }
  });
  await t('write_file / edit_file / delete_file : aucun effet de bord de la nouvelle règle (pas d’inspection des descendants) ; un fichier ordinaire d’un dépôt reste modifiable avec carte', () => {
    const rp = repo('depot-w'); assert.equal(pol.plan('mcp__vie__write_file', { path: path.join(rp, 'nouveau.md'), content: 'x' }).cls, 'write');
    assert.equal(pol.plan('mcp__vie__write_file', { path: path.join(rp, '.git', 'config'), content: 'x', overwrite: true }).cls, 'deny', 'écrire DANS .git reste refusé');
    assert.equal(pol.plan('mcp__vie__delete_file', { path: path.join(rp, 'README.md') }).cls, 'write');
  });

  console.log('P2 — exécution : le contrôle est refait au moment du déplacement (TOCTOU, jonction repointée)');
  const tools = createTools({ policy: pol, backupRoot: backups, pdftotext: null });
  await t('REPRO P2 (outil) : un plan forgé ou périmé qui déplace un dépôt est refusé à l’exécution ; rien ne bouge', () => {
    const d = repo('depot-forge'); const target = dest('forge'); const r = tools.write.move_path({ input: { from: d, to: target } }, 'run_x');
    assert.equal(r.isError, true); assert.match(r.text, /refusé|Rien déplacé/); assert.ok(fs.existsSync(path.join(d, '.git', 'config')) && !fs.existsSync(target));
  });
  await t('TOCTOU : dossier propre au moment de la carte, .git créé APRÈS la carte -> déplacement refusé à l’exécution, rien déplacé ; sans .git, le même plan s’exécute (témoin)', () => {
    const d = mkd(path.join(docs, 'devient-depot')); mk(path.join(d, 'a.md')); const to = dest('tt'); const plan = mv(d, to); assert.equal(plan.cls, 'write');
    mkd(path.join(d, 'sous', '.git')); const r = tools.write.move_path(plan, 'run_x'); assert.equal(r.isError, true, r.text); assert.ok(fs.existsSync(d) && !fs.existsSync(to));
    fs.rmSync(path.join(d, 'sous'), { recursive: true }); const ok = tools.write.move_path(plan, 'run_x'); assert.equal(ok.isError, false, ok.text); assert.ok(fs.existsSync(to) && !fs.existsSync(d));
  });
  await t('TOCTOU : dossier propre à la carte, REMPLACÉ ensuite par une jonction vers un dépôt -> refusé à l’exécution (chemin ré-résolu), le dépôt ne bouge pas', () => {
    const d = mkd(path.join(docs, 'sera-un-lien')); mk(path.join(d, 'a.md')); const to = dest('tl'); const plan = mv(d, to); assert.equal(plan.cls, 'write');
    const ext = repo('depot-cible-lien'); fs.rmSync(d, { recursive: true }); if (!link(ext, d)) return;
    try { const r = tools.write.move_path(plan, 'run_x'); assert.equal(r.isError, true, r.text); assert.ok(fs.existsSync(path.join(ext, '.git', 'config')) && !fs.existsSync(to)); } finally { unlink(d); }
  });
  await t('TOCTOU : inspection devenue impossible entre la carte et l’exécution (erreur de lecture) -> refusé, rien déplacé', () => {
    const d = mkd(path.join(docs, 'devient-illisible')); mk(path.join(d, 'a', 'x.md')); const to = dest('ti'); const plan = mv(d, to); assert.equal(plan.cls, 'write');
    const fsDeny = { ...fs, readdirSync: (p, o) => { if (path.resolve(String(p)) === path.join(d, 'a')) { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; } return fs.readdirSync(p, o); } };
    const tl = createTools({ policy: createPolicy({ home, cwd: home, vieRoot, fs: fsDeny }), backupRoot: backups, pdftotext: null }); const r = tl.write.move_path(plan, 'run_x');
    assert.equal(r.isError, true, r.text); assert.ok(fs.existsSync(d) && !fs.existsSync(to));
  });
  await t('déplacement ordinaire (témoin) : un dossier propre se déplace, la source disparaît, la destination existe, reçu « Déplacé et vérifié »', () => {
    const a = mkd(path.join(docs, 'ordinaire-a')); mk(path.join(a, 'k.md')); const b = dest('oa'); const r = tools.write.move_path(mv(a, b), 'run_x');
    assert.equal(r.isError, false, r.text); assert.match(r.text, /Déplacé et vérifié/); assert.ok(fs.existsSync(path.join(b, 'k.md')) && !fs.existsSync(a));
  });
  await t('de bout en bout par l’agent (faux SDK) : move_path d’un dépôt -> aucune carte, refus visible dans les reçus, le dépôt reste en place ; un dossier propre -> carte, puis déplacé après APPROUVER', async () => {
    const d = repo('depot-agent'); const dTo = dest('ag1'); const clean = mkd(path.join(docs, 'propre-agent')); mk(path.join(clean, 'k.md')); const cTo = dest('ag2');
    const fake = createFakeSdk({ script: async api => { const a = await api.use('mcp__vie__move_path', { from: d, to: dTo }); const raw2 = await api.rawHandler('move_path', { from: d, to: dTo }); const b = await api.use('mcp__vie__move_path', { from: clean, to: cTo }); return `a:${a.allowed} raw:${raw2.isError} b:${b.allowed}`; } });
    const a = mkAgent(fake.sdkLoader); a.setConsent(true, 1); const r = await a.start(startOpts()); const ap = await pendingApproval(a, r.runId); decideOk(a, r.runId, ap); await waitFor(() => !a.isActive());
    const ev = recs(a, r.runId); assert.equal(ev.filter(e => e.type === 'approval').length, 1, 'une seule carte : celle du dossier propre'); assert.match(ev.find(e => e.type === 'done').reply, /a:false raw:true b:true/);
    assert.ok(ev.some(e => e.type === 'receipt' && e.result === 'refused' && /\.git/.test(e.detail || '')), 'refus motivé visible'); assert.ok(fs.existsSync(path.join(d, '.git', 'config')) && !fs.existsSync(dTo)); assert.ok(fs.existsSync(path.join(cTo, 'k.md')));
  });

  console.log('Intégrité : le .env factice, .ssh et Vie factices sont intacts ; aucune clé réelle ; rien hors du dossier temporaire');
  await t('fichiers sensibles factices inchangés', () => {
    assert.equal(fs.readFileSync(path.join(vieRoot, '.env'), 'utf8'), 'ANTHROPIC_API_KEY=FAKE-ENV-CANARY-NOT-A-SECRET\n'); assert.equal(fs.readFileSync(path.join(home, '.ssh', 'id_rsa'), 'utf8'), 'FAKE-PRIVATE-KEY-BODY-NOT-REAL\n'); assert.ok(fs.existsSync(path.join(vieRoot, 'vie-agent.cjs')));
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass + fail} tests, ${pass} OK, ${fail} KO${fail ? ' : ' + failures.join(' | ') : ''}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (x) { /* nettoyage au mieux */ } process.exit(1); });
