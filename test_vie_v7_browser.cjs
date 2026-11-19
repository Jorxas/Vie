// Parcours pratique V7 dans un VRAI navigateur (Chrome ou Edge, profil JETABLE) : onboarding -> consentement -> lecture de cours SYNTHÉTIQUES -> propositions d'objectifs / planning
// -> confirmation / refus -> persistance -> révocation / redémarrage / hors ligne ; plus les trois correctifs V7 vus de l'interface (quota épuisé + « Révoquer », carte « exécutée »,
// refus de déplacer un dépôt). Vrai serveur vie-server.cjs dans ce processus (sockets 127.0.0.1), FAUX SDK (fake_agent_sdk.cjs), faux Anthropic piégé : aucun réseau Internet,
// aucun coût, aucune vraie clé, aucun .env réel, aucune commande Windows réelle (la « commande » est un simulateur), répertoire TEMPORAIRE synthétique.
//   node test_vie_v7_browser.cjs "C:\Program Files\Google\Chrome\Application\chrome.exe"
//   node test_vie_v7_browser.cjs "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
// Ne prouve PAS le comportement du vrai SDK ni la qualité d'une analyse faite par un vrai modèle.
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
const FAKE_KEY = 'FAKE-BROWSER-V7-KEY-NOT-A-SECRET-0123456789';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vie-v7-browser-')));
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
  let scenario = 'courses'; let hold = null; const shellRuns = [];
  const fake = createFakeSdk({
    shell: async c => { shellRuns.push(c); if (hold) await hold.promise; return { out: 'ok' }; },
    script: async api => {
      if (scenario === 'courses') {
        await api.use('mcp__vie__list_dir', { path: path.join(home, 'Cours') });
        await api.use('mcp__vie__read_file', { path: COURSE1 });
        await api.use('mcp__vie__read_file', { path: path.join(home, 'Cours', 'maths.md') });
        return 'J’ai lu tes deux cours : l’examen d’algorithmique est le 15 décembre. Je te propose deux objectifs et je recalcule ta semaine.\n```vie-proposals\n' + JSON.stringify([
          { name: 'propose_create', input: { entity: 'goals', values: [{ field: 'title', value: GOAL1 }, { field: 'horizon', value: 'Semestre' }, { field: 'metric', value: '3 séances de 1 h par semaine' }], reason: 'cours algo.md' } },
          { name: 'propose_create', input: { entity: 'goals', values: [{ field: 'title', value: GOAL2 }], reason: 'test de refus' } },
          { name: 'replan_week', input: { reason: 'nouvelles séances' } },
        ]) + '\n```';
      }
      if (scenario === 'shell') { const r = await api.use('PowerShell', { command: 'Write-Output SYNTHETIC_ONLY' }); return 'Commande : ' + (r.allowed ? 'autorisée' : 'refusée'); }
      if (scenario === 'move') { const r = await api.use('mcp__vie__move_path', { from: repoDir, to: path.join(home, 'Documents', 'projet-git-renomme') }); return 'Déplacement : ' + (r.allowed ? 'autorisé' : 'refusé'); }
      return 'rien';
    },
  });
  const mkServer = (limits = { perMinute: 1000 }) => createVieServer({ env: { ANTHROPIC_API_KEY: FAKE_KEY }, envFile: path.join(tmp, 'absent.env'), fetch: mockFetch, log: () => {}, limits, agent: { sdkLoader: fake.sdkLoader, home, cwd: home, backupRoot: backups, configDir: path.join(tmp, 'cfg'), pdftotext: null, approvalTtlMs: 60000 } });
  let vie = mkServer(); const port = await vie.listen(0); const URL_APP = `http://127.0.0.1:${port}/`;
  const b = await launch();
  const page = await openPage(b); await page.viewport(1200, 800);
  const enterAgent = async p => { await p.click('#vie-launch'); await p.waitFor(`document.querySelector('#vie-send').disabled===false||/verrouillé/.test(document.querySelector('#vie-status').innerText)`); await p.click('[data-mode="agent"]'); return p.waitFor(`document.querySelector('[data-mode="agent"]').getAttribute('aria-pressed')==='true'&&!document.querySelector('#vie-agent').hidden`); };
  const send = async text => { await page.fill('#vie-input', text); await page.click('#vie-send'); };

  // --- A. Onboarding : première visite, stockage vide, serveur lancé « à la main » (aucun lien de connexion) ---
  await page.goto(URL_APP);
  check('A. première visite sans lien de connexion : le site fonctionne (10 rubriques, stockage vide, aucune erreur JS)', (await page.ev(`document.querySelectorAll('button.nav-btn').length`)) === 10 && page.exceptions.length === 0);
  await page.click('#vie-launch');
  check('A. l’assistant est verrouillé avec la marche à suivre ; envoi désactivé ; aucun cookie de session', await page.waitFor(`/verrouillé/.test(document.querySelector('#vie-status').innerText)&&document.querySelector('#vie-send').disabled===true`) && (await page.ev('document.cookie')) === '');
  await page.goto('about:blank'); await page.goto(URL_APP + '#vie-boot=' + vie.issueLaunchTicket()); await page.click('#vie-launch');
  check('A. avec le lien de lancement à usage unique : assistant déverrouillé, fragment retiré de l’adresse', await page.waitFor(`!/verrouillé/.test(document.querySelector('#vie-status').innerText)&&document.querySelector('#vie-send').disabled===false`) && !(await page.ev('location.href')).includes('vie-boot'));
  const goals0 = (await page.state()).goals.length;

  // --- B. Mode Ordinateur : consentement, lecture de cours synthétiques, propositions ---
  await page.click('[data-mode="agent"]');
  check('B. mode Ordinateur : carte de consentement, envoi bloqué avant autorisation', await page.waitFor(hasText('#vie-agent', 'Autoriser le mode Agent')) && await page.ev(`document.querySelector('#vie-send').disabled===true`));
  await page.clickUntil('[data-ag="consent-accept"]', hasText('#vie-agent', 'Agent actif'));
  check('B. après « J’autorise » : agent actif, envoi possible', await page.waitFor(hasText('#vie-agent', 'Agent actif')) && await page.ev(`document.querySelector('#vie-send').disabled===false`));
  await send('analyse mes cours et adapte mes objectifs et mon planning');
  check('B. lecture des cours : dossier listé, deux fichiers lus, aucune carte d’approbation (lecture seule), réponse finale affichée', await page.waitFor(`/Terminé/.test(${lastAgentMsg}.innerText)&&/l’examen d’algorithmique est le 15 décembre/.test(${lastAgentMsg}.innerText)`, 15000) && await page.ev(`document.querySelectorAll('[data-ag="approve"]').length===0&&/algo\\.md/.test(document.querySelector('#vie-agent').innerText)||/algo\\.md/.test(${lastAgentMsg}.innerText)`));
  check('B. objectifs/planning proposés : deux cartes en attente (texte exact), semaine recalculée affichée ; RIEN n’est encore enregistré', await page.waitFor(`document.querySelectorAll('.vie-card.pending').length===2&&/Semaine du/.test(document.querySelector('#vie-log').innerText)`) && await page.ev(`[...document.querySelectorAll('.vie-card.pending')].some(c=>c.innerText.includes(${JSON.stringify(GOAL1)}))`) && (await page.state()).goals.length === goals0);
  // --- C. Confirmation / refus / persistance ---
  await page.clickUntil('.vie-card.pending [data-vie="apply"]', `!!document.querySelector('.vie-card.applied')`);
  if (process.env.DBG) console.log('DBG card:', await page.ev(`[...document.querySelectorAll('.vie-card')].map(c=>c.className+' | '+c.innerText.slice(0,300)).join(' ||| ')`), 'DIALOGS', JSON.stringify(page.dialogs), 'GOALS', JSON.stringify((await page.state()).goals), 'KEYS', await page.ev('Object.keys(localStorage).join(",")'));
  check('C. confirmation de la 1re carte : objectif enregistré (stockage), carte « Appliqué »', await page.waitFor(`!!document.querySelector('.vie-card.applied')`) && await (async () => { for (let i = 0; i < 40; i++) { if ((await page.state()).goals.some(g => g.title === GOAL1 && g.horizon === 'Semestre')) return true; await sleep(100); } return false; })());
  await page.clickUntil('.vie-card.pending [data-vie="refuse"]', `!!document.querySelector('.vie-card.refused')`);
  check('C. refus de la 2e carte : carte « Refusé », objectif absent du stockage', await page.waitFor(`!!document.querySelector('.vie-card.refused')`) && !(await page.state()).goals.some(g => g.title === GOAL2));
  check('C. rien de la conversation de l’agent ni du contenu des cours dans localStorage', await page.ev(`(()=>{const all=Object.keys(localStorage).map(k=>localStorage.getItem(k)).join('\\n');return !all.includes('Séance : lundi')&&!all.includes('analyse mes cours')})()`));
  await page.goto(URL_APP);   // rechargement (session conservée par le cookie)
  await page.click('#nav [data-view="goals"]');
  check('C. persistance : après rechargement, l’objectif confirmé est affiché dans « Objectifs » et le refusé n’existe pas', await page.ev(`document.querySelector('main').innerText.includes(${JSON.stringify(GOAL1)})&&!document.querySelector('main').innerText.includes(${JSON.stringify(GOAL2)})`));

  // --- D. P3 : carte « approuvée » vs « exécutée » (commande simulée suspendue) ---
  await page.click('#vie-launch').catch(() => {}); await page.waitFor(`!document.querySelector('#vie-panel').hidden`); await page.click('[data-mode="agent"]');
  await page.waitFor(hasText('#vie-agent', 'Agent actif') + '||' + hasText('#vie-agent', 'Autoriser le mode Agent'));
  if (await page.ev(`!!document.querySelector('[data-ag="consent-accept"]')`)) await page.clickUntil('[data-ag="consent-accept"]', hasText('#vie-agent', 'Agent actif'));
  await page.waitFor(hasText('#vie-agent', 'Agent actif'));
  scenario = 'shell'; hold = (() => { let release; const promise = new Promise(r => { release = r; }); return { promise, release }; })();
  await send('lance un diagnostic');
  await page.waitFor(`!!document.querySelector('[data-ag="approve"]')`, 15000);
  await page.clickUntil('[data-ag="approve"]', `/approuvée/.test(${lastAgentMsg}.innerText)`);
  await page.waitFor(`/approuvée/.test(${lastAgentMsg}.innerText)`, 8000);
  const during = await page.ev(`(()=>{const m=${lastAgentMsg};const c=m.querySelector('.vie-ag-card');return{label:c.querySelector('.vie-state').innerText,hasDone:/✓ Fait/.test(m.innerText),exec:/exécutée/.test(c.innerText)}})()`);
  check('D. P3 : commande approuvée mais pas encore terminée : la carte n’affirme PAS « exécutée », aucun reçu « Fait »', /approuvée/.test(during.label) && !during.exec && !during.hasDone && shellRuns.length === 1, JSON.stringify(during));
  hold.release(); hold = null;
  check('D. P3 : une fois le reçu arrivé : « approuvée et exécutée » + reçu « ✓ Fait »', await page.waitFor(`/approuvée et exécutée/.test(${lastAgentMsg}.innerText)&&/✓ Fait/.test(${lastAgentMsg}.innerText)`, 12000));

  // --- E. P2 : dépôt Git refusé ---
  scenario = 'move';
  await send('renomme mon dossier de projet');
  check('E. P2 : move_path d’un dossier contenant .git : AUCUNE carte, refus explicite visible, dossier intact', await page.waitFor(`/Déplacement : refusé/.test(${lastAgentMsg}.innerText)&&/Refusé par la politique/.test(${lastAgentMsg}.innerText)&&/\\.git/.test(${lastAgentMsg}.innerText)`, 15000) && await page.ev(`document.querySelectorAll('[data-ag="approve"]').length===0`) && fs.existsSync(path.join(repoDir, '.git', 'config')) && !fs.existsSync(path.join(home, 'Documents', 'projet-git-renomme')));

  // --- F. Révocation ---
  await page.ev(`(()=>{const d=document.querySelector('#vie-agent details');if(d)d.open=true;return true})()`);
  await page.clickUntil('[data-ag="consent-revoke"]', hasText('#vie-agent', 'Autoriser le mode Agent'));
  check('F. « Révoquer » : retour à la carte de consentement, envoi bloqué, serveur sans consentement, aucune alerte d’échec', await page.waitFor(hasText('#vie-agent', 'Autoriser le mode Agent')) && await page.ev(`document.querySelector('#vie-send').disabled===true&&!document.querySelector('.vie-ag-alert')`) && (await vie.agent.status()).consent.given === false);

  // --- G. Redémarrage du serveur (même port) : ancien cookie refusé, consentement perdu, données conservées ---
  await vie.close(); vie = mkServer(); await vie.listen(port);
  await page.goto(URL_APP); await page.click('#vie-launch');
  check('G. redémarrage : l’ancienne session est refusée (verrouillé), le site et les objectifs enregistrés restent intacts', await page.waitFor(`/verrouillé/.test(document.querySelector('#vie-status').innerText)&&document.querySelector('#vie-send').disabled===true`) && (await page.state()).goals.some(g => g.title === GOAL1));
  await page.goto('about:blank'); await page.goto(URL_APP + '#vie-boot=' + vie.issueLaunchTicket()); await enterAgent(page);
  check('G. après reconnexion : le consentement de l’agent est à REDONNER (aucun consentement hérité du processus précédent)', await page.waitFor(hasText('#vie-agent', 'Autoriser le mode Agent')) && (await vie.agent.status()).consent.given === false);

  // --- H. Hors ligne ---
  await page.offline(true);
  await page.click('[data-mode="chat"]'); await send('Bonjour hors ligne'); await sleep(900);
  check('H. hors ligne (réseau coupé dans le navigateur) : aucune exception JavaScript, l’interface reste utilisable (navigation entre rubriques)', page.exceptions.length === 0 && await page.ev(`(()=>{document.querySelector('#nav [data-view="week"]').click();return document.querySelectorAll('button.nav-btn').length===10})()`), page.exceptions.slice(0, 2).join(' | '));
  await page.offline(false);
  const off = await openPage(b);
  await off.goto('file:///' + path.join(__dirname, 'index.html').replace(/\\/g, '/')); await off.click('#vie-launch'); await off.click('[data-mode="agent"]');
  check('H. site ouvert hors serveur (file://) : 10 rubriques, mode Agent « nécessite le serveur local », aucune exception', await off.waitFor(`/nécessite le serveur local/.test(document.querySelector('#vie-agent').innerText)`) && await off.ev(`document.querySelectorAll('button.nav-btn').length===10`) && off.exceptions.length === 0);

  // --- I. P1 #1 : quota ordinaire épuisé, l'utilisateur peut toujours « Révoquer » et l'agent est arrêté ---
  await vie.close(); vie = mkServer({ perMinute: 6 }); const port2 = await vie.listen(0);
  const p2 = await openPage(b); await p2.viewport(1200, 800);
  await p2.goto(`http://127.0.0.1:${port2}/#vie-boot=${vie.issueLaunchTicket()}`); await enterAgent(p2);
  await p2.waitFor(hasText('#vie-agent', 'Autoriser le mode Agent')); await p2.clickUntil('[data-ag="consent-accept"]', hasText('#vie-agent', 'Agent actif'));
  scenario = 'shell'; shellRuns.length = 0; hold = null;
  await p2.fill('#vie-input', 'lance un diagnostic'); await p2.click('#vie-send'); await p2.waitFor(`!!document.querySelector('[data-ag="approve"]')`, 15000);
  const sess2 = await login(vie); const c2 = { port: port2, cookie: sess2.cookie, token: sess2.token };
  let n429 = 0; for (let i = 0; i < 12; i++) if (await rawPost(c2, '/api/agent/scope/clear', {}) === 429) n429++;
  check('I. le quota ordinaire est bien épuisé (requêtes ordinaires = 429)', n429 >= 1, 'refus 429 : ' + n429);
  if (process.env.DBG) console.log('DBG p2 agent panel:', JSON.stringify(await p2.ev(`document.querySelector('#vie-agent').innerText.slice(0,400)`)), 'LOG', JSON.stringify(await p2.ev(`document.querySelector('#vie-log').innerText.slice(-400)`)));
  await p2.ev(`(()=>{const d=document.querySelector('#vie-agent details');if(d)d.open=true;return true})()`);
  await p2.clickUntil('[data-ag="consent-revoke"]', hasText('#vie-agent', 'Autoriser le mode Agent'));
  check('I. P1 #1 : quota épuisé, clic « Révoquer » : consentement réellement retiré côté serveur, exécution annulée, la commande n’est JAMAIS exécutée, aucune alerte d’échec', await p2.waitFor(hasText('#vie-agent', 'Autoriser le mode Agent'), 8000) && (await vie.agent.status()).consent.given === false && shellRuns.length === 0 && await p2.ev(`!document.querySelector('.vie-ag-alert')`));
  check('I. l’exécution affichée passe à « Annulé » (aucune carte active restante)', await p2.waitFor(`/Annulé/.test(${lastAgentMsg}.innerText)`, 8000) && await p2.ev(`document.querySelectorAll('[data-ag="approve"]').length===0`));

  // --- Hygiène ---
  const outside = [page, p2].flatMap(p => p.requests).filter(r => !/^(http:\/\/127\.0\.0\.1:\d+\/|data:|about:|file:)/.test(r.url));
  check('aucune requête hors de 127.0.0.1 (pas d’Internet depuis le navigateur)', outside.length === 0, outside.slice(0, 3).map(r => r.url).join(','));
  check('aucune exception JavaScript pendant tout le parcours (hors lignes réseau attendues hors ligne)', [page, p2].every(p => p.exceptions.length === 0), [page, p2].flatMap(p => p.exceptions).slice(0, 2).join(' | '));
  check('aucune clé dans le DOM ni le stockage', await page.ev(`(()=>{const all=document.documentElement.outerHTML+Object.keys(localStorage).map(k=>localStorage.getItem(k)).join('');return !all.includes(${JSON.stringify(FAKE_KEY)})&&!all.includes('FAKE-ENV-NOT-REAL')})()`));

  await vie.close();
  try { b.ws.close(); b.proc.kill(); } catch (e) { /* déjà fermé */ }
  await Promise.race([b.closed, sleep(3000)]);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* profil encore verrouillé : sans importance */ }
  const ok = results.filter(r => r.ok).length;
  console.log(`\n${ok}/${results.length} PASS${ok === results.length ? '' : ' — ÉCHECS : ' + results.filter(r => !r.ok).map(r => r.name).join(' | ')}`);
  process.exit(ok === results.length ? 0 : 1);
})().catch(e => { console.error(e); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (x) { /* ignoré */ } process.exit(1); });
