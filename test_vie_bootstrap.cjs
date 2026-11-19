// Tests de l'AUTHENTIFICATION DE LANCEMENT de Vie (P2 #5 de la revue red team) : hors ligne, faux Anthropic, faux SDK, aucun vrai .env, aucun appel payant.
//   node test_vie_bootstrap.cjs
// Objectif : un processus local quelconque (autre compte Windows compris) qui sait seulement faire des requêtes HTTP sur 127.0.0.1, même avec Host/Origin/Sec-Fetch-Site forgés,
// n'obtient NI cookie, NI jeton, NI session, NI capacité d'approbation. Une session ne naît que de l'échange d'un ticket de lancement (émis dans le processus serveur).
// Ces tests ÉCHOUAIENT sur la v3 (un simple GET / donnait cookie + jeton).
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createVieServer } = require('./vie-server.cjs');
const { openBrowser } = require('./vie-open.cjs');
const { login, exchange, sameOriginHeaders } = require('./test_vie_auth.cjs');
const { createFakeSdk } = require('./fake_agent_sdk.cjs');

const FAKE_KEY = 'FAKE-KEY-NOT-A-SECRET-BOOTSTRAP-0123456789';
const ROOT = __dirname;
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vie-boot-test-')));
const NOENV = path.join(tmp, 'absent.env');
const results = [];
const check = (name, fn) => results.push({ name, fn });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ALL_TEXT = [], LOGS = [];   // ce que le serveur a dit : corps de réponses HTTP, et journaux
const SECRETS = new Set(), TOKENS = new Set();   // tickets et identifiants de session (ne doivent JAMAIS réapparaître) ; jetons CSRF (jamais dans les journaux)
const remember = (...v) => v.filter(x => typeof x === 'string' && x.length >= 20).forEach(x => SECRETS.add(x));
const rememberToken = (...v) => v.filter(x => typeof x === 'string' && x.length >= 20).forEach(x => TOKENS.add(x));

// --- Nettoyage des processus de CETTE suite (B4, QA passe 4 : un « node vie-server.cjs --open » restait orphelin) ---------------------------------------------------------
// Règle : on ne tue QUE les PID que cette suite a elle-même lancés (ou leurs descendants), jamais un processus trouvé par son nom ; un orphelin d'une exécution antérieure n'est PAS touché.
// SPAWNED = { pid, port, what } enregistrés au lancement ; le dernier test vérifie que plus aucun n'est vivant et que chaque port est fermé ; un filet synchrone à la sortie
// retire ce qui survivrait encore (après avoir revérifié que la ligne de commande du PID est bien celle de vie-server.cjs / start-vie.cmd : un PID réutilisé par un autre programme n'est jamais tué).
const SPAWNED = [];
const isAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function winProcs() {
  if (process.platform !== 'win32') return [];
  const { spawnSync } = require('node:child_process');
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  try { const j = JSON.parse(r.stdout); return (Array.isArray(j) ? j : [j]).map(x => ({ pid: x.ProcessId, ppid: x.ParentProcessId, cmd: String(x.CommandLine || '') })); } catch (e) { return []; }
}
function descendantsOf(pid, procs = winProcs()) {
  const out = new Set(), todo = [pid];
  while (todo.length) { const p = todo.pop(); for (const x of procs) if (x.ppid === p && !out.has(x.pid) && x.pid !== pid) { out.add(x.pid); todo.push(x.pid); } }
  return [...out];
}
const track = (pid, port, what) => { SPAWNED.push({ pid, port, what }); return pid; };
function killOwn(pid) {
  const { spawnSync } = require('node:child_process');
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 15000 });
  else { try { process.kill(pid, 'SIGKILL'); } catch (e) { /* déjà terminé */ } }
}
async function waitGone(pids, ms = 6000) { for (let t = 0; t < ms && pids.some(isAlive); t += 100) await sleep(100); return pids.filter(isAlive); }
const portClosed = port => new Promise(res => { const s = require('node:net').connect({ host: '127.0.0.1', port }); s.once('connect', () => { s.destroy(); res(false); }); s.once('error', () => res(true)); });
async function stopTree(rootPid, port, what) {
  const kids = descendantsOf(rootPid);   // relevés AVANT l'arrêt : le parent mort, l'arbre ne se retrouve plus
  for (const k of kids) track(k, port, what + ' (descendant)');
  killOwn(rootPid);
  let left = await waitGone([rootPid, ...kids]);
  for (const k of left) killOwn(k);     // seulement des PID de CET arbre
  left = await waitGone(left);
  return left;
}
process.on('exit', () => {
  const live = SPAWNED.filter(x => isAlive(x.pid)); if (!live.length) return;
  const procs = winProcs();
  for (const x of live) { const p = procs.find(q => q.pid === x.pid); if (process.platform !== 'win32' || (p && /vie-server\.cjs|start-vie\.cmd/i.test(p.cmd))) killOwn(x.pid); }
});

function rq(port, { method = 'GET', url = '/', headers = {}, body, raw } = {}) {
  return new Promise((resolve, reject) => {
    const data = raw !== undefined ? raw : body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const h = { ...headers }; for (const k of Object.keys(h)) if (h[k] === undefined) delete h[k]; if (data !== null) h['Content-Length'] = Buffer.byteLength(data);
    const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: h, agent: false }, res => {
      const ch = []; res.on('data', c => ch.push(c));
      res.on('end', () => { const text = Buffer.concat(ch).toString('utf8'); ALL_TEXT.push(text); let json = null; try { json = JSON.parse(text); } catch (e) { /* pas du JSON */ } resolve({ status: res.statusCode, headers: res.headers, text, json }); });
    });
    r.on('error', reject); if (data !== null) r.write(data); r.end();
  });
}
const trapFetch = calls => async () => { calls.push(1); throw new Error('APPEL RÉSEAU INTERDIT DANS LES TESTS'); };
function boot(over = {}) {
  const logs = [], fetchCalls = [], clock = { t: over.t0 || Date.now() };
  const vie = createVieServer({ env: { ANTHROPIC_API_KEY: FAKE_KEY, ...(over.env || {}) }, envFile: NOENV, fetch: trapFetch(fetchCalls), sleep: () => Promise.resolve(), log: l => { logs.push(l); LOGS.push(l); }, now: () => clock.t, limits: { perMinute: 1000, ...(over.limits || {}) }, ...(over.opts || {}) });
  return vie.listen(over.port || 0).then(port => ({ vie, port, logs, fetchCalls, clock, done: () => vie.close() }));
}
const same = port => sameOriginHeaders(port);
const SENSITIVE = port => [
  ['POST', '/api/chat', { mode: 'rapide', share: false, messages: [{ role: 'user', content: 'x' }], view: 'today', today: '2026-11-15' }],
  ['POST', '/api/chat', { mode: 'rapide', share: false, dev: true, messages: [{ role: 'user', content: 'x' }], view: 'today', today: '2026-11-15' }],
  ['GET', '/api/agent/status'], ['GET', '/api/agent/events?run=x&since=0'],
  ['POST', '/api/agent/consent', { accept: true, v: 1 }], ['POST', '/api/agent/run', { mode: 'rapide', share: false, messages: [{ role: 'user', content: 'x' }], view: 'today', today: '2026-11-15' }],
  ['POST', '/api/agent/decision', { runId: 'r', id: 'i', nonce: 'n', hash: 'h', allow: true }], ['POST', '/api/agent/cancel', { runId: 'r' }], ['POST', '/api/agent/scope/clear', {}],
  ['POST', '/api/code', { id: 'a', nonce: 'b', hash: 'c', confirm: true }], ['POST', '/api/code/undo', { id: 'a', nonce: 'b', hash: 'c', confirm: true }],
];

// === 1. GET anonyme : rien de privilégié ===============================================================================================================
check('GET anonyme de / , des ressources, de /api/health : AUCUN Set-Cookie, AUCUN jeton, rien de la clé / du budget / du catalogue', async () => {
  const s = await boot();
  try {
    const legit = await login(s.vie); remember(legit.cookie.split('=')[1]); rememberToken(legit.token);   // une session légitime existe déjà : un anonyme n'en reçoit RIEN (ni jeton, ni cookie)
    for (const u of ['/', '/index.html', '/vie-boot.js', '/core.js', '/app.js', '/styles.css', '/vie-actions.js', '/vie-assistant.js', '/vie-agent-ui.js', '/favicon.ico', '/api/health']) {
      for (const sfs of [undefined, 'none', 'same-origin']) {
        const r = await rq(s.port, { url: u, headers: { Host: `127.0.0.1:${s.port}`, ...(sfs ? { 'Sec-Fetch-Site': sfs } : {}) } });
        assert.ok([200, 204, 403].includes(r.status), u + ' ' + r.status);
        assert.equal(r.headers['set-cookie'], undefined, `aucun Set-Cookie sur ${u} (${sfs})`);
        assert.ok(!r.text.includes(FAKE_KEY));
      }
    }
    const h = await rq(s.port, { url: '/api/health', headers: { Host: `127.0.0.1:${s.port}`, 'Sec-Fetch-Site': 'same-origin' } });
    assert.deepEqual(Object.keys(h.json).sort(), ['auth', 'authenticated', 'ok', 'service', 'token', 'version']);
    assert.equal(h.json.authenticated, false); assert.equal(h.json.token, null); assert.ok(!h.text.includes(legit.token), 'le jeton d’une session ouverte ne fuit pas vers un anonyme');
    for (const k of ['keyConfigured', 'budget', 'catalog', 'prices', 'levels', 'agent', 'dev', 'limits']) assert.equal(h.json[k], undefined, k + ' absent pour un anonyme');
  } finally { await s.done(); }
});
check('GET anonyme puis ATTAQUE « authentifiée » : Host/Origin/Sec-Fetch-Site parfaits, cookie et jeton devinés ou inventés -> 403 partout, aucun appel Anthropic, aucun agent, aucune réserve de budget', async () => {
  const fake = createFakeSdk({ script: async api => api.say('ne doit jamais tourner') });
  const s = await boot({ opts: { agent: { sdkLoader: fake.sdkLoader, home: tmp, cwd: tmp, backupRoot: path.join(tmp, 'bk'), configDir: path.join(tmp, 'cfg'), pdftotext: null } } });
  try {
    // Attaque réelle de la v3 : un GET anonyme de / donnait cookie + (via /api/health) jeton. L'attaquant tente de les récolter, puis s'en sert comme le navigateur.
    const g = await rq(s.port, { url: '/', headers: { Host: `127.0.0.1:${s.port}`, 'Sec-Fetch-Site': 'none' } });
    const harvested = String(g.headers['set-cookie'] || '').split(';')[0];
    const hv = await rq(s.port, { url: '/api/health', headers: { Host: `127.0.0.1:${s.port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: harvested } });
    const stolen = hv.json && typeof hv.json.token === 'string' ? hv.json.token : '';
    assert.equal(harvested, '', 'aucun cookie récoltable par un GET anonyme'); assert.equal(stolen, '', 'aucun jeton récoltable');
    for (const [m, u, b] of SENSITIVE(s.port)) { const r = await rq(s.port, { method: m, url: u, headers: { ...same(s.port), 'Content-Type': 'application/json', Cookie: harvested, 'X-Vie-Token': stolen }, body: b }); assert.equal(r.status, 403, `${m} ${u} avec les identifiants « récoltés » -> ${r.status}`); }
    const guesses = ['', 'x', 'undefined', 'null', crypto.randomBytes(24).toString('base64url'), crypto.randomBytes(24).toString('hex'), '../..', 'vie_sid_' + s.port];
    for (const [m, u, b] of SENSITIVE(s.port)) {
      for (const g of guesses) {
        const r = await rq(s.port, { method: m, url: u, headers: { ...same(s.port), 'Content-Type': 'application/json', Cookie: `vie_sid_${s.port}=${g}`, 'X-Vie-Token': g || 'x' }, body: b });
        assert.equal(r.status, 403, `${m} ${u} cookie=${g.slice(0, 8)} -> ${r.status} ${r.text.slice(0, 120)}`);
        assert.ok(['bad_session', 'bad_token'].includes(r.json.error), u + ' ' + r.json.error);
      }
      const nocookie = await rq(s.port, { method: m, url: u, headers: { ...same(s.port), 'Content-Type': 'application/json', 'X-Vie-Token': 'x'.repeat(32) }, body: b });
      assert.equal(nocookie.status, 403);
    }
    assert.equal(s.fetchCalls.length, 0, 'aucun appel Anthropic');
    assert.equal(fake.calls.queries.length, 0, 'aucune exécution d’agent');
    assert.equal(s.vie.budgetInfo().reservedUsd, 0); assert.equal(s.vie.budgetInfo().spentUsd, 0);
    const a = await s.vie.agent.status(); assert.equal(a.consent.given, false, 'aucun consentement donné par un anonyme');
  } finally { await s.done(); }
});
check('démarrage SANS ticket (démarrage direct) : le bootstrap n’a jamais eu lieu -> chat, agent, mode structure inertes même avec clé valide ; aucune route ne renvoie de ticket', async () => {
  const s = await boot();
  try {
    for (const [m, u, b] of SENSITIVE(s.port)) { const r = await rq(s.port, { method: m, url: u, headers: { ...same(s.port), 'Content-Type': 'application/json' }, body: b }); assert.equal(r.status, 403, u); }
    for (const u of ['/api/auth', '/api/auth/', '/api/auth/ticket', '/api/auth/exchange', '/api/launch', '/api/token', '/api/session']) {
      const r = await rq(s.port, { url: u, headers: same(s.port) }); assert.ok([404, 405].includes(r.status), u + ' ' + r.status); assert.equal(r.headers['set-cookie'], undefined);
    }
    const ex = await exchange(s.port, crypto.randomBytes(32).toString('base64url'));
    assert.equal(ex.status, 403); assert.equal(ex.json.error, 'bad_ticket'); assert.equal(ex.headers['set-cookie'], undefined, 'sans ticket émis, aucune session possible');
  } finally { await s.done(); }
});

// === 2. Échange du ticket : garde-fous, rejeu, falsification, force brute ===========================================================================
check('origine forgée / absente / inter-sites / hôte étranger / mauvais type / GET : refusés AVANT le ticket, et sans le brûler', async () => {
  const s = await boot();
  try {
    const ticket = s.vie.issueLaunchTicket(); remember(ticket);
    const body = JSON.stringify({ ticket });
    const base = { ...same(s.port), 'Content-Type': 'application/json' };
    const variants = [
      { ...base, Origin: 'https://evil.example' }, { ...base, Origin: 'null' }, { ...base, Origin: `http://localhost:${s.port}` }, { ...base, Origin: `http://127.0.0.1:${s.port + 1}` },
      (() => { const h = { ...base }; delete h.Origin; return h; })(), { ...base, 'Sec-Fetch-Site': 'cross-site' }, { ...base, 'Sec-Fetch-Site': 'same-site' }, { ...base, 'Sec-Fetch-Site': 'none' },
      { ...base, Host: 'evil.example' }, { ...base, Host: `localhost:${s.port}` }, { ...base, Host: `127.0.0.1:${s.port}.evil.example` },
    ];
    for (const h of variants) { const r = await rq(s.port, { method: 'POST', url: '/api/auth/exchange', headers: h, raw: body }); assert.equal(r.status, 403, JSON.stringify(h)); assert.equal(r.headers['set-cookie'], undefined); }
    for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', undefined]) { const h = { ...same(s.port) }; if (ct) h['Content-Type'] = ct; const r = await rq(s.port, { method: 'POST', url: '/api/auth/exchange', headers: h, raw: body }); assert.equal(r.status, 415, String(ct)); }
    for (const m of ['GET', 'PUT', 'DELETE', 'HEAD']) { const r = await rq(s.port, { method: m, url: '/api/auth/exchange?ticket=' + ticket, headers: base }); assert.equal(r.status, 405, m); }
    const ok = await exchange(s.port, ticket);
    assert.equal(ok.status, 200, 'le ticket n’a pas été brûlé par les tentatives refusées en amont'); assert.equal(ok.json.authenticated, true);
  } finally { await s.done(); }
});
check('cookie de session : HttpOnly, SameSite=Strict, Path=/, durée bornée ; pas de Secure en HTTP ; ni ticket ni jeton dans la réponse ni dans les journaux', async () => {
  const s = await boot();
  try {
    const ticket = s.vie.issueLaunchTicket(); remember(ticket);
    const ex = await exchange(s.port, ticket);
    const c = String(ex.headers['set-cookie']); remember(c.split(';')[0].split('=')[1]);
    assert.match(c, new RegExp(`^vie_sid_${s.port}=[A-Za-z0-9_-]{32};`)); assert.match(c, /; HttpOnly/); assert.match(c, /; SameSite=Strict/); assert.match(c, /; Path=\//); assert.match(c, /; Max-Age=43200/);
    assert.ok(!/Secure/.test(c), 'HTTP local : le drapeau Secure serait refusé ou ignoré selon le navigateur ; limite documentée');
    assert.deepEqual(Object.keys(ex.json).sort(), ['authenticated', 'ok']); assert.ok(!ex.text.includes(ticket));
    const sess = await login(s.vie); remember(sess.cookie.split('=')[1]); rememberToken(sess.token);
    assert.ok(![...s.logs].some(l => l.includes(ticket) || l.includes(sess.token)), 'journaux propres');
  } finally { await s.done(); }
});
check('rejeu : un ticket ne sert qu’UNE fois ; le second essai (même navigateur ou autre) est refusé et ne crée aucune session', async () => {
  const s = await boot();
  try {
    const ticket = s.vie.issueLaunchTicket();
    const a = await exchange(s.port, ticket); assert.equal(a.status, 200);
    const cookie = String(a.headers['set-cookie']).split(';')[0];
    const b = await exchange(s.port, ticket); assert.equal(b.status, 403); assert.equal(b.json.error, 'bad_ticket'); assert.equal(b.headers['set-cookie'], undefined);
    const c = await exchange(s.port, ticket); assert.equal(c.status, 403);
    const h = await rq(s.port, { url: '/api/health', headers: { Host: `127.0.0.1:${s.port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie } }); assert.equal(h.json.authenticated, true, 'la première session reste valable');
  } finally { await s.done(); }
});
check('falsification : ticket modifié (1 caractère, tronqué, allongé, casse, vide, types non chaînes, clés en plus, corps énorme) refusé ; JSON invalide 400 ; jamais de session', async () => {
  const s = await boot({ limits: { launchFails: 100, exchangePerMinute: 1000 } });
  try {
    const ticket = s.vie.issueLaunchTicket();
    const flip = ticket.slice(0, -1) + (ticket.endsWith('A') ? 'B' : 'A');
    const hdr = { ...same(s.port), 'Content-Type': 'application/json' };
    const bodies = [{ ticket: flip }, { ticket: ticket.slice(1) }, { ticket: ticket + 'A' }, { ticket: ticket.toUpperCase() }, { ticket: '' }, { ticket: 42 }, { ticket: null }, { ticket: [ticket] }, { ticket: { x: ticket } }, { ticket, admin: true }, { tickets: ticket }, {}, { ticket: ticket + '\u0000' }, { ticket: ' ' + ticket }];
    for (const b of bodies) { const r = await rq(s.port, { method: 'POST', url: '/api/auth/exchange', headers: hdr, body: b }); assert.ok([400, 403].includes(r.status), JSON.stringify(b).slice(0, 60) + ' -> ' + r.status); assert.equal(r.headers['set-cookie'], undefined); }
    for (const raw of ['{pas du json', '[]', 'null', '"x"', '']) { const r = await rq(s.port, { method: 'POST', url: '/api/auth/exchange', headers: hdr, raw }); assert.ok([400, 403].includes(r.status), raw); assert.equal(r.headers['set-cookie'], undefined); }
    const big = await rq(s.port, { method: 'POST', url: '/api/auth/exchange', headers: hdr, raw: JSON.stringify({ ticket: 'a'.repeat(5000) }) }).catch(e => ({ status: e.code }));
    assert.ok(big.status === 413 || big.status === 'ECONNRESET', String(big.status));
    assert.equal((await exchange(s.port, ticket)).status, 200, 'le vrai ticket fonctionne encore (seuil d’échecs relevé pour ce test)');
  } finally { await s.done(); }
});
check('force brute : 5 essais faux révoquent le ticket vivant (le BON ticket est alors refusé) ; au plus 10 essais par minute (429) ; un nouveau ticket exige une action du lanceur', async () => {
  const s = await boot();
  try {
    const ticket = s.vie.issueLaunchTicket();
    for (let i = 0; i < 5; i++) { const r = await exchange(s.port, crypto.randomBytes(32).toString('base64url')); assert.equal(r.status, 403); }
    assert.ok(s.logs.some(l => /ticket de lancement révoqué/.test(l)));
    assert.equal((await exchange(s.port, ticket)).status, 403, 'ticket révoqué : même le bon est refusé (échec fermé)');
    const t2 = s.vie.issueLaunchTicket(); assert.equal((await exchange(s.port, t2)).status, 200, 'un nouveau ticket émis par le lanceur fonctionne');
    // plafond d'essais par minute (horloge simulée)
    const s2 = await boot({ limits: { launchFails: 1000 } });
    try {
      s2.vie.issueLaunchTicket(); let last = null;
      for (let i = 0; i < 12; i++) last = await exchange(s2.port, crypto.randomBytes(32).toString('base64url'));
      assert.equal(last.status, 429); assert.ok(Number(last.headers['retry-after']) >= 1);
      const t3 = s2.vie.issueLaunchTicket(); assert.equal((await exchange(s2.port, t3)).status, 429, 'même le bon ticket attend la fin de la fenêtre');
      s2.clock.t += 61000; const t4 = s2.vie.issueLaunchTicket(); assert.equal((await exchange(s2.port, t4)).status, 200, 'fenêtre écoulée');
    } finally { await s2.done(); }
  } finally { await s.done(); }
});
check('ticket expiré (90 s) refusé ; un nouveau ticket remplace le précédent (un seul vivant)', async () => {
  const s = await boot();
  try {
    const t1 = s.vie.issueLaunchTicket(); s.clock.t += 89000;
    const t2 = s.vie.issueLaunchTicket(); assert.notEqual(t1, t2);
    assert.equal((await exchange(s.port, t1)).status, 403, 'l’ancien ticket est remplacé');
    const t3 = s.vie.issueLaunchTicket(); s.clock.t += 91000;
    assert.equal((await exchange(s.port, t3)).status, 403, 'expiré après 90 s'); assert.equal((await exchange(s.port, t3)).status, 403);
    const t4 = s.vie.issueLaunchTicket(); s.clock.t += 5000; assert.equal((await exchange(s.port, t4)).status, 200);
  } finally { await s.done(); }
});

// === 3. Sessions : jeton propre, expiration, autre instance, redémarrage =============================================================================
check('chaque session a SON jeton CSRF ; cookie d’une session + jeton d’une autre = refus ; sans cookie ou sans jeton = refus', async () => {
  const s = await boot();
  try {
    const a = await login(s.vie), b = await login(s.vie); remember(a.cookie.split('=')[1], b.cookie.split('=')[1]); rememberToken(a.token, b.token);
    assert.notEqual(a.token, b.token); assert.notEqual(a.cookie, b.cookie);
    const post = (cookie, token) => rq(s.port, { method: 'POST', url: '/api/agent/consent', headers: { ...same(s.port), 'Content-Type': 'application/json', Cookie: cookie, 'X-Vie-Token': token }, body: { accept: false } });
    assert.equal((await post(a.cookie, a.token)).status, 200);
    assert.equal((await post(a.cookie, b.token)).json.error, 'bad_token'); assert.equal((await post(b.cookie, a.token)).json.error, 'bad_token');
    assert.equal((await post('', a.token)).json.error, 'bad_session'); assert.equal((await post(a.cookie, '')).json.error, 'bad_token');
    assert.equal((await post(a.cookie, 'é'.repeat(a.token.length))).status, 403, 'jeton non ASCII de même longueur : refus propre, pas d’erreur 500');
  } finally { await s.done(); }
});
check('connexion expirée : durée absolue 12 h et inactivité 2 h ; l’activité prolonge l’inactivité mais jamais la durée absolue ; après expiration tout est refusé', async () => {
  const s = await boot();
  try {
    const ok = async x => (await rq(s.port, { url: '/api/agent/status', headers: { Host: `127.0.0.1:${s.port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: x.cookie, 'X-Vie-Token': x.token } })).status;
    const idle = await login(s.vie); assert.equal(await ok(idle), 200);
    s.clock.t += 2 * 3600000 + 1000; assert.equal(await ok(idle), 403, 'inactif depuis plus de 2 h');
    const act = await login(s.vie);
    for (let i = 0; i < 7; i++) { s.clock.t += 100 * 60000; assert.equal(await ok(act), 200, 'activité régulière : reste ouverte (pas ' + i + ')'); }   // 11 h 40 min
    s.clock.t += 30 * 60000; assert.equal(await ok(act), 403, 'plus de 12 h depuis l’ouverture : expirée malgré l’activité');
    const h = await rq(s.port, { url: '/api/health', headers: { Host: `127.0.0.1:${s.port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: act.cookie } }); assert.equal(h.json.authenticated, false); assert.equal(h.json.token, null);
  } finally { await s.done(); }
});
check('redémarrage : le secret est renouvelé ; ancien cookie, ancien jeton et ticket non utilisé de l’ancien processus sont inutilisables sur le même port', async () => {
  const a = await boot(); const port = a.port;
  const old = await login(a.vie); const unused = a.vie.issueLaunchTicket(); remember(unused); rememberToken(old.token);
  await a.done();
  const b = await boot({ port });
  try {
    assert.equal(b.port, port);
    const h = await rq(port, { url: '/api/health', headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: old.cookie } }); assert.equal(h.json.authenticated, false);
    for (const [m, u, bd] of SENSITIVE(port)) { const r = await rq(port, { method: m, url: u, headers: { ...same(port), 'Content-Type': 'application/json', Cookie: old.cookie, 'X-Vie-Token': old.token }, body: bd }); assert.equal(r.status, 403, u); }
    assert.equal((await exchange(port, unused)).status, 403, 'ticket de l’ancien processus : refusé');
    const fresh = await login(b.vie); assert.notEqual(fresh.token, old.token); assert.notEqual(fresh.cookie, old.cookie);
  } finally { await b.done(); }
});
check('cookies d’une autre instance : valeur d’un autre port sous le nom du bon port, ou cookie d’une autre instance sur le même port : refusés', async () => {
  const a = await boot(), b = await boot();
  try {
    assert.notEqual(a.port, b.port);
    const sa = await login(a.vie), sb = await login(b.vie);
    const idA = sa.cookie.split('=')[1];
    const r = await rq(b.port, { url: '/api/agent/status', headers: { Host: `127.0.0.1:${b.port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: `vie_sid_${b.port}=${idA}`, 'X-Vie-Token': sa.token } }); assert.equal(r.status, 403);
    const r2 = await rq(b.port, { url: '/api/agent/status', headers: { Host: `127.0.0.1:${b.port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: sa.cookie, 'X-Vie-Token': sa.token } }); assert.equal(r2.status, 403, 'cookie nommé pour un autre port');
    const r3 = await rq(b.port, { url: '/api/agent/status', headers: { Host: `127.0.0.1:${b.port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: sb.cookie, 'X-Vie-Token': sb.token } }); assert.equal(r3.status, 200);
  } finally { await a.done(); await b.done(); }
});
check('plafond de sessions : au plus 8 vivantes (la plus ancienne est évincée) ; seul un ticket peut en créer une', async () => {
  const s = await boot({ limits: { exchangePerMinute: 1000 } });
  try {
    const list = []; for (let i = 0; i < 10; i++) list.push(await login(s.vie));
    const st = async x => (await rq(s.port, { url: '/api/agent/status', headers: { Host: `127.0.0.1:${s.port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: x.cookie, 'X-Vie-Token': x.token } })).status;
    assert.equal(await st(list[0]), 403); assert.equal(await st(list[1]), 403); assert.equal(await st(list[9]), 200); assert.equal(await st(list[2]), 200);
  } finally { await s.done(); }
});

// === 4. Agent / approbation / mode structure ===========================================================================================================
check('approbation AVANT authentification : un anonyme qui connaît exactement runId, id, nonce et empreinte de la carte ne peut ni approuver ni annuler ; rien n’est écrit', async () => {
  const home = path.join(tmp, 'home'); fs.mkdirSync(home, { recursive: true });
  const target = path.join(home, 'Documents', 'plan-boot.md'); fs.mkdirSync(path.dirname(target), { recursive: true });
  const fake = createFakeSdk({ script: async api => { const r = await api.use('mcp__vie__write_file', { path: target, content: '# plan\n' }); return 'r:' + r.allowed; }, cost: 0.01 });
  const s = await boot({ opts: { agent: { sdkLoader: fake.sdkLoader, home, cwd: home, backupRoot: path.join(tmp, 'bk2'), configDir: path.join(tmp, 'cfg2'), pdftotext: null } } });
  try {
    const u = await login(s.vie);
    const call = (m, p, b, h = u.headers()) => rq(s.port, { method: m, url: p, headers: h, body: b });
    assert.equal((await call('POST', '/api/agent/consent', { accept: true, v: 1 })).status, 200);
    const run = await call('POST', '/api/agent/run', { mode: 'custom', model: 'default', effort: 'medium', share: false, messages: [{ role: 'user', content: 'écris un plan' }], view: 'today', today: '2026-11-15' });
    assert.equal(run.status, 200, run.text); const runId = run.json.runId;
    let ap = null; for (let i = 0; i < 200 && !ap; i++) { const e = await call('GET', `/api/agent/events?run=${runId}&since=0`, undefined, { ...u.headers(), 'Content-Type': undefined }); ap = (e.json && e.json.events || []).find(x => x.type === 'approval'); if (!ap) await sleep(15); }
    assert.ok(ap, 'carte d’approbation émise'); assert.ok(!fs.existsSync(target));
    const body = { runId, id: ap.id, nonce: ap.nonce, hash: ap.hash, allow: true };
    const attackers = [{ ...same(s.port), 'Content-Type': 'application/json' }, { ...same(s.port), 'Content-Type': 'application/json', Cookie: `vie_sid_${s.port}=${crypto.randomBytes(24).toString('base64url')}`, 'X-Vie-Token': crypto.randomBytes(24).toString('base64url') },
      { ...same(s.port), 'Content-Type': 'application/json', 'X-Vie-Token': u.token }, { ...same(s.port), 'Content-Type': 'application/json', Cookie: u.cookie }];
    for (const h of attackers) { const r = await call('POST', '/api/agent/decision', body, h); assert.equal(r.status, 403, JSON.stringify(Object.keys(h))); assert.equal((await call('POST', '/api/agent/cancel', { runId }, h)).status, 403); }
    await sleep(100); assert.ok(!fs.existsSync(target), 'rien écrit sans l’approbation de la session propriétaire');
    const sessB = await login(s.vie);   // une AUTRE connexion légitime : voit « exécution inconnue », ne peut pas décider à la place de la première
    assert.equal((await call('POST', '/api/agent/decision', body, sessB.headers())).status, 404);
    assert.ok(!fs.existsSync(target));
    assert.equal((await call('POST', '/api/agent/decision', body)).status, 200, 'la session propriétaire peut approuver');
    for (let i = 0; i < 200 && !fs.existsSync(target); i++) await sleep(15); assert.ok(fs.existsSync(target));
  } finally { await s.done(); }
});
check('consentement de l’agent : tombe à la première connexion qui suit l’expiration de toutes les sessions ; une connexion voisine encore vivante ne le coupe pas', async () => {
  const home = path.join(tmp, 'home3'); fs.mkdirSync(home, { recursive: true });
  const fake = createFakeSdk({ script: async api => api.say('ok') });
  const s = await boot({ opts: { agent: { sdkLoader: fake.sdkLoader, home, cwd: home, backupRoot: path.join(tmp, 'bk3'), configDir: path.join(tmp, 'cfg3'), pdftotext: null } } });
  try {
    const a = await login(s.vie);
    assert.equal((await rq(s.port, { method: 'POST', url: '/api/agent/consent', headers: a.headers(), body: { accept: true, v: 1 } })).status, 200);
    const given = async () => (await s.vie.agent.status()).consent.given;
    assert.equal(await given(), true);
    await login(s.vie); assert.equal(await given(), true, 'session voisine vivante : consentement conservé');
    s.clock.t += 13 * 3600000;   // tout a expiré
    await login(s.vie); assert.equal(await given(), false, 'nouvelle connexion après expiration : à redonner');
  } finally { await s.done(); }
});
check('mode structure et agent HORS circuit par défaut, même authentifié : /api/code et /api/code/undo = 403 dev_disabled, dev:true = 403 dev_disabled, VIE_DEV dans .env ignoré ; agent sans consentement = 403', async () => {
  const envFile = path.join(tmp, 'fake-dev.env'); fs.writeFileSync(envFile, `ANTHROPIC_API_KEY=${FAKE_KEY}\nVIE_DEV=on\n`);
  const calls = [];
  const vie = createVieServer({ env: {}, envFile, fetch: trapFetch(calls), sleep: () => Promise.resolve(), log: () => {}, limits: { perMinute: 1000 } });
  const port = await vie.listen(0);
  try {
    assert.equal(vie.config.devEnabled, false);
    const u = await login(vie);
    for (const p of ['/api/code', '/api/code/undo']) { const r = await rq(port, { method: 'POST', url: p, headers: u.headers(), body: { id: 'a', nonce: 'b', hash: 'c', confirm: true } }); assert.equal(r.status, 403); assert.equal(r.json.error, 'dev_disabled'); }
    const c = await rq(port, { method: 'POST', url: '/api/chat', headers: u.headers(), body: { mode: 'rapide', share: false, dev: true, messages: [{ role: 'user', content: 'x' }], view: 'today', today: '2026-11-15' } });
    assert.equal(c.status, 403); assert.equal(c.json.error, 'dev_disabled'); assert.equal(calls.length, 0);
    const r = await rq(port, { method: 'POST', url: '/api/agent/run', headers: u.headers(), body: { mode: 'rapide', share: false, messages: [{ role: 'user', content: 'x' }], view: 'today', today: '2026-11-15' } });
    assert.equal(r.status, 403); assert.ok(['agent_consent_required', 'agent_disabled', 'sdk_missing'].includes(r.json.error) || r.json.error, r.text);
    assert.notEqual(r.status, 200);
  } finally { await vie.close(); }
});

// === 5. Lanceur : fragment seulement, jamais query / ligne de commande du serveur ===================================================================
check('vie-open : accepte http://127.0.0.1:PORT/ avec fragment #vie-boot=<43 car.> ; refuse query, autre hôte, autre chemin, ticket mal formé, schéma, espaces, injection ; argument unique sans shell', () => {
  const T = crypto.randomBytes(32).toString('base64url'); assert.equal(T.length, 43);
  const calls = []; const spawnImpl = (cmd, args, o) => { calls.push({ cmd, args, o }); return { on() {}, unref() {} }; };
  openBrowser(`http://127.0.0.1:3765/#vie-boot=${T}`, spawnImpl, 'win32'); openBrowser('http://127.0.0.1:3765/', spawnImpl, 'win32');
  assert.deepEqual(calls[0].args, ['/c', 'start', '', `http://127.0.0.1:3765/#vie-boot=${T}`]); assert.ok(!calls[0].o.shell, 'pas de shell'); assert.equal(calls[0].cmd, 'cmd');
  for (const bad of [`http://127.0.0.1:3765/?vie-boot=${T}`, `http://127.0.0.1:3765/?t=1#vie-boot=${T}`, `http://127.0.0.1:3765/x#vie-boot=${T}`, `http://localhost:3765/#vie-boot=${T}`, `http://127.0.0.1:3765/#vie-boot=${T.slice(1)}`, `http://127.0.0.1:3765/#vie-boot=${T}A`,
    `http://127.0.0.1:3765/#vie-boot=${T}&x=1`, `http://127.0.0.1:3765/#other=${T}`, `https://127.0.0.1:3765/#vie-boot=${T}`, `http://127.0.0.1:3765/#vie-boot=${T} & calc`, `http://127.0.0.1:3765/#vie-boot=${T}\n`, `http://127.0.0.1:3765/#vie-boot=${T.slice(0, 42)}%`, `http://127.0.0.1@evil.example/#vie-boot=${T}`, 42, null, undefined]) {
    assert.throws(() => openBrowser(bad, spawnImpl, 'win32'), /adresse non autorisée/, String(bad).slice(0, 70));
  }
  assert.equal(calls.length, 2);
});
check('amorçage navigateur (vie-boot.js, joué dans un contexte isolé) : fragment retiré AVANT l’échange, ticket posté en JSON (jamais en URL), jamais stocké ; fragment mal formé jeté ; sans fragment ou en file:// aucun échange', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'vie-boot.js'), 'utf8');
  const T = crypto.randomBytes(32).toString('base64url');
  const run = async (hash, protocol, answer = { status: 200, json: { ok: true, authenticated: true } }) => {
    const order = [], fetches = []; let storage = 0;
    const location = { hash, protocol, pathname: '/', search: '' };
    const history = { replaceState: (a, b, url) => { order.push('replace:' + url); location.hash = ''; } };
    const fetch = (url, init) => { order.push('fetch'); fetches.push({ url, init }); return Promise.resolve({ ok: answer.status === 200, status: answer.status, json: () => Promise.resolve(answer.json) }); };
    const ctx = { location, history, fetch, JSON, Promise, Object, localStorage: { setItem() { storage++; }, getItem() { storage++; } }, sessionStorage: { setItem() { storage++; }, getItem() { storage++; } }, document: { get cookie() { storage++; return ''; }, set cookie(v) { storage++; } }, console: { log() { storage++; }, error() { storage++; } } };
    ctx.window = ctx; vm.runInNewContext(src, ctx);
    const res = await ctx.VieBoot.ready; return { order, fetches, storage, res, frozen: Object.isFrozen(ctx.VieBoot) };
  };
  const ok = await run('#vie-boot=' + T, 'http:');
  assert.deepEqual(ok.order, ['replace:/', 'fetch'], 'adresse nettoyée avant tout appel réseau'); assert.equal(ok.fetches.length, 1);
  assert.equal(ok.fetches[0].url, '/api/auth/exchange'); assert.equal(ok.fetches[0].init.method, 'POST'); assert.equal(JSON.parse(ok.fetches[0].init.body).ticket, T);
  assert.ok(!ok.fetches[0].url.includes(T) && !String(ok.fetches[0].init.headers['content-type']).includes(T)); assert.equal(ok.storage, 0, 'ni stockage, ni cookie JS, ni console'); assert.equal(JSON.stringify(ok.res), JSON.stringify({ attempted: true, ok: true, status: 200 })); assert.ok(ok.frozen);
  const refused = await run('#vie-boot=' + T, 'http:', { status: 403, json: { ok: false, error: 'bad_ticket' } }); assert.equal(refused.res.ok, false); assert.equal(refused.res.attempted, true);
  for (const h of ['', '#today', '#vie-boot=court', '#vie-boot=' + T + 'x', '#x=vie-boot=' + T, '#vie-boot=' + T.replace(/.$/, '!')]) { const r = await run(h, 'http:'); assert.equal(r.fetches.length, 0, 'aucun échange pour ' + h.slice(0, 20)); assert.equal(r.res.attempted, false); assert.ok(!r.order.some(x => x === 'fetch')); }
  assert.deepEqual((await run('#vie-boot=court', 'http:')).order, ['replace:/'], 'fragment mal formé : jeté');
  const file = await run('#vie-boot=' + T, 'file:'); assert.equal(file.fetches.length, 0, 'file:// : aucun échange');
});
check('lanceurs .cmd : aucun secret ni ticket, aucun paramètre sensible ; le ticket naît dans le processus serveur ; vie-server.cjs : un seul Set-Cookie (l’échange), aucune route ne sert le ticket, aucun child_process', () => {
  for (const f of ['start-vie.cmd', 'start-vie-dev.cmd']) {
    const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(/node vie-server\.cjs --open\s*$/m.test(s), f); assert.ok(!/vie-boot|ticket|token|jeton\s*=|%RANDOM%|certutil|openssl|set\s+"?VIE_[A-Z_]*(SECRET|TICKET|TOKEN)/i.test(s.replace(/\brem\b.*$/gim, '')), f + ' : aucun secret dans le lanceur');
    assert.ok(!/ANTHROPIC_API_KEY=\S/.test(s));
  }
  const srv = fs.readFileSync(path.join(ROOT, 'vie-server.cjs'), 'utf8');
  const code = srv.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.equal((code.match(/Set-Cookie/g) || []).length, 1, 'Set-Cookie : uniquement dans handleExchange');
  assert.ok(!/child_process|spawn\(|exec(Sync)?\(/.test(srv)); assert.ok(!/fs\.(write|append|copy|rename|unlink|rm|mkdir)/i.test(srv));
  assert.equal((code.match(/issueLaunchTicket/g) || []).length, 3, 'déclaration, export et UN seul usage (connect(), appelé par --open et par Entrée dans la console) : aucun usage HTTP');
  assert.ok(!/process\.argv[^;]*vie-boot|console\.log\([^)]*ticket/i.test(code));
});

// === 6. Vrai processus : démarrage direct vs lancement --open (navigateur intercepté), copie jetable SANS le vrai .env ===============================
const FILES = ['vie-server.cjs', 'vie-open.cjs', 'vie-dev.cjs', 'vie-agent.cjs', 'vie-policy.cjs', 'vie-tools.cjs', 'vie-approvals.cjs', 'vie-proc.cjs', 'vie-actions.js', 'core.js', 'index.html', 'styles.css', 'app.js', 'vie-assistant.js', 'vie-agent-ui.js', 'vie-boot.js'];
function freePort() { return new Promise(res => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); }); }
function copyProject() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(tmp, 'proj-')));
  for (const f of FILES) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, '.env'), `ANTHROPIC_API_KEY=${FAKE_KEY}\nVIE_DEV=on\n`);   // faux .env jetable : VIE_DEV=on doit rester ignoré
  return dir;
}
async function runProc({ open, tty = false }) {
  const dir = copyProject(), port = await freePort(), out = path.join(tmp, 'spawn-' + crypto.randomBytes(4).toString('hex') + '.json');
  const hook = path.join(tmp, 'hook-' + crypto.randomBytes(4).toString('hex') + '.cjs');
  // Instrument de test uniquement : intercepte child_process.spawn (le navigateur n'est PAS lancé) et enregistre ses arguments ; le serveur n'a aucun mode « test ».
  fs.writeFileSync(hook, `const cp = require('node:child_process'); const fs = require('node:fs'); cp.spawn = (cmd, args, o) => { fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ cmd, args, o })); return { on() {}, unref() {} }; };\n`);
  if (tty) fs.appendFileSync(hook, "Object.defineProperty(process.stdin, 'isTTY', { value: true });\n");   // l'instrument présente stdin comme une console interactive (le test pousse « Entrée » par ce tube)
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: tmp, TMP: tmp, VIE_PORT: String(port) };
  const args = ['-r', hook, 'vie-server.cjs', ...(open ? ['--open'] : [])];
  const child = spawn(process.execPath, args, { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] }); track(child.pid, port, 'node vie-server.cjs' + (open ? ' --open' : ''));
  let stdout = '', stderr = ''; child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
  for (let i = 0; i < 300 && !/Arrêt/.test(stdout); i++) await sleep(20);
  assert.match(stdout, /Arrêt/, 'serveur démarré : ' + stdout + stderr);
  if (open) for (let i = 0; i < 100 && !fs.existsSync(out); i++) await sleep(20);
  return { child, port, dir, out, args, get stdout() { return stdout; }, get stderr() { return stderr; }, stop: async () => { const left = await stopTree(child.pid, port, 'node vie-server.cjs'); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* dossier encore verrouillé : sans importance */ } assert.deepEqual(left, [], 'processus de la suite encore vivants après l’arrêt : ' + left.join(',')); } };
}
check('VRAI processus, démarrage DIRECT (sans --open) : aucun navigateur ni ticket ; verrouillé ; instructions claires ; VIE_DEV du faux .env ignoré', async () => {
  const p = await runProc({ open: false });
  try {
    assert.ok(!fs.existsSync(p.out), 'aucun navigateur lancé'); assert.match(p.stdout, /AUCUN lien/); assert.match(p.stdout, /Entrée/); assert.match(p.stdout, /start-vie\.cmd/);
    const home = await rq(p.port, { url: '/', headers: { Host: `127.0.0.1:${p.port}`, 'Sec-Fetch-Site': 'none' } }); assert.equal(home.status, 200); assert.equal(home.headers['set-cookie'], undefined);
    const h = await rq(p.port, { url: '/api/health', headers: { Host: `127.0.0.1:${p.port}`, 'Sec-Fetch-Site': 'same-origin' } }); assert.equal(h.json.authenticated, false); assert.equal(h.json.token, null);
    for (const [m, u, b] of SENSITIVE(p.port)) { const r = await rq(p.port, { method: m, url: u, headers: { ...same(p.port), 'Content-Type': 'application/json' }, body: b }); assert.equal(r.status, 403, u); }
    assert.ok(!(p.stdout + p.stderr).includes(FAKE_KEY));
  } finally { await p.stop(); }
});
check('VRAI processus avec --open (spawn intercepté) : ticket UNIQUEMENT dans le fragment de l’URL passée au lanceur du navigateur ; absent de la console, des journaux, de l’environnement et de la ligne de commande de node ; échange réussi puis rejeu refusé ; session = agent/chat OK, mode structure OFF', async () => {
  const p = await runProc({ open: true });
  try {
    const sp = JSON.parse(fs.readFileSync(p.out, 'utf8'));
    assert.equal(sp.cmd, 'cmd'); assert.deepEqual(sp.args.slice(0, 3), ['/c', 'start', '']); assert.ok(!sp.o.shell);
    const m = /^http:\/\/127\.0\.0\.1:(\d+)\/#vie-boot=([A-Za-z0-9_-]{43})$/.exec(sp.args[3]); assert.ok(m, 'forme de l’URL : ' + sp.args[3].replace(/=.{43}$/, '=<ticket>'));
    assert.equal(Number(m[1]), p.port, 'port réel du serveur'); const ticket = m[2]; remember(ticket);
    assert.ok(!sp.args[3].includes('?'), 'pas de query');
    assert.ok(!(p.stdout + p.stderr).includes(ticket), 'ticket absent de la console'); assert.ok(!p.args.join(' ').includes(ticket), 'ticket absent de la ligne de commande de node'); assert.ok(!JSON.stringify(process.env).includes(ticket));
    assert.match(p.stdout, /usage unique/);
    const ex = await exchange(p.port, ticket); assert.equal(ex.status, 200);
    const cookie = String(ex.headers['set-cookie']).split(';')[0];
    const h = await rq(p.port, { url: '/api/health', headers: { Host: `127.0.0.1:${p.port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie } }); assert.equal(h.json.authenticated, true); assert.equal(h.json.keyConfigured, true); assert.equal(h.json.dev.enabled, false, 'VIE_DEV du .env ignoré');
    assert.equal((await exchange(p.port, ticket)).status, 403, 'rejeu refusé');
    const code = await rq(p.port, { method: 'POST', url: '/api/code', headers: { ...same(p.port), 'Content-Type': 'application/json', Cookie: cookie, 'X-Vie-Token': h.json.token }, body: { id: 'a', nonce: 'b', hash: 'c', confirm: true } }); assert.equal(code.json.error, 'dev_disabled');
    assert.ok(!(p.stdout + p.stderr).includes(ticket) && !(p.stdout + p.stderr).includes(h.json.token), 'toujours rien dans la console');
  } finally { await p.stop(); }
});

check('Entrée dans la console (stdin présenté comme console par l’instrument de test) : démarrage direct sans ticket ; Entrée émet un NOUVEAU ticket (le précédent est remplacé), jamais plus d’un navigateur par rafale ; sans console, stdin n’est pas écouté', async () => {
  const NL = String.fromCharCode(10);
  const p = await runProc({ open: false, tty: true });
  try {
    assert.ok(!fs.existsSync(p.out), 'rien avant Entrée');
    p.child.stdin.write(NL);
    for (let i = 0; i < 150 && !fs.existsSync(p.out); i++) await sleep(20);
    const m1 = /#vie-boot=([A-Za-z0-9_-]{43})$/.exec(JSON.parse(fs.readFileSync(p.out, 'utf8')).args[3]); assert.ok(m1, 'ticket émis après Entrée'); remember(m1[1]);
    fs.rmSync(p.out); p.child.stdin.write(NL + NL + NL); await sleep(400); assert.ok(!fs.existsSync(p.out), 'rafale d’Entrées (moins de 3 s) : pas de nouvel onglet');
    await sleep(3000); p.child.stdin.write(NL);
    for (let i = 0; i < 150 && !fs.existsSync(p.out); i++) await sleep(20);
    const m2 = /#vie-boot=([A-Za-z0-9_-]{43})$/.exec(JSON.parse(fs.readFileSync(p.out, 'utf8')).args[3]); assert.ok(m2 && m2[1] !== m1[1], 'nouveau ticket distinct'); remember(m2[1]);
    assert.equal((await exchange(p.port, m1[1])).status, 403, 'l’ancien lien est remplacé');
    assert.equal((await exchange(p.port, m2[1])).status, 200, 'le nouveau lien fonctionne');
    assert.ok(!(p.stdout + p.stderr).includes(m1[1]) && !(p.stdout + p.stderr).includes(m2[1]), 'tickets absents de la console');
  } finally { await p.stop(); }
  const q = await runProc({ open: false });   // stdin « pipe » non console : aucun écouteur, Entrée ne fait rien
  try { q.child.stdin.write(NL); await sleep(500); assert.ok(!fs.existsSync(q.out), 'sans console interactive, Entrée n’émet rien'); } finally { await q.stop(); }
});
check('LANCEUR RÉEL start-vie.cmd (Windows, copie jetable sans le vrai .env, navigateur intercepté par NODE_OPTIONS) : le ticket naît dans node, jamais dans le .cmd ; échange réussi ; rejeu refusé ; console propre ; Entrée non écoutée sans console', async () => {
  if (process.platform !== 'win32') { console.log('      NON TESTÉ : lanceur .cmd (Windows uniquement)'); return; }
  const dir = copyProject(); for (const f of ['start-vie.cmd']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  const port = await freePort(), out = path.join(tmp, 'spawn-cmd.json'), hook = path.join(tmp, 'hook-cmd.cjs');
  fs.writeFileSync(hook, `const cp = require('node:child_process'); const fs = require('node:fs'); cp.spawn = (cmd, args, o) => { fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ cmd, args, o })); return { on() {}, unref() {} }; };\n`);
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, TEMP: tmp, TMP: tmp, VIE_PORT: String(port), NODE_OPTIONS: `--require=${hook.replace(/\\/g, '/')}` };
  const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'start-vie.cmd'], { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); track(child.pid, port, 'cmd /c start-vie.cmd');
  let stdout = '', stderr = ''; child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
  try {
    for (let i = 0; i < 300 && !fs.existsSync(out); i++) await sleep(30);
    assert.ok(fs.existsSync(out), 'le lanceur a démarré le serveur et tenté d’ouvrir le navigateur : ' + stdout + stderr);
    const sp = JSON.parse(fs.readFileSync(out, 'utf8'));
    const m = /^http:\/\/127\.0\.0\.1:(\d+)\/#vie-boot=([A-Za-z0-9_-]{43})$/.exec(sp.args[3]); assert.ok(m, 'forme de l’URL'); assert.equal(Number(m[1]), port);
    const ticket = m[2]; remember(ticket);
    assert.ok(!stdout.includes(ticket) && !stderr.includes(ticket), 'ticket absent de la console du lanceur');
    assert.ok(!fs.readFileSync(path.join(dir, 'start-vie.cmd'), 'utf8').includes(ticket));
    const ex = await exchange(port, ticket); assert.equal(ex.status, 200); assert.equal((await exchange(port, ticket)).status, 403, 'rejeu refusé');
    const h = await rq(port, { url: '/api/health', headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: String(ex.headers['set-cookie']).split(';')[0] } });
    assert.equal(h.json.authenticated, true); assert.equal(h.json.dev.enabled, false);
  } finally { const left = await stopTree(child.pid, port, 'cmd /c start-vie.cmd'); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* dossier encore verrouillé : sans importance */ } assert.deepEqual(left, [], 'processus du lanceur encore vivants : ' + left.join(',')); }
});

// === 7. Aucun secret dans ce que le serveur a dit ====================================================================================================
check('aucun ticket ni identifiant de session n’apparaît dans les corps de réponse ni les journaux recueillis pendant toute cette suite ; aucun jeton CSRF ni clé API dans les journaux', () => {
  const bodies = ALL_TEXT.join(String.fromCharCode(10)), logs = LOGS.join(String.fromCharCode(10));
  assert.ok(SECRETS.size >= 8 && TOKENS.size >= 4, 'secrets suivis : ' + SECRETS.size + ' / ' + TOKENS.size);
  for (const x of SECRETS) { assert.ok(!bodies.includes(x), 'secret réapparu dans une réponse'); assert.ok(!logs.includes(x), 'secret réapparu dans un journal'); }
  for (const x of TOKENS) assert.ok(!logs.includes(x), 'jeton dans un journal');
  assert.ok(!bodies.includes(FAKE_KEY) && !logs.includes(FAKE_KEY), 'clé API');
});

check('B4 (QA passe 4) : aucun processus lancé par cette suite ne survit (PID suivis + descendants, ports fermés) ; les orphelins d’exécutions antérieures ne sont PAS touchés par la suite', async () => {
  assert.ok(SPAWNED.length >= 6, 'processus suivis : ' + SPAWNED.length);
  assert.ok(SPAWNED.some(x => /start-vie.cmd/.test(x.what) && x.pid) && SPAWNED.some(x => /--open/.test(x.what)), 'le lanceur .cmd et --open sont bien suivis');
  const alive = SPAWNED.filter(x => isAlive(x.pid)); assert.deepEqual(alive.map(x => x.what + ' pid ' + x.pid), [], 'survivants');
  for (const port of new Set(SPAWNED.map(x => x.port))) assert.ok(await portClosed(port), 'port ' + port + ' encore ouvert');
});

(async () => {
  let pass = 0, fail = 0;
  for (const { name, fn } of results) { try { await fn(); pass++; console.log('PASS  ' + name); } catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + String(e && e.stack || e).split('\n').slice(0, 5).join('\n      ')); } }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* nettoyage au mieux */ }
  console.log(`\n${pass}/${results.length} PASS${fail ? `, ${fail} FAIL` : ''}`);
  process.exit(fail ? 1 : 0);
})();
