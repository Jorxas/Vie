// Vérification navigateur RÉELLE de l'assistant Vie : Chrome ou Edge (profil JETABLE), vrai serveur vie-server.cjs lancé dans ce processus sur 127.0.0.1,
// API Anthropic SIMULÉE (fetch injecté : aucun réseau, aucun coût, aucune vraie clé). Le profil personnel de l'utilisateur n'est jamais ouvert.
//   node test_vie_browser.cjs "C:\Program Files\Google\Chrome\Application\chrome.exe"
//   node test_vie_browser.cjs "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
// Variable facultative : VIE_SHOTS_DIR=<dossier> pour enregistrer des captures.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const C = require('./core.js');
const { createVieServer, CATALOG, MODELS } = require('./vie-server.cjs');

const exe = process.argv[2];
if (!exe || !fs.existsSync(exe)) { console.log('NON TESTÉ : chemin du navigateur absent ou introuvable (argument 1).'); process.exit(2); }
const KEY = 'vie-personal-v1', FAKE_KEY = 'FAKE-BROWSER-KEY-NOT-A-SECRET-0123456789abcdef';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vie-assistant-browser-'));
const profile = path.join(tmp, 'profile'), downloads = path.join(tmp, 'downloads');
for (const d of [profile, downloads]) fs.mkdirSync(d);
const results = [];
let current = null, vie = null;
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };

// --- Anthropic simulé -------------------------------------------------------------------------------------------------
const upstream = { calls: [], script: null };
const mockFetch = async (url, init) => {
  const body = JSON.parse(init.body);
  upstream.calls.push({ url, headers: init.headers, body });
  const r = await (upstream.script ? upstream.script(body, upstream.calls.length) : { content: [{ type: 'text', text: 'Bonjour, je suis Vie.' }] });
  return new Response(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', content: r.content, stop_reason: r.stop || 'end_turn', usage: { input_tokens: 1200, output_tokens: 340 } }), { status: 200, headers: { 'content-type': 'application/json' } });
};
// Partage coupé : aucune suppression, et propose_update ne peut viser QUE les réglages (schéma fermé entity=settings / id=settings) ; l'utilisateur confirme de toute façon (voir test_vie_actions / test_vie_server).
const noItemMutationTools = tools => tools.every(t => t.name !== 'propose_delete') && tools.every(t => t.name !== 'propose_update' || (JSON.stringify(t.input_schema.properties.entity.enum) === '["settings"]' && JSON.stringify(t.input_schema.properties.id.enum) === '["settings"]'));
const ctxOf = body => { const last = body.messages[body.messages.length - 1].content; if (!Array.isArray(last)) return null; const t = last.find(b => b.text.startsWith('<donnees_vie>')); return t ? JSON.parse(t.text.replace(/^<donnees_vie>\n/, '').replace(/\n<\/donnees_vie>$/, '')) : null; };
const text = t => ({ type: 'text', text: t });
const tool = (name, input) => ({ type: 'tool_use', id: 'tu_' + Math.random().toString(36).slice(2, 8), name, input });
const lastText = () => { const l = upstream.calls[upstream.calls.length - 1].body.messages; const c = l[l.length - 1].content; return Array.isArray(c) ? c.map(b => b.text).join('\n') : c; };

// --- Pilotage Chrome (DevTools via WebSocket intégré à Node) -------------------------------------------------------------
async function launch() {
  try { fs.unlinkSync(path.join(profile, 'DevToolsActivePort')); } catch (e) { /* absent */ }
  const proc = spawn(exe, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let info = null;
  for (let i = 0; i < 150 && !info; i++) { await sleep(100); try { const [port, p] = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/); if (port && p) info = { port, p }; } catch (e) { /* pas encore */ } }
  assert.ok(info, 'DevToolsActivePort introuvable');
  const ws = new WebSocket(`ws://127.0.0.1:${info.port}${info.p}`);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(Error('connexion DevTools impossible')); });
  let id = 0; const pending = new Map(), handlers = [];
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(Error(m.error.message)) : res(m.result); } else if (m.method) handlers.forEach(h => h(m)); };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  const closed = new Promise(r => proc.once('exit', r));
  return { proc, ws, send, on: h => handlers.push(h), closed };
}
async function openPage(b) {
  const { targetId } = await b.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await b.send('Target.attachToTarget', { targetId, flatten: true });
  const errors = [], dialogs = [], requests = [], csp = [];
  const s = (m, p) => b.send(m, p, sessionId);
  b.on(m => {
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Runtime.exceptionThrown') errors.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console.error: ' + m.params.args.map(a => a.value ?? a.description).join(' '));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push('log: ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
    if (m.method === 'Network.requestWillBeSent') requests.push({ url: m.params.request.url, method: m.params.request.method, post: m.params.request.postData || '', headers: JSON.stringify(m.params.request.headers) });
    if (m.method === 'Page.javascriptDialogOpening') { dialogs.push(m.params.message); s('Page.handleJavaScriptDialog', { accept: !page.refuseNext }); page.refuseNext = false; }
  });
  for (const d of ['Page', 'Runtime', 'Log', 'DOM', 'Network']) await s(d + '.enable');
  const page = {
    errors, dialogs, requests, refuseNext: false,
    async goto(url) { const loaded = new Promise(r => b.on(m => { if (m.sessionId === sessionId && m.method === 'Page.loadEventFired') r(); })); await s('Page.navigate', { url }); await loaded; await sleep(350); },
    async ev(expression) { const r = await s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error('evaluate: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result.value; },
    click(sel) { return page.ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)throw Error('introuvable: '+${JSON.stringify(sel)});e.click();return true;})()`); },
    fill(sel, v) { return page.ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)throw Error('introuvable: '+${JSON.stringify(sel)});e.value=${JSON.stringify(v)};e.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`); },
    async waitFor(expr, ms = 6000) { for (let t = 0; t < ms; t += 80) { let v = false; try { v = await page.ev(expr); } catch (e) { /* page en transition */ } if (v) return true; await sleep(80); } return false; },
    stored: () => page.ev(`localStorage.getItem(${JSON.stringify(KEY)})`),
    state: async () => JSON.parse(await page.stored()),
    toast: () => page.ev(`document.querySelector('#toast').textContent`),
    key: (key, code, vk, modifiers = 0, txt) => s('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, modifiers, ...(txt ? { text: txt } : {}) }).then(() => s('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers })),
    async viewport(width, height = 900) { await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 500 }); await sleep(180); },
    async clearViewport() { await s('Emulation.clearDeviceMetricsOverride'); await sleep(180); },
    // Vrai clic souris (pointerdown/up réels, contrairement à element.click()) au centre de l'élément ; x/y optionnels pour viser un point précis.
    async realClick(sel, at) {
      const r = await page.ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)throw Error('introuvable: '+${JSON.stringify(sel)});const b=e.getBoundingClientRect();return{x:b.left+b.width/2,y:b.top+b.height/2}})()`);
      const x = at ? at.x : r.x, y = at ? at.y : r.y;
      await s('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); await s('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }); await s('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }); await sleep(120);
    },
    async shot(name) { if (!process.env.VIE_SHOTS_DIR) return; fs.mkdirSync(process.env.VIE_SHOTS_DIR, { recursive: true }); const r = await s('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(process.env.VIE_SHOTS_DIR, name + '.png'), Buffer.from(r.data, 'base64')); },
    // envoie un message à Vie via l'interface et attend la réponse (ou l'erreur)
    async ask(msg, ms = 8000) {
      const before = await page.ev(`document.querySelectorAll('.vie-msg.bot').length`);
      await page.fill('#vie-input', msg); await page.click('#vie-send');
      return page.waitFor(`document.querySelectorAll('.vie-msg.bot').length>${before}&&!document.querySelector('.vie-msg.typing')`, ms);
    },
    panelText: () => page.ev(`document.querySelector('#vie-log').innerText`),
  };
  return page;
}
const app = port => `http://127.0.0.1:${port}/`;
const cardText = (page, i = -1) => page.ev(`(()=>{const c=[...document.querySelectorAll('.vie-card')];const e=c.at(${i});return e?e.innerText:''})()`);
const exportFiles = () => fs.readdirSync(downloads).filter(x => x.endsWith('.json'));

(async () => {
  console.log(`Navigateur : ${exe}\nProfil jetable : ${profile}`);
  vie = createVieServer({ env: { ANTHROPIC_API_KEY: FAKE_KEY }, envFile: path.join(tmp, 'absent.env'), fetch: mockFetch, log: () => {}, sleep: () => Promise.resolve(), limits: { perMinute: 1000 } });
  const port = await vie.listen(0);
  const URL_APP = app(port);
  console.log('Serveur de test : ' + URL_APP);
  let b = current = await launch();
  console.log('Version :', (await b.send('Browser.getVersion')).product);
  await b.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  let page = await openPage(b);
  await page.goto(`http://localhost:${port}/`);
  check('localhost est redirigé vers l’origine canonique http://127.0.0.1 (un seul stockage local)', (await page.ev('location.origin')) === `http://127.0.0.1:${port}`, await page.ev('location.origin'));
  await page.goto('about:blank');   // nouveau document : un fragment seul ne rechargerait pas la page
  await page.goto(URL_APP + '#vie-boot=' + vie.issueLaunchTicket());   // connexion comme le lanceur : ticket en fragment, échangé par vie-boot.js

  // 1. Site V1 sur http : aucun effet de bord de la CSP / du serveur
  check('http : titre, 10 rubriques, aucune erreur (CSP comprise)', (await page.ev('document.title')).startsWith('VIE') && (await page.ev(`document.querySelectorAll('button.nav-btn').length`)) === 10 && page.errors.length === 0, page.errors.slice(0, 2).join(' | '));
  check('http : le bouton Vie est présent dans la barre du haut sur toutes les rubriques', await (async () => { for (const v of ['today', 'week', 'projects', 'study', 'career', 'life', 'finance', 'goals', 'ideas', 'settings']) { await page.click(`#nav [data-view="${v}"]`); if (!(await page.ev(`!!document.querySelector('#vie-launch')&&document.querySelector('#vie-launch').getBoundingClientRect().width>0`))) return false; } return true; })());
  // dépense créée par l'utilisateur lui-même (formulaire V1, modal <dialog>) : confirme que form-action/CSP ne cassent pas la V1
  await page.click('#nav [data-view="finance"]'); await page.click('[data-action="add-expense"]'); await page.fill('#field-amount', '12.5'); await page.fill('#field-label', 'Netflix'); await page.click('#modal-save'); await sleep(250);
  const s0 = await page.state(); const netflix = s0.transactions.find(t => t.label === 'Netflix');
  check('http : formulaire V1 (dialog) enregistre toujours une dépense', !!netflix && netflix.amount === 12.5);
  for (const f of exportFiles()) fs.unlinkSync(path.join(downloads, f));
  await page.click('#nav [data-view="settings"]'); await page.click('[data-action="export"]');
  await page.waitFor('true', 100); let dl = null; for (let i = 0; i < 40 && !dl; i++) { dl = exportFiles()[0]; await sleep(100); }
  check('http : export JSON V1 (téléchargement blob) fonctionne sous la CSP', !!dl && (() => { try { C.validateImported(JSON.parse(fs.readFileSync(path.join(downloads, dl), 'utf8'))); return true; } catch (e) { return false; } })());

  // 2. Ouverture / fermeture / clavier
  await page.click('#vie-launch');
  check('panneau : s’ouvre, aria-expanded=true, focus dans la zone de saisie', await page.ev(`document.querySelector('#vie-panel').classList.contains('open')&&document.querySelector('#vie-launch').getAttribute('aria-expanded')==='true'&&document.activeElement.id==='vie-input'`));
  await page.waitFor(`!document.querySelector('.vie-banner')`);
  check('panneau : serveur détecté (aucune bannière d’erreur), modèle et effort par défaut affichés dans le pill de la zone de saisie', await page.ev(`!document.querySelector('.vie-banner.warn')&&document.querySelector('#vie-pill').innerText.includes('Haiku 5.5 · Moyen')`));
  check('accessibilité : rôles et noms (complementary, log, textarea étiquetée, boutons nommés)', await page.ev(`(()=>{const p=document.querySelector('#vie-panel');const unnamed=[...p.querySelectorAll('button')].filter(b=>!(b.innerText||'').trim()&&!b.getAttribute('aria-label')&&!b.textContent.trim());return p.getAttribute('role')==='complementary'&&!!p.getAttribute('aria-label')&&document.querySelector('#vie-log').getAttribute('role')==='log'&&!!document.querySelector('label[for=vie-input]')&&unnamed.length===0})()`));
  await page.key('Escape', 'Escape', 27); await sleep(150);
  check('clavier : Échap replie le panneau et rend le focus au bouton Vie', await page.ev(`!document.querySelector('#vie-panel').classList.contains('open')&&document.activeElement.id==='vie-launch'&&document.querySelector('#vie-panel').inert===true`));
  await page.key('v', 'KeyV', 86, 1); await sleep(200);
  check('clavier : Alt+V ouvre le panneau', await page.ev(`document.querySelector('#vie-panel').classList.contains('open')`));

  // 3. Chat sans partage de données
  upstream.script = () => ({ content: [text('Salut ! Voici **un conseil** général :\n- dors 8 h\n- avance par petits pas')] });
  upstream.calls.length = 0;
  check('chat : réponse affichée (typing puis message, mise en forme sûre)', await page.ask('Bonjour Vie') && await page.ev(`!!document.querySelector('.vie-bubble strong')&&document.querySelectorAll('.vie-bubble li').length===2`));
  const c1 = upstream.calls[0];
  check('chat sans consentement : aucune donnée VIE envoyée, share=false, clé absente du corps et des requêtes navigateur', !JSON.stringify(c1.body).includes('Netflix') && !JSON.stringify(c1.body).includes('donnees_vie>\n') && /désactivé/.test(JSON.stringify(c1.body.messages)) && c1.headers['x-api-key'] === FAKE_KEY && !page.requests.some(r => (r.url + r.post + r.headers).includes(FAKE_KEY)));
  check('chat : modèle/niveau/jetons/coût et « aucune donnée envoyée » affichés sous la réponse', await page.ev(`(()=>{const m=document.querySelector('.vie-msgmeta').innerText;return m.includes('Haiku 5.5')&&m.includes('claude-haiku-5-5')&&m.includes('1200')&&m.includes('estimation')&&m.includes('Aucune fiche envoyée')&&m.includes('historique')&&!m.includes('Aucune donnée personnelle')})()`));
  await page.shot('vie-panneau-ouvert');
  // 3b. Saisie / réponse contenant du HTML : jamais interprété
  upstream.script = () => ({ stop: 'tool_use', content: [text('<img src=x onerror="window.__xss=1"> et **gras** `code` <script>window.__xss=3</script>'), tool('propose_create', { entity: 'ideas', values: [{ field: 'title', value: '<img src=x onerror="window.__xss=2">' }] })] });
  await page.ask('<b>gras ?</b> <img src=x onerror="window.__xss=4">');
  check('anti-XSS : HTML de la saisie, de la réponse et des cartes affiché comme texte, aucun script exécuté', await page.ev(`document.querySelectorAll('#vie-log img, #vie-log script').length===0&&window.__xss===undefined&&document.querySelector('#vie-log').innerText.includes('<img src=x')&&!!document.querySelector('.vie-card.pending')`));
  await page.click('.vie-card.pending [data-vie="refuse"]');
  check('refuser une proposition : aucune modification, carte « Refusé »', await page.ev(`!!document.querySelector('.vie-card.refused')`) && !(await page.state().catch(() => ({ ideas: [] }))).ideas?.some(i => /xss/.test(i.title)));
  // 3c. Clavier : Entrée envoie, Maj+Entrée n’envoie pas
  upstream.script = () => ({ content: [text('Reçu.')] });
  const nCalls = upstream.calls.length;
  await page.ev(`(()=>{const t=document.querySelector('#vie-input');t.value='ligne un';t.dispatchEvent(new Event('input',{bubbles:true}));t.focus();return true})()`);
  await page.key('Enter', 'Enter', 13, 8); await sleep(400);
  check('clavier : Maj+Entrée n’envoie pas', upstream.calls.length === nCalls && (await page.ev(`document.querySelector('#vie-input').value`)) === 'ligne un');
  await page.key('Enter', 'Enter', 13, 0); await page.waitFor(`!document.querySelector('.vie-msg.typing')`); await sleep(200);
  check('clavier : Entrée envoie le message et vide la zone de saisie', upstream.calls.length === nCalls + 1 && (await page.ev(`document.querySelector('#vie-input').value`)) === '' && /ligne un/.test(lastText()));

  // 4. Sélecteur modèle · effort : pill dans la zone de saisie + popover ancrée (vrai clavier, vrai clic souris, aucun appel Anthropic réel)
  await page.viewport(1280, 900);
  const pillTxt = () => page.ev(`document.querySelector('#vie-pill .vie-pill-txt').textContent`);
  const menuIsOpen = () => page.ev(`!document.querySelector('#vie-pop').hidden&&document.querySelector('#vie-pill').getAttribute('aria-expanded')==='true'&&!!document.querySelector('#vie-menu')`);
  const active = () => page.ev(`(()=>{const a=document.activeElement;return a.dataset&&a.dataset.pick!==undefined?'pick:'+a.dataset.pick:a.dataset&&a.dataset.effort!==undefined?'effort:'+a.dataset.effort:(a.id||a.tagName)})()`);
  const checked = () => page.ev(`(()=>{const p=document.querySelector('[data-pick][aria-checked="true"]'),e=document.querySelector('[data-effort][aria-checked="true"]');return(p?p.dataset.pick:'-')+'|'+(e?e.dataset.effort:'-')})()`);
  const prefsStored = () => page.ev(`JSON.parse(localStorage.getItem('vie-assistant-prefs-v1'))`);
  const chatBodies = () => page.requests.filter(r => r.url.endsWith('/api/chat')).map(r => JSON.parse(r.post));
  const metaLast = () => page.ev(`[...document.querySelectorAll('.vie-msgmeta')].at(-1).innerText`);
  const openMenu = async () => { if (!(await menuIsOpen())) await page.realClick('#vie-pill'); return menuIsOpen(); };
  const pickRow = key => page.realClick(`[data-pick="${key}"]`);
  const pickEffort = key => page.realClick(`[data-effort="${key}"]`);
  const KEYS = { down: ['ArrowDown', 'ArrowDown', 40], up: ['ArrowUp', 'ArrowUp', 38], left: ['ArrowLeft', 'ArrowLeft', 37], right: ['ArrowRight', 'ArrowRight', 39], home: ['Home', 'Home', 36], end: ['End', 'End', 35], tab: ['Tab', 'Tab', 9], esc: ['Escape', 'Escape', 27] };
  const press = async name => { await page.key(...KEYS[name]); await sleep(70); };
  const enter = async () => { await page.key('Enter', 'Enter', 13, 0, '\r'); await sleep(110); };
  const personalBefore = await page.stored();
  upstream.script = () => ({ content: [text('Réponse test.')] });

  // 4a. Le pill : petit, discret, dans la zone de saisie, toujours visible
  check('pill : bouton compact et arrondi dans la zone de saisie, texte « Modèle · effort », chevron, aria-haspopup=menu, fermé par défaut', await page.ev(`(()=>{const b=document.querySelector('.vie-foot #vie-pill'),r=b.getBoundingClientRect(),cs=getComputedStyle(b);return !!b&&b.closest('.vie-compose')!==null&&r.height<=38&&r.width<=220&&r.width>=70&&parseFloat(cs.borderTopLeftRadius)>=14&&b.querySelector('svg.vie-chev')!==null&&b.getAttribute('aria-haspopup')==='menu'&&b.getAttribute('aria-expanded')==='false'&&b.getAttribute('aria-controls')==='vie-menu'&&document.querySelector('#vie-pop').hidden===true&&b.querySelector('.vie-pill-txt').textContent==='Haiku 5.5 · Moyen'&&r.top>document.querySelector('#vie-input').getBoundingClientRect().top})()`));
  check('plus aucun ancien sélecteur : ni liste « Niveau de réponse » ni listes Modèle / Difficulté dans le chat ou dans Réglages (pas de navigation vers Réglages)', await page.ev(`!document.querySelector('#vie-mode,#vie-model-select,#vie-effort')&&!document.querySelector('#vie-panel select')&&!/Niveau de réponse|Personnalisé \\(modèle/.test(document.querySelector('#vie-panel').innerText)`));
  await page.shot('vie-pill');

  // 4b. Ouverture par vrai clic : grande popover ancrée, entête, liste compacte, ✓, effort
  check('clic sur le pill : la popover s’ouvre, aria-expanded=true, focus sur la ligne cochée (Défaut)', (await openMenu()) && (await active()) === 'pick:default');
  const geo = await page.ev(`(()=>{const p=document.querySelector('#vie-pop').getBoundingClientRect(),b=document.querySelector('#vie-pill').getBoundingClientRect(),w=document.querySelector('#vie-panel').getBoundingClientRect();return{pb:p.bottom,bt:b.top,pl:p.left,bl:b.left,pw:p.width,ph:p.height,pr:p.right,panelL:w.left,panelR:w.right}})()`);
  check('popover : grande (≈ 344 px), ancrée au pill (alignée à gauche, ouverte vers le haut) et entièrement dans le panneau', geo.pw >= 300 && geo.ph >= 220 && geo.pb <= geo.bt && Math.abs(geo.pl - geo.bl) <= 2 && geo.pl >= geo.panelL && geo.pr <= geo.panelR, JSON.stringify(geo));
  check('popover : entête « Choisir un modèle » et lignes Défaut (recommandé) / Opus 5.5 / Sonnet 5.5 / Haiku 5.5, chacune avec un sous-titre', await page.ev(`(()=>{const rows=[...document.querySelectorAll('#vie-pop [data-pick]')];return document.querySelector('.vie-pop-head').textContent.trim()==='Choisir un modèle'&&rows.map(r=>r.querySelector('.vie-opt-name').textContent).join('|')==='Défaut (recommandé)|Opus 5.5|Sonnet 5.5|Haiku 5.5'&&rows.every(r=>r.querySelector('.vie-opt-desc').textContent.trim().length>8)&&rows[0].querySelector('.vie-opt-desc').textContent.includes('Haiku 5.5 · Moyen')})()`));
  const dense = await page.ev(`(()=>{const rows=[...document.querySelectorAll('#vie-pop [data-pick]')];const pop=document.querySelector('#vie-pop');return{n:rows.length,h:rows.map(r=>Math.round(r.getBoundingClientRect().height)),wide:rows.every(r=>r.getBoundingClientRect().width>pop.clientWidth*0.85),fake:/ultracode|mode approfondi/i.test(pop.innerText),block:getComputedStyle(rows[0].parentElement).display}})()`);
  check('popover : liste compacte, pas de grosses cartes ni de grille (4 lignes pleines largeur de 40 à 72 px), aucun faux « Ultracode » / « Mode approfondi »', dense.n === 4 && dense.h.every(h => h >= 40 && h <= 72) && dense.wide && !dense.fake && dense.block === 'block', JSON.stringify(dense));
  check('✓ : seule la ligne choisie a le fond clair et un ✓ visible, aligné à droite', await page.ev(`(()=>{const sel=document.querySelector('#vie-pop [data-pick][aria-checked="true"]'),oth=[...document.querySelectorAll('#vie-pop [data-pick][aria-checked="false"]')];const c=sel.querySelector('.vie-check'),sr=sel.getBoundingClientRect(),cr=c.getBoundingClientRect();return sel.dataset.pick==='default'&&c.textContent==='✓'&&getComputedStyle(c).visibility==='visible'&&sr.right-cr.right<=18&&cr.left>sr.left+sr.width*0.7&&oth.length===3&&oth.every(o=>getComputedStyle(o.querySelector('.vie-check')).visibility==='hidden'&&getComputedStyle(o).backgroundColor!==getComputedStyle(sel).backgroundColor)})()`));
  check('coût relatif lisible : $ (Haiku, économique) < $$ (Sonnet, intermédiaire) < $$$ (Opus, élevé), aussi annoncé aux lecteurs d’écran, avec mention « estimation, pas une facture »', await page.ev(`(()=>{const g=k=>{const r=document.querySelector('[data-pick="'+k+'"]');return r.querySelector('.vie-cost').textContent+'/'+r.querySelector('.sr-only').textContent};return g('claude-haiku-5-5')==='$/Coût relatif : Économique.'&&g('claude-sonnet-5-5')==='$$/Coût relatif : Intermédiaire.'&&g('claude-opus-5-5')==='$$$/Coût relatif : Élevé.'&&/pas une facture/.test(document.querySelector('.vie-pop-note').textContent)&&/prochain message/.test(document.querySelector('.vie-pop-note').textContent)})()`));
  check('effort : rangée « Effort (Moyen) » en bas, petit contrôle horizontal à 4 crans Faible / Moyen / Élevé / Très élevé, un seul coché', await page.ev(`(()=>{const n=[...document.querySelectorAll('#vie-pop [data-effort]')],e=document.querySelector('.vie-eff-title'),pop=document.querySelector('#vie-pop'),tops=new Set(n.map(x=>Math.round(x.getBoundingClientRect().top)));const lastRow=[...document.querySelectorAll('#vie-pop [data-pick]')].at(-1).getBoundingClientRect().bottom;return n.map(x=>x.textContent).join('|')==='Faible|Moyen|Élevé|Très élevé'&&tops.size===1&&e.textContent.replace(/\\s+/g,' ')==='Effort (Moyen)'&&n.filter(x=>x.getAttribute('aria-checked')==='true').length===1&&n.find(x=>x.getAttribute('aria-checked')==='true').dataset.effort==='medium'&&e.getBoundingClientRect().top>=lastRow-2})()`));
  check('ARIA : menu nommé par l’entête, groupes, menuitemradio avec un seul aria-checked par groupe, pas de rôle inventé', await page.ev(`(()=>{const m=document.querySelector('#vie-menu');const items=[...m.querySelectorAll('[role]')].map(x=>x.getAttribute('role'));return m.getAttribute('role')==='menu'&&document.getElementById(m.getAttribute('aria-labelledby')).textContent==='Choisir un modèle'&&items.filter(r=>r==='menuitemradio').length===8&&items.every(r=>['group','menuitemradio','presentation'].includes(r))&&m.querySelectorAll('[data-pick][aria-checked="true"]').length===1&&[...m.querySelectorAll('[role=group]')].every(g=>g.getAttribute('aria-label')||g.getAttribute('aria-labelledby'))})()`));
  await page.shot('vie-menu-modele');

  // 4c. Le serveur est l'autorité : catalogue affiché = catalogue attesté, rien d'inventé
  const health = await page.ev(`fetch('/api/health',{cache:'no-store'}).then(r=>r.json())`);   // santé AUTHENTIFIÉE : le catalogue n'est remis qu'à la session de la page (un GET anonyme ne le voit pas)
  const uiCat = await page.ev(`window.VieAssistant.catalog()`);
  check('catalogue : celui du navigateur est celui attesté par /api/health (vérifié), et se limite aux modèles autorisés du serveur', JSON.stringify(uiCat) === JSON.stringify(health.catalog) && (await page.ev(`window.VieAssistant.catalogVerified()`)) === true && uiCat.models.every(m => MODELS.includes(m.id)) && JSON.stringify(health.catalog) === JSON.stringify(CATALOG));
  check('liste affichée = catalogue : exactement les modèles attestés + Défaut, aucune autre version (ni Fable, ni Haiku 4.5, ni Sonnet 5, ni Opus 5)', await page.ev(`(()=>{const ids=[...document.querySelectorAll('#vie-pop [data-pick]')].map(r=>r.dataset.pick).sort().join(',');return ids===${JSON.stringify(['default', ...MODELS].sort().join(','))}})()`));

  // 4d. Fermeture : Échap (menu seulement), clic hors du menu, clic sur le pill, Tab
  await press('esc');
  check('Échap : ferme le menu SEUL (panneau toujours ouvert), focus rendu au pill, menu retiré du DOM', !(await menuIsOpen()) && (await page.ev(`document.querySelector('#vie-panel').classList.contains('open')`)) && (await active()) === 'vie-pill' && (await page.ev(`document.querySelector('#vie-menu')===null&&document.querySelector('#vie-pop').hidden`)));
  await openMenu(); await page.realClick('#vie-log');
  check('clic en dehors du menu : fermeture, panneau toujours ouvert', !(await menuIsOpen()) && (await page.ev(`document.querySelector('#vie-panel').classList.contains('open')`)));
  await openMenu(); await page.realClick('#vie-pill');
  check('second clic sur le pill : fermeture (bascule)', !(await menuIsOpen()));
  await openMenu(); await press('tab');
  check('Tab : ferme le menu et rend le focus au pill', !(await menuIsOpen()) && (await active()) === 'vie-pill');

  // 4e. Premier message avec le choix par défaut : le serveur résout « default » ; sélection sans effet de bord
  const nBefore = upstream.calls.length, reqBefore = chatBodies().length;
  await page.ask('Premier message (défaut)');
  const b0 = chatBodies().at(-1);
  check('envoi avec « Défaut (recommandé) » : le navigateur envoie model=default + effort, le serveur le résout en claude-haiku-5-5 / medium (aucun modèle silencieux)', b0.mode === 'custom' && b0.model === 'default' && b0.effort === 'medium' && upstream.calls.length === nBefore + 1 && upstream.calls.at(-1).body.model === 'claude-haiku-5-5' && upstream.calls.at(-1).body.output_config.effort === 'medium' && (await metaLast()).includes('Haiku 5.5') && (await metaLast()).includes('claude-haiku-5-5'));

  // 4f. Choisir un autre modèle
  const callsMark = upstream.calls.length, reqMark = chatBodies().length;
  await openMenu(); await pickRow('claude-sonnet-5-5');
  check('clic sur Sonnet 5.5 : menu fermé, focus au pill, pill « Sonnet 5.5 · Moyen », préférence enregistrée sans secret', !(await menuIsOpen()) && (await active()) === 'vie-pill' && (await pillTxt()) === 'Sonnet 5.5 · Moyen' && await page.ev(`(()=>{const p=JSON.parse(localStorage.getItem('vie-assistant-prefs-v1'));return p.v===2&&p.model==='claude-sonnet-5-5'&&p.effort==='medium'&&!/sk-ant|api|key|token|secret/i.test(JSON.stringify(p))})()`));
  check('changer de modèle ne déclenche AUCUN appel (ni navigateur→serveur ni serveur→Anthropic) et ne modifie pas les données VIE', upstream.calls.length === callsMark && chatBodies().length === reqMark && (await page.stored()) === personalBefore);
  await openMenu();
  check('réouverture : le ✓ est maintenant sur Sonnet 5.5 (et lui seul), l’effort est conservé', (await checked()) === 'claude-sonnet-5-5|medium' && (await active()) === 'pick:claude-sonnet-5-5');
  await press('esc');
  await page.ask('Deuxième message (Sonnet)');
  const b1 = chatBodies().at(-1), up1 = upstream.calls.at(-1).body;
  check('le choix s’applique au message SUIVANT : modèle transmis = claude-sonnet-5-5 / medium, l’ancienne réponse garde son modèle d’origine (Haiku)', b1.model === 'claude-sonnet-5-5' && up1.model === 'claude-sonnet-5-5' && up1.output_config.effort === 'medium' && (await page.ev(`(()=>{const m=[...document.querySelectorAll('.vie-msgmeta')];return m.at(-1).innerText.includes('claude-sonnet-5-5')&&m.at(-2).innerText.includes('claude-haiku-5-5')&&!m.at(-2).innerText.includes('sonnet')})()`)));

  // 4g. Effort dans le même menu : le pill se met à jour, le menu reste ouvert
  await openMenu(); await pickEffort('high');
  check('effort Élevé : le menu reste ouvert, « Effort (Élevé) », pill « Sonnet 5.5 · Élevé », focus conservé sur le cran', (await menuIsOpen()) && (await page.ev(`document.querySelector('.vie-eff-title').textContent.replace(/\\s+/g,' ')`)) === 'Effort (Élevé)' && (await pillTxt()) === 'Sonnet 5.5 · Élevé' && (await active()) === 'effort:high' && (await checked()) === 'claude-sonnet-5-5|high');
  await press('esc');
  await page.ask('Troisième message (Sonnet, effort élevé)');
  check('effort transmis au message suivant : high (serveur → Anthropic output_config.effort), même modèle', chatBodies().at(-1).effort === 'high' && upstream.calls.at(-1).body.output_config.effort === 'high' && upstream.calls.at(-1).body.model === 'claude-sonnet-5-5');

  // 4h. Clavier complet
  await page.ev(`document.querySelector('#vie-pill').focus();true`);
  await press('down');
  check('clavier : ↓ sur le pill ouvre le menu, focus sur la ligne cochée', (await menuIsOpen()) && (await active()) === 'pick:claude-sonnet-5-5');
  const seq = [];
  for (const k of ['down', 'down', 'down', 'up', 'left', 'right', 'right', 'home', 'end']) { await press(k); seq.push(await active()); }
  check('clavier : ↓/↑ parcourent les lignes puis la rangée d’effort (bouclage), ←/→ déplacent entre les crans, Début/Fin', JSON.stringify(seq) === JSON.stringify(['pick:claude-haiku-5-5', 'effort:high', 'pick:default', 'effort:high', 'effort:medium', 'effort:high', 'effort:xhigh', 'pick:default', 'effort:high']), seq.join(' '));
  await press('left'); await press('right'); await press('right'); await enter();
  check('clavier : Entrée sur un cran valide l’effort (Très élevé), menu ouvert, pill à jour', (await menuIsOpen()) && (await pillTxt()) === 'Sonnet 5.5 · Très élevé' && (await checked()) === 'claude-sonnet-5-5|xhigh');
  await press('home'); await press('down'); await page.key(' ', 'Space', 32, 0, ' '); await sleep(120);
  check('clavier : Espace sur une ligne la choisit (Opus 5.5), menu fermé, focus au pill', !(await menuIsOpen()) && (await pillTxt()) === 'Opus 5.5 · Très élevé' && (await active()) === 'vie-pill', await pillTxt() + ' / ' + await active());
  await press('esc');
  check('clavier : Échap sur le pill (menu fermé) replie le panneau comme avant', await page.ev(`!document.querySelector('#vie-panel').classList.contains('open')&&document.activeElement.id==='vie-launch'`));
  await page.click('#vie-launch'); await sleep(500);

  // 4i. Changement pendant une réponse en cours : la demande déjà partie garde son modèle ; le menu ouvert n'est pas perturbé à l'arrivée de la réponse
  upstream.script = async () => { await sleep(900); return { content: [text('Réponse lente.')] }; };
  const slowMark = upstream.calls.length;
  await page.fill('#vie-input', 'Message lent'); await page.click('#vie-send'); await sleep(250);
  await openMenu(); await pickRow('claude-haiku-5-5');
  await page.waitFor(`!document.querySelector('.vie-msg.typing')`, 5000);
  check('changement de modèle PENDANT une demande en cours : la demande partie garde Opus 5.5, le pill indique déjà Haiku 5.5', upstream.calls[slowMark].body.model === 'claude-opus-5-5' && (await pillTxt()) === 'Haiku 5.5 · Très élevé');
  upstream.script = async () => { await sleep(900); return { content: [text('Encore lente.')] }; };
  const markB = upstream.calls.length;
  await page.fill('#vie-input', 'Deuxième message lent'); await page.click('#vie-send'); await sleep(250);
  await openMenu(); await press('down');
  const focusBefore = await active();
  await page.waitFor(`!document.querySelector('.vie-msg.typing')`, 5000); await sleep(200);
  check('réponse qui arrive menu ouvert : le menu reste ouvert, le focus ne saute pas vers la zone de saisie', upstream.calls.length === markB + 1 && (await menuIsOpen()) && (await active()) === focusBefore && focusBefore.startsWith('effort:'), focusBefore + ' / ' + await active());
  await press('esc');
  upstream.script = () => ({ content: [text('Réponse test.')] });

  // 4j. Le backend rejette toute valeur hors catalogue ou non prise en charge (vrai fetch du navigateur avec le jeton de session)
  const callsBeforeBad = upstream.calls.length;
  const bad = await page.ev(`(async()=>{const h=await (await fetch('/api/health')).json();const out=[];for(const b of [{model:'claude-fable-5-1',effort:'high'},{model:'claude-opus-4-8',effort:'high'},{model:'claude-haiku-4-5',effort:'high'},{model:'claude-sonnet-5',effort:'high'},{model:'default',effort:'max'},{model:'claude-sonnet-5-5',effort:'ultra'},{model:'Default',effort:'high'},{model:['claude-haiku-5-5'],effort:'high'},{model:'claude-haiku-5-5'},{effort:'high'}]){const r=await fetch('/api/chat',{method:'POST',headers:{'content-type':'application/json','x-vie-token':h.token},body:JSON.stringify({mode:'custom',share:false,messages:[{role:'user',content:'x'}],...b})});out.push(r.status+':'+(await r.json()).error)}return out.join('|')})()`);
  check('backend : modèles absents du catalogue, effort « max »/« ultra », casse, tableau, champs manquants -> 400 bad_model / bad_effort, aucun appel Anthropic', bad === ['400:bad_model', '400:bad_model', '400:bad_model', '400:bad_model', '400:bad_effort', '400:bad_effort', '400:bad_model', '400:bad_model', '400:bad_effort', '400:bad_model'].join('|') && upstream.calls.length === callsBeforeBad, bad);

  // Les 400 de ces requêtes invalides sont ATTENDUS : le navigateur les journalise comme « erreurs de chargement » ; on ne retire du compteur global que ces entrées-là.
  for (let i = page.errors.length - 1; i >= 0; i--) if (/status of 400 \(Bad Request\) http:\/\/127\.0\.0\.1:\d+\/api\/chat$/.test(page.errors[i])) page.errors.splice(i, 1);

  // 4k. Persistance locale, migration des anciens choix, valeurs hostiles
  await openMenu(); await pickRow('claude-opus-5-5'); await openMenu(); await pickEffort('low'); await press('esc');
  await page.goto(URL_APP); await page.click('#vie-launch'); await page.waitFor(`document.querySelector('#vie-pill .vie-pill-txt')`); await sleep(500);
  check('persistance : après rechargement le pill montre le dernier choix (Opus 5.5 · Faible)', (await pillTxt()) === 'Opus 5.5 · Faible');
  const reload = async (prefs, expectText, label) => {
    await page.ev(`localStorage.setItem('vie-assistant-prefs-v1',${JSON.stringify(JSON.stringify(prefs))});true`);
    await page.goto(URL_APP); await page.click('#vie-launch'); await page.waitFor(`document.querySelector('#vie-pill .vie-pill-txt')`); await sleep(500);
    const t = await pillTxt(); check(label, t === expectText, t); return t;
  };
  await reload({ mode: 'expert', model: 'claude-sonnet-5-5', effort: 'medium' }, 'Opus 5.5 · Élevé', 'migration : ancien niveau « Expert » -> Opus 5.5 · Élevé (le modèle réellement utilisé auparavant)');
  await reload({ mode: 'approfondi' }, 'Sonnet 5.5 · Élevé', 'migration : ancien niveau « Approfondi » -> Sonnet 5.5 · Élevé');
  await reload({ mode: 'custom', model: 'claude-haiku-5-5', effort: 'xhigh' }, 'Haiku 5.5 · Très élevé', 'migration : ancien mode personnalisé (Haiku, xhigh) conservé');
  await reload({ mode: 'rapide', model: 'claude-sonnet-5-5', effort: 'medium' }, 'Haiku 5.5 · Moyen', 'migration : ancien niveau « Rapide » (le défaut) -> Défaut recommandé');
  await openMenu();
  check('migration : après « Rapide », la ligne « Défaut (recommandé) » porte le ✓', (await checked()) === 'default|medium'); await press('esc');
  await reload({ v: 2, model: 'claude-fable-5-1', effort: 'max' }, 'Haiku 5.5 · Moyen', 'valeur mémorisée hors catalogue (Fable, max) : ignorée, retour au défaut recommandé');
  await reload({ v: 2, model: '<img src=x onerror="window.__xss=7">', effort: '"><script>window.__xss=8</script>' }, 'Haiku 5.5 · Moyen', 'valeur mémorisée hostile : ignorée, rien n’est interprété');
  check('valeurs hostiles : aucun script ni image injectés dans le pill ou le menu', await page.ev(`window.__xss===undefined&&document.querySelectorAll('#vie-panel img,#vie-panel script').length===0`));
  await reload({ v: 2, model: 'default', effort: 'medium', share: false }, 'Haiku 5.5 · Moyen', 'défaut propre rétabli pour la suite');
  await openMenu(); await pickRow('default'); await openMenu(); await pickEffort('medium'); await press('esc');

  // 4l. Mobile : le pill reste visible, la popover tient dans l'écran, défile et garde la rangée d'effort visible
  await page.viewport(390, 760);
  await openMenu();
  const mob = await page.ev(`(()=>{const p=document.querySelector('#vie-pop').getBoundingClientRect(),b=document.querySelector('#vie-pill').getBoundingClientRect(),rows=[...document.querySelectorAll('#vie-pop [data-pick]')];return{pl:p.left,pr:p.right,pt:p.top,vw:innerWidth,sw:document.documentElement.scrollWidth,bl:b.left,br:b.right,bt:b.top,minRow:Math.min(...rows.map(r=>r.getBoundingClientRect().height)),notch:Math.min(...[...document.querySelectorAll('#vie-pop [data-effort]')].map(n=>n.getBoundingClientRect().height))}})()`);
  check('mobile 390 px : pill visible, popover entièrement dans l’écran (marges), pas de défilement horizontal, cibles tactiles ≥ 44 px', mob.bl >= 0 && mob.br <= mob.vw && mob.pl >= 0 && mob.pr <= mob.vw && mob.sw <= mob.vw && mob.pt >= 0 && mob.minRow >= 44 && mob.notch >= 44, JSON.stringify(mob));
  await page.shot('vie-menu-mobile');
  await press('esc'); await page.viewport(390, 480); await openMenu();
  const low = await page.ev(`(()=>{const pop=document.querySelector('#vie-pop'),eff=document.querySelector('.vie-pop-effort').getBoundingClientRect(),pb=pop.getBoundingClientRect();return{scrollable:pop.scrollHeight>pop.clientHeight+4,top:pb.top,effInside:eff.top>=pb.top&&eff.bottom<=pb.bottom+1,ov:getComputedStyle(pop).overflowY}})()`);
  check('écran très bas (390×480) : la popover défile (overflow auto), reste dans la fenêtre, et la rangée d’effort reste visible en bas', low.scrollable && low.top >= 0 && low.effInside && /auto|scroll/.test(low.ov), JSON.stringify(low));
  await page.shot('vie-menu-mobile-bas');
  await press('esc'); await page.clearViewport();

  // 4m. Réglages : plus de sélecteur de modèle, simple renvoi vers le pill
  await page.click('[data-vie="toggle-settings"]');
  check('Réglages de Vie : aucun sélecteur de modèle (renvoi vers le pill), partage et confidentialité inchangés', await page.ev(`(()=>{const s=document.querySelector('#vie-settings');return !s.hidden&&!s.querySelector('select')&&/zone de saisie/.test(s.innerText)&&!!s.querySelector('#vie-share')})()`));

  // 5. Consentement
  check('partage : désactivé par défaut avant tout consentement', await page.ev(`document.querySelector('#vie-share').checked===false&&!JSON.parse(localStorage.getItem('vie-assistant-prefs-v1')).consent`));
  await page.click('#vie-share');
  check('partage : première activation -> carte de consentement visible, case non cochée', await page.ev(`!!document.querySelector('.vie-consent')&&document.querySelector('#vie-share').checked===false&&document.querySelector('.vie-consent').innerText.includes('Anthropic')`));
  await page.shot('vie-consentement');
  await page.click('[data-vie="consent-refuse"]'); upstream.calls.length = 0; await page.ask('Combien ai-je dépensé ce mois-ci ?');
  check('consentement refusé : chat général, aucune donnée envoyée, aucun outil de modification d’élément (seuls les réglages restent proposables, avec confirmation)', !!upstream.calls.length && ctxOf(upstream.calls[0].body) === null && !JSON.stringify(upstream.calls[0].body).includes('Netflix') && noItemMutationTools(upstream.calls[0].body.tools));
  await page.click('#vie-share'); await page.click('[data-vie="consent-accept"]');
  check('consentement accepté : partage activé et mémorisé', await page.ev(`document.querySelector('#vie-share').checked&&JSON.parse(localStorage.getItem('vie-assistant-prefs-v1')).consent===true&&JSON.parse(localStorage.getItem('vie-assistant-prefs-v1')).share===true&&!document.querySelector('.vie-consent')`));
  await page.click('[data-vie="toggle-settings"]');

  // 6. Question sur les finances : contexte minimal ciblé
  upstream.script = () => ({ content: [text('Tu as saisi 12,50 € de dépenses ce mois-ci (Netflix).')] }); upstream.calls.length = 0;
  await page.ask('Combien ai-je dépensé ce mois-ci en dépenses ?');
  const ctx = ctxOf(upstream.calls[0].body);
  check('partage actif : seules les sections utiles sont envoyées (dépenses), sans prénom ni notes', !!ctx && ctx.transactions && ctx.transactions.some(t => t.label === 'Netflix') && !ctx.applications && !ctx.tasks && !JSON.stringify(ctx).includes('displayName') && ctx.sections.includes('transactions'));
  check('partage actif : l’interface indique les rubriques réellement envoyées', await page.ev(`[...document.querySelectorAll('.vie-msgmeta')].pop().innerText.includes('Données envoyées à Anthropic : transactions')`));

  // 7. Modification d'un montant par identifiant : prévisualisation, confirmation, persistance, annulation
  upstream.script = body => { const x = ctxOf(body).transactions.find(t => t.label === 'Netflix'); return { stop: 'tool_use', content: [text('Je te propose de corriger le montant.'), tool('propose_update', { entity: 'transactions', id: x.id, changes: [{ field: 'amount', value: 15 }], reason: 'Hausse du tarif' })] }; };
  await page.ask('Change le montant de Netflix à 15 € (dépense)');
  const ct = await cardText(page);
  check('proposition : cible, identifiant, ancienne valeur, nouvelle valeur et conséquence affichés', ct.includes('Netflix') && ct.includes(netflix.id) && /12,50/.test(ct) && /15,00/.test(ct) && ct.includes('Conséquence') && /Dépenses saisies du mois/.test(ct) && ct.includes('Hausse du tarif'), ct.replace(/\n/g, ' | ').slice(0, 200));
  check('proposition : rien n’est modifié avant confirmation', (await page.state()).transactions.find(t => t.id === netflix.id).amount === 12.5);
  await page.shot('vie-proposition');
  page.dialogs.length = 0; await page.click('[data-vie="apply"]'); await page.waitFor(`document.querySelector('.vie-card.applied')`);
  const s1 = await page.state();
  check('confirmation explicite (montant = donnée financière) puis modification persistée par identifiant', page.dialogs.length === 1 && /Montant/.test(page.dialogs[0]) && s1.transactions.find(t => t.id === netflix.id).amount === 15 && s1.transactions.length === s0.transactions.length);
  check('carte passe à « Appliqué », journal alimenté, V1 toujours valide', await page.ev(`document.querySelector('.vie-card.applied')&&JSON.parse(localStorage.getItem('vie-assistant-audit-v1')).length===1`) && (() => { try { C.validateImported(s1); return true; } catch (e) { return false; } })());
  await page.click('#nav [data-view="finance"]');
  check('l’écran Finances reflète le nouveau montant', await page.ev(`document.querySelector('#view').innerText.includes('15,00')`));
  await page.click('.vie-card.applied [data-vie="undo"]'); await page.waitFor(`document.querySelector('.vie-card.undone')`);
  check('annulation depuis le journal : montant restauré (12,5)', (await page.state()).transactions.find(t => t.id === netflix.id).amount === 12.5 && await page.ev(`JSON.parse(localStorage.getItem('vie-assistant-audit-v1'))[0].status==='undone'`));

  // 8. Concurrence : deux propositions sur le même champ
  upstream.script = body => { const x = ctxOf(body).transactions.find(t => t.label === 'Netflix'); return { stop: 'tool_use', content: [text('Deux options :'), tool('propose_update', { entity: 'transactions', id: x.id, changes: [{ field: 'amount', value: 20 }] }), tool('propose_update', { entity: 'transactions', id: x.id, changes: [{ field: 'amount', value: 25 }] })] }; };
  await page.ask('Quel montant pour Netflix (dépense) ?');
  check('lot : barre « Lot de 2 modifications » avec Tout appliquer / Tout refuser', await page.ev(`!!document.querySelector('.vie-bulk')&&document.querySelectorAll('.vie-card.pending').length===2`));
  await page.click('[data-vie="apply-all"]'); await page.waitFor(`document.querySelectorAll('.vie-card.failed').length===2`);
  check('lot atomique : conflit détecté, aucune des deux modifications n’est enregistrée', (await page.state()).transactions.find(t => t.id === netflix.id).amount === 12.5 && /Conflit/.test(await page.ev(`document.querySelector('.vie-card.failed').innerText`)));
  await page.ask('Quel montant pour Netflix (dépense), encore ?');
  await page.ev(`(()=>{const cards=document.querySelectorAll('.vie-card.pending');window.__second=cards[1].querySelector('[data-vie=apply]');cards[0].querySelector('[data-vie=apply]').click();return true})()`);
  await page.waitFor(`document.querySelector('.vie-card.applied')`);
  await page.ev(`document.querySelector('.vie-card.pending [data-vie=apply]').click()`); await page.waitFor(`document.querySelector('.vie-card.failed')`);
  const sc = await page.state();
  check('deux mises à jour concurrentes : la première appliquée (20), la seconde refusée (conflit) sans écraser', sc.transactions.find(t => t.id === netflix.id).amount === 20 && /Conflit/.test(await page.ev(`document.querySelector('.vie-card.failed').innerText`)));

  // 9. Échec de persistance : aucun faux succès
  upstream.script = body => { const x = ctxOf(body).transactions.find(t => t.label === 'Netflix'); return { stop: 'tool_use', content: [tool('propose_update', { entity: 'transactions', id: x.id, changes: [{ field: 'amount', value: 40 }] })] }; };
  await page.ask('Mets Netflix (dépense) à 40');
  const beforeFail = await page.stored();
  await page.ev(`window.__realSet=Storage.prototype.setItem;Storage.prototype.setItem=function(k){if(k==='${KEY}')throw new DOMException('quota','QuotaExceededError');return window.__realSet.apply(this,arguments)};true`);
  await page.click('.vie-card.pending [data-vie="apply"]'); await page.waitFor(`document.querySelector('.vie-card.pending')===null`);
  check('échec d’écriture : carte « Non appliqué », message d’échec, stockage intact, aucun « Appliqué »', await page.ev(`!!document.querySelector('.vie-card.failed:last-of-type, .vie-card.failed')&&![...document.querySelectorAll('.vie-card')].pop().classList.contains('applied')`) && (await page.stored()) === beforeFail && /Enregistrement impossible/.test(await page.toast()) && /Rien n’a été modifié/.test(await cardText(page)));
  await page.ev(`Storage.prototype.setItem=window.__realSet;true`);
  check('échec d’écriture : l’écran garde l’ancienne valeur (20), pas la valeur non enregistrée', (await page.state()).transactions.find(t => t.id === netflix.id).amount === 20);

  // 10. Navigation automatique + replan
  upstream.script = () => ({ stop: 'tool_use', content: [text('Je t’ouvre les candidatures.'), tool('navigate_section', { section: 'career' })] });
  await page.ask('Va dans les candidatures');
  check('navigation : rubrique ouverte automatiquement sans confirmation, focus rendu à la saisie', await page.ev(`document.querySelector('#view').innerText.includes('Mes candidatures')&&document.querySelector('.vie-card.auto')&&document.activeElement.id==='vie-input'`));
  upstream.script = () => ({ stop: 'tool_use', content: [text('Je recalcule ta semaine.'), tool('replan_week', { weekStart: '2026-11-16' })] });
  const beforePlan = await page.stored();
  await page.ask('Recalcule ma semaine du 16 novembre');
  check('replan_week : planificateur existant affiché (semaine du 16 nov.), explication « non stocké », aucune écriture', await page.ev(`document.querySelector('#view').innerText.includes('Ta semaine')&&[...document.querySelectorAll('.vie-card.auto')].pop().innerText.includes('Semaine du 2026-11-16')&&[...document.querySelectorAll('.vie-card.auto')].pop().innerText.includes('rien n’est modifié')`) && (await page.stored()) === beforePlan);
  await page.shot('vie-replan');

  // 11. Suppression : sauvegarde JSON préalable, confirmation, annulation
  upstream.script = body => { const x = ctxOf(body).transactions.find(t => t.label === 'Netflix'); return { stop: 'tool_use', content: [tool('propose_delete', { entity: 'transactions', id: x.id, reason: 'Doublon' })] }; };
  await page.ask('Supprime la dépense Netflix');
  check('suppression : carte sensible, bouton « Supprimer… », ancienne valeur affichée', await page.ev(`!!document.querySelector('.vie-card.sensitive')&&document.querySelector('.vie-card.pending [data-vie=apply]').innerText.startsWith('Supprimer')`));
  for (const f of exportFiles()) fs.unlinkSync(path.join(downloads, f));
  const idxBefore = (await page.state()).transactions.findIndex(t => t.id === netflix.id);
  page.dialogs.length = 0; page.refuseNext = true; await page.click('.vie-card.pending [data-vie="apply"]'); await sleep(300);
  check('suppression : refus dans la confirmation -> rien supprimé, aucun téléchargement', (await page.state()).transactions.some(t => t.id === netflix.id) && exportFiles().length === 0 && page.dialogs.length === 1);
  await page.click('.vie-card.pending [data-vie="apply"]'); await page.waitFor(`document.querySelector('.vie-card.applied')`); let bk = null; for (let i = 0; i < 40 && !bk; i++) { bk = exportFiles()[0]; await sleep(100); }
  const afterDel = await page.state();
  check('suppression confirmée : sauvegarde JSON téléchargée AVANT, élément supprimé', !!bk && JSON.parse(fs.readFileSync(path.join(downloads, bk), 'utf8')).transactions.some(t => t.id === netflix.id) && !afterDel.transactions.some(t => t.id === netflix.id));
  await page.ev(`[...document.querySelectorAll('.vie-card.applied [data-vie=undo]')].pop().click();true`); await page.waitFor(`document.querySelectorAll('.vie-card.undone').length>=2`);
  const afterUndo = await page.state();
  check('annulation d’une suppression : élément restauré à la même position avec ses valeurs', afterUndo.transactions.findIndex(t => t.id === netflix.id) === idxBefore && afterUndo.transactions[idxBefore].amount === 20 && afterUndo.transactions[idxBefore].label === 'Netflix');

  // 12. Réponse forgée / serveur compromis : revalidation côté client
  await page.ev(`window.__fetch=window.fetch;window.fetch=(u,o)=>String(u).includes('/api/chat')?Promise.resolve(new Response(JSON.stringify({ok:true,reply:'Réponse forgée',proposals:[{kind:'update',entity:'transactions',id:'${netflix.id}',changes:[{field:'type',value:'income'}]},{kind:'update',entity:'settings',id:'settings',changes:[{field:'__proto__',value:1}]},{kind:'eval',code:'alert(1)'},{kind:'delete',entity:'projects',id:'lernlabor'}],rejected:[],model:'claude-haiku-5-5',effort:'medium',label:'Rapide',usage:{inputTokens:1,outputTokens:1,approxCostUsd:0}}),{status:200})):window.__fetch(u,o);true`);
  const before12 = await page.stored(); await page.ask('test réponse forgée'); await page.ev(`window.fetch=window.__fetch;true`);
  check('réponse serveur forgée : propositions hors liste blanche ignorées côté client, aucune carte, aucune écriture', await page.ev(`document.querySelectorAll('.vie-card.pending').length===0&&document.querySelector('.vie-note')&&document.querySelector('.vie-note').innerText.includes('4 proposition')`) && (await page.stored()) === before12);

  // 13. Persistance de la conversation, purge, expiration
  upstream.script = null;
  await page.goto(URL_APP); await page.click('#vie-launch');
  check('après rechargement : conversation et préférences restaurées (texte seulement)', await page.ev(`document.querySelectorAll('.vie-msg.user').length>=5&&document.querySelectorAll('.vie-card').length===0&&JSON.parse(localStorage.getItem('vie-assistant-prefs-v1')).share===true`));
  check('journal des actions : conservé après rechargement', await page.ev(`JSON.parse(localStorage.getItem('vie-assistant-audit-v1')).length>=3`));
  await page.click('[data-vie="clear"]'); await sleep(200);
  check('« Effacer la conversation » : vide l’écran et le stockage, données VIE et journal intacts', await page.ev(`!!document.querySelector('.vie-empty')&&localStorage.getItem('vie-assistant-chat-v1')===null&&JSON.parse(localStorage.getItem('vie-assistant-audit-v1')).length>=3`) && (await page.state()).transactions.some(t => t.id === netflix.id));
  await page.ask('message de test expiration'); await page.ev(`(()=>{const c=JSON.parse(localStorage.getItem('vie-assistant-chat-v1'));c.savedAt=Date.now()-8*86400000;localStorage.setItem('vie-assistant-chat-v1',JSON.stringify(c));return true})()`);
  await page.goto(URL_APP); await page.click('#vie-launch');
  check('durée limitée : une conversation de plus de 7 jours est purgée au chargement', await page.ev(`!!document.querySelector('.vie-empty')&&localStorage.getItem('vie-assistant-chat-v1')===null`));

  // 13b. Stabilisation sécurité/vie privée (audit Codex) : notes jamais envoyées, partage coupé = historique sans fiches, ancien consentement non reconduit,
  //      réponse tardive et confirmation tardive sur une liste de créneaux modifiée entre-temps.
  const CANARY = 'CANARY-NOTES-7f3a91c2';
  const settingsOpen = () => page.ev(`!document.querySelector('#vie-settings').hidden`);
  const openSettings = async () => { if (!(await settingsOpen())) await page.click('[data-vie="toggle-settings"]'); };
  const closeSettings = async () => { if (await settingsOpen()) await page.click('[data-vie="toggle-settings"]'); };
  const blocks = async () => JSON.stringify((await page.state()).settings.courseBlocks);
  const seedBlocks = () => page.ev(`VieHost.mutate(d=>{d.settings.courseBlocks=[{title:'Algo',day:1,start:'08:00',end:'10:00'},{title:'Réseaux',day:2,start:'09:00',end:'10:00'}];return{ok:true}}).ok`);
  check('préparation : état de test avec idée à notes marquées, note de tâche et deux cours', await page.ev(`VieHost.mutate(d=>{d.ideas=[{id:'idea-canary',title:'Idée visible',notes:'${CANARY}',status:'En réflexion'}];d.tasks[0].notes='${CANARY}-tache';return{ok:true}}).ok`) && await seedBlocks());
  upstream.script = () => ({ content: [text('Tes idées : « Idée visible ».')] }); upstream.calls.length = 0;
  await page.ask('Montre-moi mes idées');
  const cIdeas = ctxOf(upstream.calls[0].body);
  check('vie privée : « mes idées » envoie titre et statut, jamais les notes — le marqueur n’apparaît nulle part dans la requête sortante', !!cIdeas && cIdeas.ideas.some(i => i.title === 'Idée visible' && i.notes === undefined) && !JSON.stringify(upstream.calls[0].body).includes(CANARY));
  upstream.script = () => ({ content: [text('Bien reçu.')] });
  await openSettings(); await page.click('#vie-share'); await closeSettings();
  check('partage coupé depuis l’interface : case décochée, préférence enregistrée, consentement conservé', await page.ev(`(()=>{const p=JSON.parse(localStorage.getItem('vie-assistant-prefs-v1'));return p.share===false&&p.consent===true&&/non partagées/.test(document.querySelector('#vie-meta').innerText)})()`));
  upstream.calls.length = 0; await page.ask('Merci, autre chose ?');
  const off = upstream.calls[0].body;
  check('partage coupé : aucune fiche, outils de modification retirés, et l’échange précédent bâti sur les fiches n’est PAS renvoyé dans l’historique', ctxOf(off) === null && !JSON.stringify(off).includes('donnees_vie>\n') && !JSON.stringify(off.messages).includes('Montre-moi mes idées') && !JSON.stringify(off.messages).includes('Tes idées') && !JSON.stringify(off).includes(CANARY) && noItemMutationTools(off.tools) && /désactivé/.test(JSON.stringify(off.messages)));
  upstream.calls.length = 0; await page.ask('Encore une question');
  check('partage coupé : les échanges déjà faits sans fiches restent dans l’historique, ceux bâtis sur les fiches jamais', JSON.stringify(upstream.calls[0].body.messages).includes('Merci, autre chose ?') && !JSON.stringify(upstream.calls[0].body.messages).includes('Montre-moi mes idées'));
  await openSettings(); await page.click('#vie-share'); await closeSettings();
  upstream.calls.length = 0; await page.ask('Et mes idées ?');
  check('partage réactivé (consentement conservé) : le contexte repart, sans les notes, et l’historique complet est de nouveau envoyé', !!ctxOf(upstream.calls[0].body) && JSON.stringify(upstream.calls[0].body.messages).includes('Montre-moi mes idées') && !JSON.stringify(upstream.calls[0].body).includes(CANARY));
  // Consentement donné sur l'ancien texte (inexact) : non reconduit
  await page.ev(`localStorage.setItem('vie-assistant-prefs-v1',JSON.stringify({mode:'rapide',model:'claude-sonnet-5-5',effort:'medium',share:true,consent:true,consentAt:'2026-11-01T00:00:00.000Z',migrationDismissed:true}));true`);
  await page.goto(URL_APP); await page.click('#vie-launch'); await page.waitFor(`!document.querySelector('.vie-banner.warn')`);
  check('ancien consentement (texte inexact) non reconduit : partage désactivé au chargement, bannière explicative, aucun contexte envoyé', await page.ev(`/non partagées/.test(document.querySelector('#vie-meta').innerText)&&/n’est pas reconduit/.test(document.querySelector('#vie-status').innerText)`) && await (async () => { upstream.calls.length = 0; await page.ask('Où en sont mes dépenses ?'); return ctxOf(upstream.calls[0].body) === null; })());
  await openSettings(); await page.click('#vie-share');
  const consentText = await page.ev(`document.querySelector('.vie-consent')?document.querySelector('.vie-consent').innerText:''`);
  check('texte de consentement exact : annonce ce qui part (dont l’historique), que les notes ne partent pas, et que le texte saisi à la main part tel quel', /Jamais envoyés/.test(consentText) && /notes/.test(consentText) && /part tel quel/.test(consentText) && /historique/.test(consentText) && /idées/.test(consentText) && !/Sont exclus : ton prénom, tes notes/.test(consentText) && !/minimale/.test(consentText), consentText.slice(0, 160));
  check('consentement : chaque champ réellement envoyé est nommé (liste générée depuis le code : compteurs, rubriques avec limites, planning, réglages), avec ce qui part TOUJOURS (messages précédents compris)', await page.ev(`(()=>{const t=document.querySelector('.vie-consent').innerText,L=VieActions.SHARE_LABELS;const lab=[...Object.values(L.overview),...Object.values(L.derived),...Object.values(L.settings),L.habitChecks,...Object.values(L.rows).flatMap(r=>Object.values(r[1]))];const miss=lab.filter(x=>!t.includes(x));return miss.length===0&&/Planning/.test(t)&&/Réglages/.test(t)&&/budget de vie courante/.test(t)&&/revenu mensuel visé/.test(t)&&/Toujours, même partage coupé/.test(t)&&/tes messages précédents/.test(t)&&/tes propres messages/.test(t)&&/\\(50 au plus\\)/.test(t)})()`));
  check('compteur de coût : « estimé » et « remis à zéro au redémarrage » visibles dans la barre (pas seulement en infobulle)', await page.ev(`(()=>{const m=document.querySelector('#vie-meta').innerText;return /Compteur estimé du jour/.test(m)&&/remis à zéro au redémarrage/.test(m)})()`));
  await page.click('[data-vie="consent-accept"]'); await closeSettings();
  check('nouveau consentement : version du texte enregistrée, partage actif', await page.ev(`(()=>{const p=JSON.parse(localStorage.getItem('vie-assistant-prefs-v1'));return p.consent===true&&p.share===true&&p.consentV===2})()`));
  // Réponse tardive : la liste des cours change pendant que Vie répond
  await seedBlocks();
  let openGate; const gate = new Promise(r => { openGate = r; });
  upstream.script = async () => { await gate; return { stop: 'tool_use', content: [text('Je décale ton premier cours.'), tool('propose_update', { entity: 'courseBlocks', id: 'cb-0', changes: [{ field: 'end', value: '11:00' }] })] }; };
  await page.fill('#vie-input', 'Décale mon premier cours (planning, horaires)'); await page.click('#vie-send');
  await page.waitFor(`!!document.querySelector('.vie-msg.typing')`);
  await page.ev(`VieHost.mutate(d=>{d.settings.courseBlocks.splice(0,1);return{ok:true}}).ok`);
  openGate(); await page.waitFor(`!!document.querySelector('.vie-card')&&!document.querySelector('.vie-msg.typing')`);
  check('réponse tardive : la liste des cours a changé pendant que Vie répondait -> « cb-0 » refusé, aucune carte à confirmer, rien modifié', await page.ev(`!!document.querySelector('.vie-card.invalid')&&!document.querySelector('.vie-card.pending')&&/a changé pendant que Vie répondait/.test(document.querySelector('.vie-card').innerText)`) && await blocks() === JSON.stringify([{ title: 'Réseaux', day: 2, start: '09:00', end: '10:00' }]));
  // Témoin : sans dérive, la même proposition est applicable (et annulable)
  await seedBlocks();
  upstream.script = () => ({ stop: 'tool_use', content: [text('Je décale le second cours.'), tool('propose_update', { entity: 'courseBlocks', id: 'cb-1', changes: [{ field: 'end', value: '11:00' }] })] });
  await page.ask('Décale mon second cours (planning, horaires)');
  await page.click('.vie-card.pending [data-vie="apply"]'); await page.waitFor(`document.querySelector('.vie-card.applied')`);
  check('témoin sans dérive : la modification du créneau est appliquée au bon élément (cb-1)', await blocks() === JSON.stringify([{ title: 'Algo', day: 1, start: '08:00', end: '10:00' }, { title: 'Réseaux', day: 2, start: '09:00', end: '11:00' }]));
  await page.ev(`[...document.querySelectorAll('.vie-card.applied [data-vie=undo]')].pop().click();true`); await page.waitFor(`document.querySelector('.vie-card.undone')`);
  check('témoin sans dérive : annulation acceptée, liste restituée à l’identique', await blocks() === JSON.stringify([{ title: 'Algo', day: 1, start: '08:00', end: '10:00' }, { title: 'Réseaux', day: 2, start: '09:00', end: '10:00' }]));
  // Confirmation tardive : A (cb-0) prévisualisé, A supprimé, B glisse en cb-0 avec la même fin
  upstream.script = () => ({ stop: 'tool_use', content: [text('Je décale le premier cours.'), tool('propose_update', { entity: 'courseBlocks', id: 'cb-0', changes: [{ field: 'end', value: '11:00' }] })] });
  await page.ask('Décale mon premier cours (planning, horaires)');
  check('confirmation tardive (préparation) : carte « cb-0, fin 10:00 → 11:00 » en attente', await page.ev(`!!document.querySelector('.vie-card.pending')&&/10:00/.test(document.querySelector('.vie-card.pending').innerText)&&/11:00/.test(document.querySelector('.vie-card.pending').innerText)`));
  await page.ev(`VieHost.mutate(d=>{d.settings.courseBlocks.splice(0,1);return{ok:true}}).ok`);
  await page.click('.vie-card.pending [data-vie="apply"]'); await page.waitFor(`document.querySelector('.vie-card.failed')`);
  check('confirmation tardive : A supprimé entre-temps, B glissé en cb-0 avec la même fin -> refus (conflit), B INCHANGÉ', await page.ev(`/Conflit/.test(document.querySelector('.vie-card.failed').innerText)`) && await blocks() === JSON.stringify([{ title: 'Réseaux', day: 2, start: '09:00', end: '10:00' }]));
  check('vie privée : aucune requête du navigateur ne contient le marqueur des notes', !page.requests.some(r => (r.post || '').includes(CANARY)) && !upstream.calls.some(c => JSON.stringify(c.body).includes(CANARY)));
  await page.ev(`VieHost.mutate(d=>{d.settings.courseBlocks=[];return{ok:true}}).ok`);

  // 14. Aucune clé dans le navigateur
  const dump = await page.ev(`JSON.stringify({html:document.documentElement.outerHTML,ls:Object.entries(localStorage),scripts:[...document.scripts].map(s=>s.src)})`);
  check('aucune clé API dans le DOM, le stockage local ni les requêtes réseau du navigateur', !dump.includes(FAKE_KEY) && !/sk-ant/.test(dump) && !page.requests.some(r => (r.url + r.post + r.headers).includes(FAKE_KEY) || /sk-ant/.test(r.post + r.headers)));
  check('le navigateur ne contacte que 127.0.0.1 (jamais Anthropic directement)', page.requests.every(r => r.url.startsWith(`http://127.0.0.1:${port}/`) || r.url.startsWith(`http://localhost:${port}/`) || r.url.startsWith('data:') || r.url.startsWith('blob:') || r.url === 'about:blank'));
  check('aucune erreur JavaScript pendant toute la session de chat', page.errors.length === 0, page.errors.slice(0, 3).join(' | '));

  // 15. Mode récupération V1 : aucune écriture possible depuis le chat
  await page.ev(`localStorage.setItem('${KEY}','{"version":1,"tasks":[null')`); await page.goto(URL_APP); await page.click('#vie-launch');
  upstream.script = () => ({ stop: 'tool_use', content: [tool('propose_create', { entity: 'ideas', values: [{ field: 'title', value: 'Idée en mode récupération' }] })] }); upstream.calls.length = 0;
  await page.ask('Ajoute une idée');
  check('récupération : avertissement visible, partage de données désactivé automatiquement', await page.ev(`document.querySelector('.vie-banner.warn').innerText.includes('mode récupération')`) && /désactivé/.test(JSON.stringify(upstream.calls[0].body.messages)) && ctxOf(upstream.calls[0].body) === null);
  await page.click('.vie-card.pending [data-vie="apply"]'); await sleep(250);
  check('récupération : la proposition est refusée, texte brut du stockage intact', (await page.stored()) === '{"version":1,"tasks":[null' && /mode récupération/.test(await cardText(page)));
  await page.ev(`localStorage.removeItem('${KEY}')`);

  // 16. Responsive avec panneau ouvert
  await page.goto(URL_APP);
  const views = ['today', 'week', 'projects', 'study', 'career', 'life', 'finance', 'goals', 'ideas', 'settings'];
  for (const w of [390, 768, 1440]) {
    await page.viewport(w); let over = [];
    await page.ev(`document.querySelector('#vie-panel').classList.contains('open')||document.querySelector('#vie-launch').click();true`); await sleep(400);
    for (const v of views) { await page.ev(`window.VieHost.navigate('${v}');true`); await sleep(40); if (await page.ev('document.documentElement.scrollWidth>window.innerWidth||document.querySelector("#vie-panel").getBoundingClientRect().right>window.innerWidth+1')) over.push(v); }
    check(`largeur ${w} px, panneau ouvert : aucun débordement horizontal (10 rubriques)`, over.length === 0, over.join(','));
    await page.shot('vie-' + w);
    await page.ev(`document.querySelector('#vie-launch').getAttribute('aria-expanded')==='true'&&document.querySelector('#vie-launch').click();true`); await sleep(100);
    let overClosed = []; for (const v of views) { await page.ev(`window.VieHost.navigate('${v}');true`); await sleep(30); if (await page.ev('document.documentElement.scrollWidth>window.innerWidth')) overClosed.push(v); }
    check(`largeur ${w} px, panneau replié : aucun débordement horizontal`, overClosed.length === 0, overClosed.join(','));
  }
  await page.ev(`Emulation=0;true`).catch(() => {});

  // 17. Hors ligne : serveur local arrêté
  await page.viewport(1440); await page.goto(URL_APP); await page.click('#vie-launch'); page.errors.length = 0;
  await vie.close(); await sleep(200);
  await page.fill('#vie-input', 'Tu es là ?'); await page.click('#vie-send'); await page.waitFor(`document.querySelector('.vie-msg.bot.error')||document.querySelector('.vie-banner.warn')`);
  check('serveur arrêté : message clair (injoignable / relancer node vie-server.cjs), envoi désactivé', await page.ev(`/injoignable|node vie-server\\.cjs/.test(document.querySelector('#vie-status').innerText)&&document.querySelector('#vie-send').disabled===true`));
  await page.click('#vie-launch'); await page.click('#nav [data-view="today"]'); await page.click('[data-action="add-task"]'); await page.fill('#field-title', 'Tâche hors ligne'); await page.click('#modal-save'); await sleep(250);
  check('serveur arrêté : le site non-IA continue de fonctionner (navigation, tâche créée et persistée)', (await page.ev(`document.querySelectorAll('button.nav-btn').length`)) === 10 && (await page.state()).tasks.some(x => x.title === 'Tâche hors ligne'));

  // 18. Serveur sans clé
  vie = createVieServer({ env: {}, envFile: path.join(tmp, 'absent.env'), fetch: mockFetch, log: () => {}, limits: { perMinute: 1000 } });
  const port2 = await vie.listen(0);
  await page.goto(app(port2) + '#vie-boot=' + vie.issueLaunchTicket()); await page.click('#vie-launch'); await page.waitFor(`/Clé API absente/.test(document.querySelector('#vie-status').innerText)`);
  check('clé absente : bannière explicite (.env, jamais dans le navigateur), envoi désactivé', await page.ev(`/Clé API absente/.test(document.querySelector('#vie-status').innerText)&&/\\.env/.test(document.querySelector('#vie-status').innerText)&&document.querySelector('#vie-send').disabled`));
  await vie.close();

  // 19. file:// : le site classique reste utilisable, l’IA indique que le serveur local est requis
  const fileUrl = pathToFileURL(path.join(__dirname, 'index.html')).href;
  const nReq = page.requests.length; page.errors.length = 0;
  await page.goto(fileUrl); await page.click('#vie-launch');
  check('file:// : le site classique fonctionne (10 rubriques) sans erreur JavaScript', (await page.ev(`document.querySelectorAll('button.nav-btn').length`)) === 10 && page.errors.length === 0, page.errors.slice(0, 2).join(' | '));
  check('file:// : Vie explique qu’il faut le serveur local avec la commande et l’URL exactes, sans appel réseau', await page.ev(`(()=>{const t=document.querySelector('#vie-status').innerText;return t.includes('node vie-server.cjs')&&t.includes('http://127.0.0.1:3765/')&&document.querySelector('#vie-send').disabled})()`) && !page.requests.slice(nReq).some(r => r.url.includes('/api/')));
  await page.shot('vie-file');
  check('file:// (serveur absent) : le pill reste visible avec le catalogue de secours, identique à celui du serveur mais signalé « non vérifié » dans le menu', await page.ev(`(()=>{document.querySelector('#vie-pill').click();return true})()`) && await page.ev(`JSON.stringify(window.VieAssistant.catalog())`) === JSON.stringify(CATALOG) && (await page.ev(`window.VieAssistant.catalogVerified()`)) === false && (await page.ev(`document.querySelector('#vie-pill .vie-pill-txt').textContent==='Haiku 5.5 · Moyen'&&/Serveur injoignable : liste locale non vérifiée/.test(document.querySelector('.vie-pop-note').textContent)&&document.querySelector('#vie-send').disabled`)));
  await page.key('Escape', 'Escape', 27);

  await b.send('Browser.close').catch(() => {}); await Promise.race([b.closed, sleep(8000)]);
})().catch(err => { check('exécution du script', false, err.stack || String(err)); }).finally(async () => {
  try { if (vie) await vie.close(); } catch (e) { /* déjà fermé */ }
  if (current && current.proc.exitCode === null) { try { current.proc.kill(); } catch (e) { /* déjà fermé */ } await Promise.race([current.closed, sleep(5000)]); }
  await sleep(500);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { console.log('Nettoyage du profil jetable à faire à la main :', tmp); }
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} PASS${failed ? `, ${failed} FAIL` : ''}`);
  process.exit(failed ? 1 : 0);
});
