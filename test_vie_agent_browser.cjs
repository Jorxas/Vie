// Vérification NAVIGATEUR RÉELLE du mode Agent « Ordinateur » : Chrome ou Edge (profil JETABLE), vrai serveur vie-server.cjs dans ce processus,
// FAUX SDK (fake_agent_sdk.cjs) et faux Anthropic piégé (aucun réseau, aucun coût, aucune vraie clé), répertoire TEMPORAIRE INOFFENSIF.
//   node test_vie_agent_browser.cjs "C:\Program Files\Google\Chrome\Application\chrome.exe"
//   node test_vie_agent_browser.cjs "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
// Ce test ne prouve PAS le comportement du vrai SDK (« intégration vraie non testée »).
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createVieServer } = require('./vie-server.cjs');
const { createFakeSdk } = require('./fake_agent_sdk.cjs');

const exe = process.argv[2];
if (!exe || !fs.existsSync(exe)) { console.log('NON TESTÉ : chemin du navigateur absent ou introuvable (argument 1).'); process.exit(2); }
const FAKE_KEY = 'FAKE-BROWSER-AGENT-KEY-NOT-A-SECRET-0123456789';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vie-agent-browser-')));
const profile = path.join(tmp, 'profile'), home = path.join(tmp, 'home'), backups = path.join(tmp, 'backups');
for (const d of [profile, home, backups]) fs.mkdirSync(d, { recursive: true });
const mk = (p, c) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); return p; };
mk(path.join(home, 'Cours', 'cours1.md'), 'Cours d’algorithmique : le tri fusion. SECRET-COURS-MARKER-4242\n');
mk(path.join(home, 'Documents', 'gardien.txt'), 'dossier Documents présent');
mk(path.join(home, '.env'), 'ANTHROPIC_API_KEY=FAKE-ENV-NOT-REAL-9876543210\n');
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };

async function launch() {
  const proc = spawn(exe, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let info = null;
  for (let i = 0; i < 150 && !info; i++) { await sleep(100); try { const [port, p] = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/); if (port && p) info = { port, p }; } catch (e) { /* pas encore */ } }
  assert.ok(info, 'DevToolsActivePort introuvable');
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
  const errors = [], requests = [], dialogs = [];
  const s = (m, p) => b.send(m, p, sessionId);
  b.on(m => {
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Runtime.exceptionThrown') errors.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console.error: ' + m.params.args.map(a => a.value ?? a.description).join(' '));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push('log: ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
    if (m.method === 'Network.requestWillBeSent') requests.push({ url: m.params.request.url, method: m.params.request.method });
    if (m.method === 'Page.javascriptDialogOpening') { dialogs.push(m.params.message); s('Page.handleJavaScriptDialog', { accept: true }); }
  });
  for (const d of ['Page', 'Runtime', 'Log', 'DOM', 'Network']) await s(d + '.enable');
  const page = {
    errors, requests, dialogs,
    async goto(url) { const loaded = new Promise(r => b.on(m => { if (m.sessionId === sessionId && m.method === 'Page.loadEventFired') r(); })); await s('Page.navigate', { url }); await loaded; await sleep(150); },
    async ev(expression) { const r = await s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error('evaluate: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result.value; },
    click: sel => page.ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)throw Error('introuvable: '+${JSON.stringify(sel)});e.click();return true;})()`),
    fill: (sel, v) => page.ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)throw Error('introuvable: '+${JSON.stringify(sel)});e.value=${JSON.stringify(v)};e.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`),
    async waitFor(expr, ms = 8000) { for (let t = 0; t < ms; t += 80) { let v = false; try { v = await page.ev(expr); } catch (e) { /* transition */ } if (v) return true; await sleep(80); } return false; },
    async realClick(sel) {
      const r = await page.ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)throw Error('introuvable: '+${JSON.stringify(sel)});e.scrollIntoView({block:'center',behavior:'instant'});const b=e.getBoundingClientRect();return{x:b.left+b.width/2,y:b.top+b.height/2,w:b.width,h:b.height}})()`);
      await s('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y }); await s('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 }); await s('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
      return r;
    },
    async viewport(width, height = 800) { await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 500 }); await sleep(200); },
    async clearViewport() { await s('Emulation.clearDeviceMetricsOverride'); await sleep(150); },
    async shot(name) { if (!process.env.VIE_SHOTS_DIR) return; fs.mkdirSync(process.env.VIE_SHOTS_DIR, { recursive: true }); const r = await s('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(process.env.VIE_SHOTS_DIR, name + '.png'), Buffer.from(r.data, 'base64')); },
  };
  return page;
}
const hasText = (sel, txt) => `(document.querySelector(${JSON.stringify(sel)})||{innerText:''}).innerText.includes(${JSON.stringify(txt)})`;
const mockFetch = async () => new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Réponse du chat classique.' }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 20 } }), { status: 200, headers: { 'content-type': 'application/json' } });

(async () => {
  console.log(`Navigateur : ${exe}\nProfil jetable : ${profile}`);
  const target = path.join(home, 'Documents', 'plan.md');
  let scenario = 'read';
  const TAIL = '\nStart-Process calc.exe  # QUEUE-HOSTILE-7060';
  const BODY = ('# configuration anodine\n' + 'x'.repeat(78) + '\n').repeat(88).slice(0, 7060 - TAIL.length) + TAIL;
  const tailTarget = path.join(home, 'Documents', 'queue.txt');
  const shellRuns = [];
  const fake = createFakeSdk({
    shell: c => { shellRuns.push(c); return { out: 'ok' }; },
    script: async api => {
      if (scenario === 'read') {
        await api.use('mcp__vie__list_dir', { path: home });
        await api.use('mcp__vie__read_file', { path: path.join(home, 'Cours', 'cours1.md') });
        await api.use('mcp__vie__read_file', { path: path.join(home, '.env') });
        return 'Analyse terminée : le cours porte sur le tri fusion.\n```vie-proposals\n[{"name":"navigate_section","input":{"section":"study","reason":"voir les cours"}}]\n```';
      }
      if (scenario === 'write') { const r = await api.use('mcp__vie__write_file', { path: target, content: 'ligne <b>un</b>\n' }); return 'Écriture : ' + (r.allowed ? 'faite' : 'non faite'); }
      if (scenario === 'tail') { const r = await api.use('mcp__vie__write_file', { path: tailTarget, content: BODY }); return 'Gros fichier : ' + (r.allowed ? 'écrit' : 'non écrit'); }
      if (scenario === 'net') { const r = await api.use('PowerShell', { command: 'curl https://exemple.test/<script>alert(1)</script>' }); return 'Réseau : ' + (r.allowed ? 'exécuté' : 'refusé'); }
      if (scenario === 'slow') { await api.use('PowerShell', { command: 'git status' }); return 'fini'; }
      return 'rien';
    },
  });
  const vie = createVieServer({ env: { ANTHROPIC_API_KEY: FAKE_KEY }, envFile: path.join(tmp, 'absent.env'), fetch: mockFetch, log: () => {}, limits: { perMinute: 1000 }, agent: { sdkLoader: fake.sdkLoader, home, cwd: home, backupRoot: backups, configDir: path.join(tmp, 'cfg'), pdftotext: null, approvalTtlMs: 60000 } });
  const port = await vie.listen(0);
  const URL_APP = `http://127.0.0.1:${port}/`;
  const b = await launch();
  const page = await openPage(b);
  await page.viewport(1200, 800);   // fenêtre de bureau réaliste (la fenêtre headless par défaut fait 482 px de haut)
  await page.goto(URL_APP + '#vie-boot=' + vie.issueLaunchTicket());   // connexion comme le lanceur (ticket en fragment)
  const send = async text => { await page.fill('#vie-input', text); await page.click('#vie-send'); };

  await page.click('#vie-launch');
  check('panneau : sélecteur Chat / Ordinateur présent, Chat actif par défaut, pill modèle·effort inchangé', await page.ev(`(()=>{const m=[...document.querySelectorAll('.vie-mode')];return m.length===2&&m[0].textContent==='Chat'&&m[0].getAttribute('aria-pressed')==='true'&&m[1].textContent==='Ordinateur'&&document.querySelector('#vie-pill .vie-pill-txt').innerText.trim()==='Haiku 5.5 · Moyen'})()`));
  const pillBefore = await page.ev(`(()=>{const c=getComputedStyle(document.querySelector('#vie-pill'));return[c.backgroundColor,c.borderRadius,c.fontSize,c.color].join('|')})()`);
  check('chat existant intact : un message part par /api/chat (faux Anthropic) et la réponse s’affiche', await (async () => { await send('Bonjour'); return page.waitFor(hasText('#vie-log', 'Réponse du chat classique.')); })());

  // --- Mode Agent : consentement ---
  await page.click('[data-mode="agent"]');
  check('mode Ordinateur : carte de consentement avec la phrase exacte, coût, absence d’admin, envoi bloqué', await page.waitFor(hasText('#vie-agent', 'Autoriser Vie à consulter mes fichiers pour répondre ; les extraits utiles pourront être envoyés à Claude')) && await page.ev(`(()=>{const t=document.querySelector('#vie-agent').innerText;return /aucun droit administrateur/.test(t)&&/Coût/.test(t)&&/ChatGPT/.test(t)&&/jamais enregistré/.test(t)&&document.querySelector('#vie-send').disabled===true})()`));
  check('pill modèle·effort identique en mode Ordinateur (même style, même texte)', (await page.ev(`(()=>{const c=getComputedStyle(document.querySelector('#vie-pill'));return[c.backgroundColor,c.borderRadius,c.fontSize,c.color].join('|')})()`)) === pillBefore && (await page.ev(`document.querySelector('#vie-pill .vie-pill-txt').innerText.trim()`)) === 'Haiku 5.5 · Moyen');
  await page.click('#vie-pill');
  check('le menu modèle s’ouvre en mode Ordinateur (rôles ARIA menu, 3 modèles + défaut, crans d’effort)', await page.ev(`(()=>{const p=document.querySelector('#vie-pop');return !p.hidden&&p.querySelectorAll('[role="menuitemradio"][data-pick]').length===4&&p.querySelectorAll('[data-effort]').length===4})()`));
  await page.click('#vie-pill');
  await page.realClick('[data-ag="consent-accept"]');
  check('après consentement : barre « Agent actif », dossier de travail, pdftotext absent signalé, envoi possible', await page.waitFor(hasText('#vie-agent', 'Agent actif')) && await page.ev(`(()=>{const t=document.querySelector('#vie-agent').innerText;return t.includes(${JSON.stringify(home)})&&/pdftotext absent/.test(t)&&document.querySelector('#vie-send').disabled===false})()`));

  // --- Lecture ---
  await send('analyse mes cours et adapte mes objectifs');
  check('analyse : consultations listées, réponse finale, carte de proposition de navigation exécutée, aucune carte d’approbation (lecture seule)', await page.waitFor(`document.querySelector('.vie-ag-head')&&/Terminé/.test(document.querySelector('.vie-ag-head').innerText)&&/tri fusion/.test(document.querySelector('#vie-log').innerText)`, 12000) && await page.ev(`(()=>{const l=document.querySelector('#vie-log');return l.querySelectorAll('.vie-ag-tools li').length>=2&&l.querySelectorAll('.vie-ag-card').length===0&&/Rubrique « /.test(l.innerText)})()`));
  check('lecture de .env : refusée (reçu « Refusé par la politique »), jamais affichée', await page.ev(`(()=>{const t=document.querySelector('#vie-log').innerText;return /Refusé par la politique/.test(t)&&!t.includes('FAKE-ENV-NOT-REAL')})()`));
  check('périmètre de partage : fichier lu listé (chemin), contenu absent, boutons Effacer / Révoquer', await page.ev(`(()=>{const d=document.querySelector('#vie-agent details');d.open=true;const t=d.innerText;return t.includes('cours1.md')&&!t.includes('SECRET-COURS-MARKER')&&/Effacer la liste/.test(t)&&/Révoquer/.test(t)})()`));
  check('historique : rien de l’agent (message, réponse, contenu de fichier) dans localStorage', await page.ev(`(()=>{const all=Object.keys(localStorage).map(k=>localStorage.getItem(k)).join('\\n');return !all.includes('tri fusion')&&!all.includes('SECRET-COURS-MARKER')&&!all.includes('analyse mes cours')})()`));
  check('chat classique : les messages de l’agent n’apparaissent pas dans le mode Chat, et inversement', await (async () => { await page.click('[data-mode="chat"]'); const ok = await page.ev(`(()=>{const t=document.querySelector('#vie-log').innerText;return t.includes('Réponse du chat classique.')&&!t.includes('tri fusion')})()`); await page.click('[data-mode="agent"]'); return ok; })());

  // --- Écriture : carte d'approbation, refus puis approbation ---
  scenario = 'write';
  await send('écris un plan');
  const cardSel = '.vie-ag-card.pending, .vie-ag-card:not(.approved):not(.denied):not(.expired):not(.cancelled):not(.sending)';
  check('écriture : carte d’approbation (outil, chemin, contenu, risques, retour arrière, expiration, APPROUVER/REFUSER) ; rien d’écrit', await page.waitFor(`!!document.querySelector('${cardSel}')`, 12000) && await page.ev(`(()=>{const c=document.querySelector('.vie-ag-card');const t=c.innerText;return /Approbation requise/.test(t)&&/write_file/.test(t)&&t.includes('plan.md')&&/ligne <b>un<\\/b>/.test(t)&&/Retour arrière/.test(t)&&/expire dans/.test(t)&&!!c.querySelector('[data-ag="approve"]')&&!!c.querySelector('[data-ag="deny"]')&&c.querySelector('[data-ag="approve"]').innerText==='APPROUVER'&&c.querySelector('[data-ag="deny"]').innerText==='REFUSER'})()`) && !fs.existsSync(target));
  check('contenu hostile échappé : aucune balise injectée, aucun script exécuté', await page.ev(`!document.querySelector('.vie-ag-card pre b')&&window.__xss===undefined`));
  await page.shot('agent-approval-card');
  await page.realClick('[data-ag="deny"]');
  check('REFUSER : état « refusée », rien d’écrit, reçu « Refusé par toi », le modèle est informé', await page.waitFor(`/refusée : rien n’a été fait/.test(document.querySelector('#vie-log').innerText)&&/Refusé par toi/.test(document.querySelector('#vie-log').innerText)&&/non faite/.test(document.querySelector('#vie-log').innerText)`, 12000) && !fs.existsSync(target));
  await send('écris le plan');
  await page.waitFor(`document.querySelectorAll('[data-ag="approve"]').length===1`, 12000);
  await page.realClick('[data-ag="approve"]');
  check('APPROUVER : fichier écrit EXACTEMENT, reçu « Fait » avec sha256 et chemin', await page.waitFor(`/✓ Fait/.test(document.querySelector('#vie-log').innerText)&&/sha256/.test(document.querySelector('#vie-log').innerText)`, 12000) && fs.readFileSync(target, 'utf8') === 'ligne <b>un</b>\n');
  check('l’ancienne carte approuvée ne propose plus de boutons (usage unique)', await page.ev(`document.querySelectorAll('[data-ag="approve"]').length===0`));

  // --- B1 (QA passe 4) : écriture de 7060 caractères dont la QUEUE est hostile : tout doit être visible dans la carte réelle ---
  scenario = 'tail';
  await send('écris le gros fichier');
  check('B1 carte 7060 car. : le texte AFFICHÉ contient la queue hostile en entier (pas de défilement interne, pas de troncature, compteur « 7060 car. »), APPROUVER actif', await page.waitFor(`!!document.querySelector('[data-ag="approve"]')`, 12000) && await page.ev(`(()=>{const c=[...document.querySelectorAll('.vie-ag-card')].at(-1);const pres=[...c.querySelectorAll('pre')];const pre=pres.find(p=>p.textContent.includes('QUEUE-HOSTILE-7060'));if(!pre)return false;const cs=getComputedStyle(pre);const r=pre.getBoundingClientRect();return pre.textContent.length===${BODY.length}&&pre.textContent.endsWith('QUEUE-HOSTILE-7060')&&!pre.textContent.includes('…')&&cs.maxHeight==='none'&&cs.overflowY==='visible'&&pre.scrollHeight<=pre.clientHeight+2&&/7060 car\\./.test(c.innerText)&&!/incomplète/.test(c.innerText)&&document.querySelector('[data-ag="approve"]').disabled===false&&r.height>200})()`));
  await page.shot('agent-approval-7060');
  // altération en route (proxy / extension / bogue) : le navigateur reçoit des détails raccourcis → la carte se déclare incomplète et APPROUVER est désactivé
  await page.ev(`(()=>{const o=window.fetch;window.__tamper=true;window.fetch=async(u,i)=>{const r=await o(u,i);if(!window.__tamper||!/agent\\/events/.test(String(u)))return r;const j=await r.clone().json();for(const e of j.events||[])if(e.type==='approval')for(const d of e.details||[])if(d.pre)d.value=d.value.slice(0,1600)+'…';return new Response(JSON.stringify(j),{status:200,headers:{'content-type':'application/json'}});};return true})()`);
  await page.realClick('[data-ag="deny"]');
  check('B1 refus de la carte complète : rien d’écrit', await page.waitFor(`/Gros fichier : non écrit/.test(document.querySelector('#vie-log').innerText)`, 12000) && !fs.existsSync(tailTarget));
  await send('écris le gros fichier encore');
  check('B1 carte ALTÉRÉE (détails raccourcis à 1600 car. côté navigateur) : « Carte incomplète », APPROUVER désactivé, REFUSER disponible, rien d’écrit', await page.waitFor(`!!document.querySelector('[data-ag="deny"]')&&/Carte incomplète ou altérée/.test(document.querySelector('#vie-log').innerText)`, 12000) && await page.ev(`document.querySelector('[data-ag="approve"]').disabled===true`) && !fs.existsSync(tailTarget));
  await page.ev(`(()=>{document.querySelector('[data-ag="approve"]').disabled=false;document.querySelector('[data-ag="approve"]').click();return true})()`);   // contournement forcé du bouton : la logique refuse aussi
  await sleep(600);
  check('B1 approbation forcée par script sur une carte incomplète : refusée par le panneau (aucune décision envoyée), rien d’écrit', await page.ev(`document.querySelectorAll('[data-ag="approve"]').length===1`) && !fs.existsSync(tailTarget));
  await page.ev(`window.__tamper=false`);
  await page.realClick('[data-ag="deny"]');
  await page.waitFor(`/Gros fichier : non écrit/.test([...document.querySelectorAll('#vie-log .vie-msg.bot.agent')].at(-1).innerText)`, 12000);

  // --- Réseau : confirmation supplémentaire ---
  scenario = 'net';
  await send('télécharge quelque chose');
  check('commande réseau : commande exacte, risque RÉSEAU, APPROUVER désactivé tant que la case réseau n’est pas cochée ; HTML de la commande échappé', await page.waitFor(`!!document.querySelector('[data-ag="ack"]')`, 12000) && await page.ev(`(()=>{const a=document.querySelector('[data-ag="approve"]');const c=document.querySelector('[data-ag="ack"]').closest('.vie-ag-card');return a.disabled===true&&/RÉSEAU/.test(c.innerText)&&c.innerText.includes('<script>alert(1)</script>')&&!c.querySelector('script')})()`) && shellRuns.length === 0);
  await page.click('[data-ag="ack"]');
  check('case réseau cochée : APPROUVER devient disponible ; REFUSER → rien exécuté', await page.ev(`document.querySelector('[data-ag="approve"]').disabled===false`));
  await page.realClick('[data-ag="deny"]');
  check('commande refusée : jamais exécutée', await page.waitFor(`/Réseau : refusé/.test(document.querySelector('#vie-log').innerText)`, 12000) && shellRuns.length === 0);

  // --- Annulation ---
  scenario = 'slow';
  await send('git status');
  await page.waitFor(`!!document.querySelector('[data-ag="approve"]')`, 12000);
  await page.click('[data-vie="cancel"]');
  check('ANNULER pendant une carte : exécution « Annulé », commande jamais exécutée, carte close', await page.waitFor(`/Annulé/.test([...document.querySelectorAll('#vie-log .vie-msg.bot.agent')].at(-1).innerText)`, 12000) && shellRuns.length === 0 && await page.ev(`document.querySelectorAll('[data-ag="approve"]').length===0`));

  // --- Révocation ---
  await page.ev(`(()=>{const d=document.querySelector('#vie-agent details');if(d)d.open=true;return true})()`);
  await page.realClick('[data-ag="scope-clear"]');
  check('« Effacer la liste » vide le périmètre affiché', await page.waitFor(`/Fichiers dont des extraits ont pu être envoyés à Claude \\(0\\)/.test(document.querySelector('#vie-agent').innerText)`));
  await page.ev(`(()=>{const d=document.querySelector('#vie-agent details');if(d)d.open=true;return true})()`);
  await page.realClick('[data-ag="consent-revoke"]');
  check('« Révoquer l’accès » (avec confirmation) : retour à la carte de consentement, envoi bloqué, serveur sans consentement', await page.waitFor(hasText('#vie-agent', 'Autoriser le mode Agent')) && await page.ev(`document.querySelector('#vie-send').disabled===true`) && (await vie.agent.status()).consent.given === false && page.dialogs.some(d => /Révoquer/.test(d)));

  // --- Mobile 390 px ---
  await page.realClick('[data-ag="consent-accept"]');
  await page.waitFor(hasText('#vie-agent', 'Agent actif'));
  scenario = 'net';
  await page.viewport(390, 780);
  await send('télécharge');
  await page.waitFor(`!!document.querySelector('[data-ag="ack"]')`, 12000);
  const mob = await page.ev(`(()=>{const p=document.querySelector('#vie-panel');const l=document.querySelector('#vie-log');const c=document.querySelector('.vie-ag-card');const a=document.querySelector('[data-ag="deny"]').getBoundingClientRect();const pill=document.querySelector('#vie-pill').getBoundingClientRect();return{pw:p.getBoundingClientRect().width,over:document.documentElement.scrollWidth>window.innerWidth+1,logOver:l.scrollWidth>l.clientWidth+1,cardRight:c.getBoundingClientRect().right,vw:window.innerWidth,btnH:a.height,pillVisible:pill.width>0&&pill.right<=window.innerWidth+1,modes:[...document.querySelectorAll('.vie-mode')].every(m=>m.getBoundingClientRect().right<=window.innerWidth)}})()`);
  check('mobile 390 px : panneau plein écran, aucun débordement horizontal, carte dans l’écran, pill et modes visibles', mob.pw <= 391 && !mob.over && !mob.logOver && mob.cardRight <= mob.vw + 1 && mob.pillVisible && mob.modes, JSON.stringify(mob));
  check('mobile 390 px : boutons de décision de taille tactile (≥ 28 px) et utilisables', mob.btnH >= 28, 'hauteur ' + mob.btnH);
  await page.shot('agent-mobile-390');
  await page.realClick('[data-ag="deny"]');
  await page.waitFor(`/Réseau : refusé/.test(document.querySelector('#vie-log').innerText)`, 12000);
  await page.clearViewport();

  // --- Hygiène globale ---
  check('aucune erreur de console ni violation de CSP pendant tout le parcours', page.errors.length === 0, page.errors.slice(0, 3).join(' | '));
  check('aucune requête hors de 127.0.0.1 (pas d’Internet depuis le navigateur)', page.requests.every(r => /^(http:\/\/127\.0\.0\.1:\d+\/|data:|about:)/.test(r.url)), page.requests.filter(r => !/^(http:\/\/127\.0\.0\.1:\d+\/|data:|about:)/.test(r.url)).map(r => r.url).slice(0, 3).join(','));
  check('aucune clé dans le DOM, le stockage ni les requêtes du navigateur', await page.ev(`(()=>{const all=document.documentElement.outerHTML+Object.keys(localStorage).map(k=>localStorage.getItem(k)).join('')+Object.keys(sessionStorage).map(k=>sessionStorage.getItem(k)).join('');return !all.includes(${JSON.stringify(FAKE_KEY)})&&!all.includes('FAKE-ENV-NOT-REAL')})()`));
  check('cookie de session non lisible par le script (HttpOnly)', await page.ev(`document.cookie===''`));

  // --- Agent inactif : le chat reste utilisable ---
  const vie2 = createVieServer({ env: { ANTHROPIC_API_KEY: FAKE_KEY }, envFile: path.join(tmp, 'absent.env'), fetch: mockFetch, log: () => {}, agent: { sdkLoader: async () => { throw new Error('absent'); }, home, cwd: home } });
  const port2 = await vie2.listen(0);
  const page2 = await openPage(b);
  await page2.goto(`http://127.0.0.1:${port2}/#vie-boot=${vie2.issueLaunchTicket()}`);
  await page2.click('#vie-launch'); await page2.click('[data-mode="agent"]');
  check('moteur absent : « Agent local inactif » avec la commande d’installation, envoi bloqué, rien ne casse', await page2.waitFor(`/Agent local inactif/.test(document.querySelector('#vie-agent').innerText)&&/npm ci --ignore-scripts/.test(document.querySelector('#vie-agent').innerText)`) && await page2.ev(`document.querySelector('#vie-send').disabled===true`));
  await page2.click('[data-mode="chat"]');
  await page2.fill('#vie-input', 'Salut'); await page2.click('#vie-send');
  check('moteur absent : le chat classique répond toujours', await page2.waitFor(hasText('#vie-log', 'Réponse du chat classique.')) && page2.errors.length === 0, page2.errors.join('|'));
  const vie3 = createVieServer({ env: { ANTHROPIC_API_KEY: FAKE_KEY, VIE_AGENT: 'off' }, envFile: path.join(tmp, 'absent.env'), fetch: mockFetch, log: () => {}, agent: { sdkLoader: fake.sdkLoader, home, cwd: home } });
  const port3 = await vie3.listen(0);
  const page3 = await openPage(b);
  await page3.goto(`http://127.0.0.1:${port3}/#vie-boot=${vie3.issueLaunchTicket()}`);
  await page3.click('#vie-launch'); await page3.click('[data-mode="agent"]');
  check('VIE_AGENT=off : « Agent local inactif », désactivé', await page3.waitFor(`/Agent local inactif/.test(document.querySelector('#vie-agent').innerText)&&/VIE_AGENT=off/.test(document.querySelector('#vie-agent').innerText)`));
  // hors serveur : file:// -> aucun mode agent exploitable
  const page4 = await openPage(b);
  await page4.goto('file:///' + path.join(__dirname, 'index.html').replace(/\\/g, '/'));
  await page4.click('#vie-launch'); await page4.click('[data-mode="agent"]');
  check('hors ligne (file://) : le mode Agent annonce qu’il nécessite le serveur local, le site fonctionne', await page4.waitFor(`/nécessite le serveur local/.test(document.querySelector('#vie-agent').innerText)`) && await page4.ev(`document.querySelectorAll('button.nav-btn').length===10`));

  await vie.close(); await vie2.close(); await vie3.close();
  try { b.ws.close(); b.proc.kill(); } catch (e) { /* déjà fermé */ }
  await Promise.race([b.closed, sleep(3000)]);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* profil encore verrouillé : sans importance */ }
  const ok = results.filter(r => r.ok).length;
  console.log(`\n${ok}/${results.length} PASS${ok === results.length ? '' : ' — ÉCHECS : ' + results.filter(r => !r.ok).map(r => r.name).join(' | ')}`);
  process.exit(ok === results.length ? 0 : 1);
})().catch(e => { console.error(e); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (x) { /* ignoré */ } process.exit(1); });
