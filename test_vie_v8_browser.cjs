// Parcours V8 dans un VRAI navigateur (Chrome ou Edge, profil JETABLE) : interruption RÉELLE vue de l'interface (Annuler / Révoquer pendant une commande approuvée -> reçu « Interrompue »,
// processus du moteur tué), bandeau « Agent local inactif » avec bouton « Révoquer », resynchronisation au retour sur l'onglet. Vrai serveur vie-server.cjs (127.0.0.1), FAUX SDK
// (fake_agent_sdk.cjs) mais VRAI contrôleur de processus (vie-proc.cjs : le « moteur » est un vrai processus Node dormant, vraiment terminé) ; la « commande » est un simulateur.
// Aucun réseau Internet, aucun coût, aucune vraie clé, aucun .env réel, répertoire TEMPORAIRE synthétique.
//   node test_vie_v8_browser.cjs "C:\Program Files\Google\Chrome\Application\chrome.exe"
//   node test_vie_v8_browser.cjs "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createVieServer } = require('./vie-server.cjs');
const { createFakeSdk } = require('./fake_agent_sdk.cjs');
const { login } = require('./test_vie_auth.cjs');
const http = require('node:http');

const exe = process.argv[2];
if (!exe || !fs.existsSync(exe)) { console.log('NON TESTÉ : chemin du navigateur absent ou introuvable (argument 1).'); process.exit(2); }
const FAKE_KEY = 'FAKE-BROWSER-V8-KEY-NOT-A-SECRET-0123456789';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vie-v8-browser-')));
const profile = path.join(tmp, 'profile'), home = path.join(tmp, 'home'), backups = path.join(tmp, 'backups');
for (const d of [profile, home, backups]) fs.mkdirSync(d, { recursive: true });
const mk = (p, c) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); return p; };
const COURSE1 = mk(path.join(home, 'Cours', 'algo.md'), '# Algorithmique (cours synthétique)\nSéance : lundi 08:00-10:00. Chapitres : tri fusion, complexité.\nExamen le 2026-12-15.\n');
mk(path.join(home, 'Cours', 'maths.md'), '# Analyse (cours synthétique)\nSéance : mercredi 14:00-16:00. Chapitres : suites, séries.\n');
mk(path.join(home, '.env'), 'ANTHROPIC_API_KEY=FAKE-ENV-NOT-REAL-9876543210\n');
const repoDir = path.join(home, 'Documents', 'projet-git'); mk(path.join(repoDir, '.git', 'config'), '[core]\n'); mk(path.join(repoDir, 'README.md'), 'projet synthétique\n');
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };

async function launch() {
  const proc = spawn(exe, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let info = null;
  for (let i = 0; i < 150 && !info; i++) { await sleep(100); try { const [port, p] = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/); if (port && p) info = { port, p }; } catch (e) { /* pas encore */ } }
  if (!info) throw new Error('DevToolsActivePort introuvable');
  const ws = new WebSocket(`ws://127.0.0.1:${info.port}${info.p}`);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(Error('connexion DevTools impossible')); });
  let id = 0; const pending = new Map(), handlers = [];
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(Error(m.error.message)) : res(m.result); } else handlers.forEach(h => h(m)); };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  return { proc, ws, send, on: h => handlers.push(h), closed: new Promise(r => proc.once('exit', r)) };
}
async function openPage(b) {
  const { targetId } = await b.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await b.send('Target.attachToTarget', { targetId, flatten: true });
  const exceptions = [], errors = [], requests = [], dialogs = [];
  const s = (m, p) => b.send(m, p, sessionId);
  b.on(m => {
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Runtime.exceptionThrown') { const d = 'exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); exceptions.push(d); errors.push(d); }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console.error: ' + m.params.args.map(a => a.value ?? a.description).join(' '));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push('log: ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
    if (m.method === 'Network.requestWillBeSent') requests.push({ url: m.params.request.url, method: m.params.request.method });
    if (m.method === 'Page.javascriptDialogOpening') { dialogs.push(m.params.message); s('Page.handleJavaScriptDialog', { accept: true }); }
  });
  for (const d of ['Page', 'Runtime', 'Log', 'DOM', 'Network']) await s(d + '.enable');
  const page = {
    errors, exceptions, requests, dialogs, cdp: s,
    async goto(url) { const loaded = new Promise(r => b.on(m => { if (m.sessionId === sessionId && m.method === 'Page.loadEventFired') r(); })); await s('Page.navigate', { url }); await loaded; await sleep(200); },
    async ev(expression) { const r = await s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error('evaluate: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result.value; },
    click: sel => page.ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)throw Error('introuvable: '+${JSON.stringify(sel)});e.click();return true;})()`),
    fill: (sel, v) => page.ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)throw Error('introuvable: '+${JSON.stringify(sel)});e.value=${JSON.stringify(v)};e.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`),
    async waitFor(expr, ms = 9000) { for (let t = 0; t < ms; t += 80) { let v = false; try { v = await page.ev(expr); } catch (e) { /* transition */ } if (v) return true; await sleep(80); } return false; },
    async realClick(sel) {
      const r = await page.ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)throw Error('introuvable: '+${JSON.stringify(sel)});e.scrollIntoView({block:'center',behavior:'instant'});const b=e.getBoundingClientRect();return{x:b.left+b.width/2,y:b.top+b.height/2}})()`);
      await s('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y }); await s('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 }); await s('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
      return r;
    },
    async realClickWhen(sel, ms = 6000) { if (!(await page.waitFor(`!!document.querySelector(${JSON.stringify(sel)})`, ms))) { console.log('DIAG panneau agent : ' + JSON.stringify(await page.ev(`(document.querySelector('#vie-agent')||{innerText:'(absent)'}).innerText.slice(0,600)`))); throw Error('introuvable (attente) : ' + sel); } return page.realClick(sel); },
    // Clic réel qui vérifie son EFFET (la page se redessine pendant qu'on clique : un clic peut tomber à côté) ; réessaie, mais jamais si l'effet est déjà là.
    async clickUntil(sel, cond, tries = 4) { for (let i = 0; i < tries; i++) { if (await page.waitFor(cond, 150)) return true; await page.realClickWhen(sel); if (await page.waitFor(cond, 2500)) return true; if (i > 0) console.log('  (nouvel essai de clic : ' + sel + ' #' + i + ')'); } return false; },
    async viewport(width, height = 800) { await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 500 }); await sleep(200); },
    stored: () => page.ev(`localStorage.getItem('vie-personal-v1')`),
    state: async () => { const j = await page.stored(); return j ? JSON.parse(j) : { goals: [] }; },
    async offline(on) { await s('Network.emulateNetworkConditions', { offline: !!on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); },
  };
  return page;
}
const hasText = (sel, txt) => `(document.querySelector(${JSON.stringify(sel)})||{innerText:''}).innerText.includes(${JSON.stringify(txt)})`;
const mockFetch = async () => new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Réponse du chat classique.' }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 20 } }), { status: 200, headers: { 'content-type': 'application/json' } });
const lastAgentMsg = `[...document.querySelectorAll('#vie-log .vie-msg.bot.agent')].at(-1)`;
const GOAL1 = 'Réviser le tri fusion avant l’examen du 15 décembre', GOAL2 = 'Objectif refusé : lire tout le cours en une nuit';
function rawPost(c, p, body, over = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body)); const h = { host: `127.0.0.1:${c.port}`, cookie: c.cookie, 'x-vie-token': c.token, 'sec-fetch-site': 'same-origin', origin: `http://127.0.0.1:${c.port}`, 'content-type': 'application/json', 'content-length': data.length, ...over };
    const r = http.request({ host: '127.0.0.1', port: c.port, method: 'POST', path: p, agent: false, headers: h }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); r.on('error', reject); r.write(data); r.end();
  });
}


(async () => {
  console.log(`Navigateur : ${exe}\nProfil jetable : ${profile}`);
  const shellRuns = []; let hold = null;
  const fake = createFakeSdk({
    shell: async c => { shellRuns.push(c); if (hold) await hold.promise; return { out: 'ok' }; },
    script: async api => { const r = await api.use('PowerShell', { command: 'Write-Output SYNTHETIC_ONLY' }); return 'Commande : ' + (r.allowed ? 'autorisée' : 'refusée'); },
  });
  const mkServer = (limits = { perMinute: 1000 }) => createVieServer({ env: { ANTHROPIC_API_KEY: FAKE_KEY }, envFile: path.join(tmp, 'absent.env'), fetch: mockFetch, log: () => {}, limits, agent: { sdkLoader: fake.sdkLoader, home, cwd: home, backupRoot: backups, configDir: path.join(tmp, 'cfg'), pdftotext: null, approvalTtlMs: 60000 } });
  let vie = mkServer(); const port = await vie.listen(0); const URL_APP = `http://127.0.0.1:${port}/`;
  const b = await launch();
  const page = await openPage(b); await page.viewport(1200, 800);
  const enterAgent = async p => { await p.click('#vie-launch'); await p.waitFor(`document.querySelector('#vie-send').disabled===false||/verrouillé/.test(document.querySelector('#vie-status').innerText)`); await p.click('[data-mode="agent"]'); return p.waitFor(`document.querySelector('[data-mode="agent"]').getAttribute('aria-pressed')==='true'&&!document.querySelector('#vie-agent').hidden`); };
  const send = async text => { await page.fill('#vie-input', text); await page.click('#vie-send'); };
  const newHold = () => { let release; const promise = new Promise(r => { release = r; }); hold = { promise, release }; };
  const unlock = async () => { await page.goto(URL_APP); await page.goto('about:blank'); await page.goto(URL_APP + '#vie-boot=' + vie.issueLaunchTicket()); await enterAgent(page); if (await page.ev(`!!document.querySelector('[data-ag="consent-accept"]')`)) await page.clickUntil('[data-ag="consent-accept"]', hasText('#vie-agent', 'Agent actif')); return page.waitFor(hasText('#vie-agent', 'Agent actif')); };
  const startCommand = async () => { shellRuns.length = 0; newHold(); await send('lance un diagnostic'); await page.waitFor(`!!document.querySelector('[data-ag="approve"]')`, 15000); await page.clickUntil('[data-ag="approve"]', `/approuvée/.test(${lastAgentMsg}.innerText)`); return page.waitFor(`/approuvée/.test(${lastAgentMsg}.innerText)&&${'true'}`, 8000); };
  const liveProcs = () => [...vie.agent._runs.values()].map(r => r.proc && r.proc.pid).filter(Boolean);
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  const gone = async pid => { for (let i = 0; i < 50; i++) { if (!alive(pid)) return true; await sleep(100); } return false; };

  check('A. déverrouillage et consentement', await unlock());
  // --- B. « Annuler » pendant la commande : le processus du moteur est RÉELLEMENT tué ; la carte et le reçu le disent ---
  await startCommand(); const pid1 = liveProcs().at(-1);
  check('B. la commande est « partie » (simulateur appelé), le processus du moteur existe et vit', shellRuns.length === 1 && Number.isInteger(pid1) && alive(pid1), 'pid ' + pid1);
  const cancelSel = await page.ev(`(()=>{for(const s of ['[data-vie="cancel"]','[data-ag="cancel"]','#vie-cancel','[data-act="cancel"]','#vie-stop']){if(document.querySelector(s))return s}return null})()`);
  check('B. un bouton « Annuler » est proposé pendant la commande', !!cancelSel, String(cancelSel));
  if (cancelSel) await page.clickUntil(cancelSel, `/Annulé/.test(${lastAgentMsg}.innerText)`);
  check('B. après « Annuler » : « Annulé », reçu « ⏹ Interrompue », carte « approuvée puis INTERROMPUE », jamais « exécutée » ni « ✓ Fait »', await page.waitFor(`/Annulé/.test(${lastAgentMsg}.innerText)&&/⏹ Interrompue/.test(${lastAgentMsg}.innerText)&&/approuvée puis INTERROMPUE/.test(${lastAgentMsg}.innerText)&&!/approuvée et exécutée/.test(${lastAgentMsg}.innerText)&&!/✓ Fait/.test(${lastAgentMsg}.innerText)`, 12000));
  check('B. le processus du moteur est réellement terminé côté système (pas seulement l\'état de l\'interface)', await gone(pid1));
  hold.release(); hold = null;
  check('B. le consentement reste actif (Annuler n\'est pas Révoquer) et le moteur n\'est pas marqué dangereux', (await vie.agent.status()).consent.given === true && (await vie.agent.status()).unsafe === false);

  // --- C. « Révoquer » pendant la commande ---
  await page.waitFor(hasText('#vie-agent', 'Agent actif')); await startCommand(); const pid2 = liveProcs().at(-1);
  await page.ev(`(()=>{const d=document.querySelector('#vie-agent details');if(d)d.open=true;return true})()`);
  await page.clickUntil('[data-ag="consent-revoke"]', hasText('#vie-agent', 'Autoriser le mode Agent'));
  check('C. « Révoquer » : consentement retiré côté serveur, processus du moteur terminé, aucune alerte d\'échec', await page.waitFor(hasText('#vie-agent', 'Autoriser le mode Agent'), 8000) && (await vie.agent.status()).consent.given === false && await gone(pid2) && await page.ev(`!document.querySelector('.vie-ag-alert')`));
  check('C. le reçu de la commande affiche « ⏹ Interrompue » dans la conversation', await page.waitFor(`/⏹ Interrompue/.test(${lastAgentMsg}.innerText)`, 8000));
  hold.release(); hold = null;

  // --- D. Resynchronisation : un onglet resté ouvert affichait « Agent actif » alors qu'un autre client a révoqué ---
  await page.clickUntil('[data-ag="consent-accept"]', hasText('#vie-agent', 'Agent actif'));
  check('D. avant : l\'onglet affiche « Agent actif »', await page.ev(hasText('#vie-agent', 'Agent actif')));
  vie.agent.setConsent(false);   // révocation faite ailleurs (autre onglet / autre client)
  check('D. onglet périmé : toujours « Agent actif » tant qu\'il ne s\'est pas resynchronisé (état réel avant le correctif)', await page.ev(hasText('#vie-agent', 'Agent actif')));
  await sleep(1100); await page.ev(`window.dispatchEvent(new Event('focus'))`);
  check('D. au retour sur l\'onglet (focus) : l\'interface se resynchronise et propose le consentement (plus « Agent actif »)', await page.waitFor(hasText('#vie-agent', 'Autoriser le mode Agent'), 6000));
  await page.clickUntil('[data-ag="consent-accept"]', hasText('#vie-agent', 'Agent actif')); await sleep(1100);
  vie.agent.setConsent(false); await page.ev(`document.dispatchEvent(new Event('visibilitychange'))`);
  check('D. au retour de visibilité (visibilitychange) : même resynchronisation', await page.waitFor(hasText('#vie-agent', 'Autoriser le mode Agent'), 6000));
  await page.clickUntil('[data-ag="consent-accept"]', hasText('#vie-agent', 'Agent actif'));

  // --- E. Serveur injoignable : « Agent local inactif » mais le bouton « Révoquer l'accès » reste proposé (consentement connu) ---
  await vie.close(); await sleep(1100);
  await page.ev(`window.dispatchEvent(new Event('focus'))`);
  check('E. serveur arrêté : bandeau « Agent local inactif » + boutons « Réessayer » ET « Révoquer l\'accès aux fichiers »', await page.waitFor(`${hasText('#vie-agent', 'Agent local inactif')}&&!!document.querySelector('#vie-agent [data-ag="retry"]')&&!!document.querySelector('#vie-agent [data-ag="consent-revoke"]')`, 8000));
  await page.clickUntil('[data-ag="consent-revoke"]', `!!document.querySelector('.vie-ag-alert')`);
  check('E. « Révoquer » sans serveur : échec affiché de façon explicite (alerte « NON enregistrée »), jamais un faux « révoqué »', await page.waitFor(`!!document.querySelector('.vie-ag-alert')&&/NON enregistrée/.test(document.querySelector('.vie-ag-alert').innerText)`, 8000));
  vie = mkServer(); await vie.listen(port);

  const outside = page.requests.filter(r => !/^(http:\/\/127\.0\.0\.1:\d+\/|data:|about:|file:)/.test(r.url));
  check('aucune requête hors de 127.0.0.1 (pas d\'Internet depuis le navigateur)', outside.length === 0, outside.slice(0, 3).map(r => r.url).join(','));
  check('aucune exception JavaScript pendant tout le parcours', page.exceptions.length === 0, page.exceptions.slice(0, 2).join(' | '));
  await vie.close();
  try { b.ws.close(); b.proc.kill(); } catch (e) { /* déjà fermé */ }
  await Promise.race([b.closed, sleep(3000)]);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* profil encore verrouillé : sans importance */ }
  const ok = results.filter(r => r.ok).length;
  console.log(`\n${ok}/${results.length} PASS${ok === results.length ? '' : ' — ÉCHECS : ' + results.filter(r => !r.ok).map(r => r.name).join(' | ')}`);
  process.exit(ok === results.length ? 0 : 1);
})().catch(e => { console.error(e); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (x) { /* ignoré */ } process.exit(1); });
