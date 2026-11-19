// Vérification NAVIGATEUR RÉELLE du mode structure (écriture de code) : Chrome ou Edge (profil JETABLE), vrai serveur vie-server.cjs dans ce processus,
// faux Anthropic (aucun réseau, aucun coût, aucune vraie clé), COPIE temporaire des fichiers web (le vrai code n'est jamais modifié, aucun .env).
//   node test_vie_code_browser.cjs "C:\Program Files\Google\Chrome\Application\chrome.exe"
//   node test_vie_code_browser.cjs "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createVieServer } = require('./vie-server.cjs');
const D = require('./vie-dev.cjs');

const exe = process.argv[2];
if (!exe || !fs.existsSync(exe)) { console.log('NON TESTÉ : chemin du navigateur absent ou introuvable (argument 1).'); process.exit(2); }
const FAKE_KEY = 'FAKE-BROWSER-CODE-KEY-NOT-A-SECRET-0123456789';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vie-code-browser-')));
const profile = path.join(tmp, 'profile'), siteA = path.join(tmp, 'siteA'), siteB = path.join(tmp, 'siteB');
for (const d of [profile, siteA, siteB]) fs.mkdirSync(d, { recursive: true });
for (const d of [siteA, siteB]) { for (const f of ['index.html', 'styles.css', 'core.js', 'app.js', 'vie-actions.js', 'vie-assistant.js', 'vie-agent-ui.js', 'vie-boot.js']) fs.copyFileSync(path.join(__dirname, f), path.join(d, f)); fs.writeFileSync(path.join(d, 'package.json'), '{"name":"vie-test","private":true}'); }
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

(async () => {
  console.log(`Navigateur : ${exe}\nProfil jetable : ${profile}`);
  const css0 = fs.readFileSync(path.join(siteB, 'styles.css'), 'utf8');
  let off = 2000; const pick = n => { for (;; off += 100) { const s = css0.slice(off, off + n); if (!D.hiddenIn(s) && css0.indexOf(s) === css0.lastIndexOf(s)) return s; } };
  const OLD = pick(2200);                                   // > 1500 : l'ancien aperçu l'aurait tronqué
  const TAIL = 'FIN-DE-PROPOSITION-VISIBLE';
  const NEW = OLD + '\n/* ' + Array.from({ length: 220 }, (_, i) => 'ligne ' + String(i).padStart(4, '0') + ' ' + 'x'.repeat(30)).join('\n') + '\n' + TAIL + ' */';   // ≈ 9 000 caractères : > 2500
  assert.ok(NEW.length > 8000 && NEW.length <= 12000 && !D.hiddenIn(NEW));
  const FR_NEW = OLD + '\n/* Größe, Straße, œuvre, « ça », 12 €, 日本語, 🙂 */';
  let scenario = 'none', unicodeChar = '';
  const tool = (input) => ({ type: 'tool_use', id: 'tu_1', name: 'propose_code_edit', input });
  const mockFetch = async () => {
    const content = scenario === 'big' ? [{ type: 'text', text: 'Voici la modification.' }, tool({ file: 'styles.css', old_text: OLD, new_text: NEW, reason: 'test' })]
      : scenario === 'oversize' ? [tool({ file: 'styles.css', old_text: css0.slice(0, 6001), new_text: 'x', reason: 'trop grand' })]
      : scenario === 'unicode' ? [tool({ file: 'styles.css', old_text: OLD, new_text: OLD + '\n/* a' + unicodeChar + 'b */', reason: 'unicode' })]
      : scenario === 'accents' ? [tool({ file: 'styles.css', old_text: OLD, new_text: FR_NEW, reason: 'accents' })]
      : scenario === 'hidden' ? [tool({ file: 'styles.css', old_text: OLD, new_text: OLD + '‮/* caché */', reason: 'bidi' })]
      : [{ type: 'text', text: 'Réponse simple.' }];
    return new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', content, stop_reason: scenario === 'none' ? 'end_turn' : 'tool_use', usage: { input_tokens: 100, output_tokens: 20 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const mk = (root, env) => createVieServer({ env: { ANTHROPIC_API_KEY: FAKE_KEY, ...env }, envFile: path.join(tmp, 'absent.env'), fetch: mockFetch, log: () => {}, limits: { perMinute: 1000 }, root });
  const vieA = mk(siteA, {}), vieB = mk(siteB, { VIE_DEV: 'on' });
  const portA = await vieA.listen(0), portB = await vieB.listen(0);
  const b = await launch();
  const page = await openPage(b);
  await page.viewport(1200, 800);
  const send = async text => { await page.fill('#vie-input', text); await page.click('#vie-send'); };
  const hook = () => page.ev(`(()=>{window.__bodies=[];const f=window.fetch;window.fetch=function(u,o){window.__bodies.push({u:String(u),b:o&&o.body});return f.apply(this,arguments);};return true;})()`);

  // --- A. serveur SANS VIE_DEV : le commutateur est inerte, jamais de dev:true envoyé -------------------------------------------------------------------------
  await page.goto(`http://127.0.0.1:${portA}/#vie-boot=${vieA.issueLaunchTicket()}`);
  assert.equal(await page.ev('window.VieBoot.ready.then(r=>r.ok)'), true, 'connexion établie avant de recharger la page');
  await page.ev(`sessionStorage.setItem('vie-dev','1')`);   // préférence d'onglet forcée à « activé » : sans effet sans l'accord du serveur
  await page.goto(`http://127.0.0.1:${portA}/`);
  await page.click('#vie-launch'); await page.click('[data-vie="toggle-settings"]');
  check('A. serveur sans VIE_DEV : commutateur désactivé, explication « désactivé côté serveur », consigne VIE_DEV=on', await page.waitFor(`(()=>{const c=document.querySelector('#vie-dev');return !!c&&c.disabled===true&&!c.checked&&/désactivé côté serveur/i.test(document.querySelector('#vie-settings').innerText)&&/VIE_DEV=on/.test(document.querySelector('#vie-settings').innerText);})()`));
  await hook(); await page.click('[data-vie="toggle-settings"]'); await send('Bonjour');
  check('A. même avec la préférence « activée » dans l’onglet : le corps de /api/chat ne contient PAS dev', await page.waitFor(`window.__bodies.some(x=>/api\\/chat/.test(x.u))`) && await page.ev(`window.__bodies.filter(x=>/api\\/chat/.test(x.u)).every(x=>!('dev' in JSON.parse(x.b)))`));

  // --- B. serveur avec VIE_DEV=on ----------------------------------------------------------------------------------------------------------------------------
  await page.goto(`http://127.0.0.1:${portB}/#vie-boot=${vieB.issueLaunchTicket()}`);
  assert.equal(await page.ev('window.VieBoot.ready.then(r=>r.ok)'), true, 'connexion établie avant de recharger la page');
  await page.ev(`sessionStorage.removeItem('vie-dev')`);
  await page.goto(`http://127.0.0.1:${portB}/`);
  await page.click('#vie-launch'); await page.click('[data-vie="toggle-settings"]');
  check('B. serveur avec VIE_DEV=on : commutateur disponible, désactivé par défaut dans l’onglet', await page.waitFor(`(()=>{const c=document.querySelector('#vie-dev');return !!c&&c.disabled===false&&!c.checked;})()`));
  await page.click('#vie-dev');
  check('B. activation : confirmation demandée, commutateur coché, texte « approbation … contrôlée par le serveur »', await page.waitFor(`document.querySelector('#vie-dev').checked&&/contrôlée par le serveur/.test(document.querySelector('#vie-settings').innerText)`));
  await page.click('[data-vie="toggle-settings"]');
  await page.ev(`window.__marker='avant-reload'`);
  await hook();
  scenario = 'big';
  await send('Ajoute une règle de style');
  check('proposition : carte « Modification du code : styles.css » avec Avant / Après', await page.waitFor(`!!document.querySelector('.vie-codediff')`, 12000));
  check('aperçu INTÉGRAL : le texte affiché == texte complet proposé (« Avant » 2200 caractères, « Après » ≈ 9 000), queue visible, aucun « … caractères de plus »', await page.ev(`(()=>{const o=document.querySelector('.vie-code-old'),n=document.querySelector('.vie-code-new');return o.textContent===${JSON.stringify(OLD)}&&n.textContent===${JSON.stringify(NEW)}&&n.textContent.endsWith(${JSON.stringify(TAIL + ' */')})&&!/caractères de plus/.test(document.querySelector('#vie-log').innerText);})()`));
  check('aperçu : aucun conteneur masquant (pas de hauteur maximale ni de défilement interne), statistiques et empreinte affichées', await page.ev(`(()=>{const c=getComputedStyle(document.querySelector('.vie-code-new'));const m=document.querySelector('.vie-codemeta').innerText;return c.maxHeight==='none'&&c.overflowY!=='scroll'&&c.overflowY!=='auto'&&/styles\\.css/.test(m)&&/empreinte/.test(m)&&/2200/.test(m)&&/${NEW.length}/.test(m);})()`));
  await page.shot('code-apercu-integral');
  const cssBefore = fs.readFileSync(path.join(siteB, 'styles.css'), 'utf8');
  check('rien n’est écrit tant que l’utilisateur n’a pas approuvé', fs.readFileSync(path.join(siteB, 'styles.css'), 'utf8') === cssBefore && !fs.existsSync(path.join(siteB, '.vie-backups')));
  await page.realClick('[data-vie="apply"]');
  check('approbation : fichier écrit EXACTEMENT (zone remplacée par le texte intégral), sauvegarde créée, état « Appliqué »', await page.waitFor(`/✓ Appliqué/.test(document.querySelector('#vie-log').innerText)`, 12000)
    && fs.readFileSync(path.join(siteB, 'styles.css'), 'utf8') === cssBefore.replace(OLD, () => NEW) && fs.readdirSync(path.join(siteB, '.vie-backups')).some(n => fs.readFileSync(path.join(siteB, '.vie-backups', n), 'utf8') === cssBefore));
  check('la boîte de confirmation annonce fichier, nombre de caractères/lignes, empreinte et « intégral »', await page.ev(`true`) && page.dialogs.some(d => /styles\.css/.test(d) && /2200 caractères/.test(d) && new RegExp(String(NEW.length)).test(d) && /Empreinte : [0-9a-f]{12}/.test(d) && /INTÉGRAL/.test(d)));
  await sleep(1600);
  check('pas de rechargement automatique (l’annulation reste possible) ; boutons « Recharger la page » et « Annuler la modification »', await page.ev(`window.__marker==='avant-reload'&&!!document.querySelector('[data-vie="reload"]')&&!!document.querySelector('[data-vie="code-undo"]')&&document.querySelectorAll('[data-vie="apply"]').length===0`));
  const used = await page.ev(`JSON.parse(window.__bodies.filter(x=>/api\\/code$/.test(x.u)).pop().b)`);
  const replay = await page.ev(`(async()=>{const tk=(await fetch('/api/health').then(r=>r.json())).token;return fetch('/api/code',{method:'POST',headers:{'content-type':'application/json','x-vie-token':tk},body:${JSON.stringify(JSON.stringify(used))}}).then(async r=>({s:r.status,j:await r.json()}))})()`);
  check('REJEU de la même approbation depuis le navigateur : 409 approval_used, fichier inchangé', replay.s === 409 && replay.j.error === 'approval_used' && fs.readFileSync(path.join(siteB, 'styles.css'), 'utf8') === cssBefore.replace(OLD, () => NEW));
  await page.realClick('[data-vie="code-undo"]');
  check('annulation : fichier restauré à l’octet près, état « Annulé »', await page.waitFor(`/↶ Annulé/.test(document.querySelector('#vie-log').innerText)`, 12000) && fs.readFileSync(path.join(siteB, 'styles.css'), 'utf8') === cssBefore);
  check('annulation : deuxième tentative impossible (bouton absent ; rejeu serveur = 409)', await page.ev(`document.querySelectorAll('[data-vie="code-undo"]').length===0`)
    && (await page.ev(`(async()=>{const tk=(await fetch('/api/health').then(r=>r.json())).token;return fetch('/api/code/undo',{method:'POST',headers:{'content-type':'application/json','x-vie-token':tk},body:${JSON.stringify(JSON.stringify(await page.ev(`JSON.parse(window.__bodies.filter(x=>/api\\/code\\/undo$/.test(x.u)).pop().b)`)))}}).then(r=>r.status)})()`)) === 409);

  // --- C. propositions inacceptables : aucune carte, rien d'écrit --------------------------------------------------------------------------------------
  await page.click('[data-vie="clear"]'); await page.ev(`true`);
  scenario = 'oversize'; await send('Fais un énorme remplacement');
  check('proposition trop grande pour être relue en entier (old > 6000) : refusée par le serveur, AUCUNE carte', await page.waitFor(`/Fais un énorme/.test(document.querySelector('#vie-log').innerText)&&!document.querySelector('#vie-busy')`, 12000) && await page.waitFor(`document.querySelectorAll('.vie-bot,.vie-msg.bot').length>=1`, 12000) && await page.ev(`!document.querySelector('.vie-codediff')`));
  scenario = 'hidden'; await send('Mets un caractère caché');
  check('proposition avec caractère de sens d’écriture caché : refusée, AUCUNE carte, fichier inchangé', await page.waitFor(`document.querySelectorAll('.vie-msg.bot').length>=2`, 12000) && await page.ev(`!document.querySelector('.vie-codediff')`) && fs.readFileSync(path.join(siteB, 'styles.css'), 'utf8') === cssBefore);
  // --- D. Unicode (audit Codex P2) : U+180F / U+FE0F & co. ne passent ni le serveur, ni le panneau ; la carte ne promet que ce qu'elle a vérifié ------------------------------
  const cpx = n => String.fromCodePoint(n);
  const waitBots = async k => page.waitFor(`document.querySelectorAll('.vie-msg.bot').length>=${k}`, 12000);
  let bots = 2;
  for (const [name, ch] of [['U+180F', cpx(0x180F)], ['U+FE0F', cpx(0xFE0F)], ['VS-17 U+E0100', cpx(0xE0100)], ['largeur nulle U+200B', cpx(0x200B)], ['espace insécable U+00A0', cpx(0xA0)], ['ZWJ U+200D', cpx(0x200D)]]) {
    scenario = 'unicode'; unicodeChar = ch; await send('Renomme un identifiant ' + name); bots++;
    check(`serveur : ${name} dans le nouveau texte = proposition refusée, AUCUNE carte, fichier inchangé`, await waitBots(bots) && await page.ev(`!document.querySelector('.vie-codediff')&&!document.querySelector('[data-vie="apply"]')`) && fs.readFileSync(path.join(siteB, 'styles.css'), 'utf8') === cssBefore);
  }
  // panneau seul : réponse FALSIFIÉE (serveur laxiste simulé) contenant U+180F / U+FE0F → la carte est « inapplicable », avec le code Unicode, sans bouton d'application
  for (const [name, n] of [['U+180F', 0x180F], ['U+FE0F', 0xFE0F], ['U+E0100', 0xE0100], ['U+202F', 0x202F]]) {
    await page.ev(`(()=>{const f=window.__realFetch||window.fetch;window.__realFetch=f;window.fetch=function(u,o){if(/api\\/chat/.test(String(u))){const nw='let ok'+String.fromCodePoint(${n})+' = 1;';return Promise.resolve(new Response(JSON.stringify({ok:true,reply:'réponse falsifiée',label:'x',model:'claude-haiku-5-5',effort:'low',usage:{inputTokens:1,outputTokens:1,approxCostUsd:0},proposals:[{kind:'code',pid:'p1',id:'abcdefgh12345',nonce:'n'.repeat(24),hash:'a'.repeat(64),file:'styles.css',old:'a',new:nw,expiresAt:Date.now()+600000,reason:'test',stats:{oldChars:1,newChars:nw.length,oldLines:1,newLines:1,atLine:1,nonAscii:0,fileChars:10,fileLines:1,newFileChars:10}}],rejected:[]}),{status:200,headers:{'content-type':'application/json'}}));}return f.apply(this,arguments);};return true;})()`);
    await send('réponse falsifiée ' + name); bots++;
    check(`panneau seul : réponse falsifiée avec ${name} → carte « inapplicable » citant le code Unicode, aucun aperçu ni bouton « Appliquer »`, await waitBots(bots) && await page.ev(`(()=>{const cards=[...document.querySelectorAll('.vie-card')];const c=cards[cards.length-1];return !!c&&/inapplicable/.test(c.innerText)&&c.innerText.includes('U+${n.toString(16).toUpperCase().padStart(4, '0')}')&&!c.querySelector('[data-vie="apply"]')&&!c.querySelector('.vie-codediff');})()`));
  }
  await page.ev(`(()=>{window.fetch=window.__realFetch||window.fetch;return true;})()`);
  await page.click('[data-vie="clear"]');
  scenario = 'accents'; await send('Ajoute un commentaire en français et en allemand');
  check('positif : texte FR / DE / typographique / emoji sans sélecteur / CJK = carte normale', await page.waitFor(`!!document.querySelector('.vie-codediff')&&!!document.querySelector('[data-vie="apply"]')`, 12000));
  check('positif : « Après » affiché octet pour octet (textContent == texte proposé, aucune normalisation) ; non ASCII surlignés avec leur point de code', await page.ev(`(()=>{const n=document.querySelector('.vie-code-new');const marks=[...n.querySelectorAll('mark.vie-na')];return n.textContent===${JSON.stringify(FR_NEW)}&&marks.length===${[...FR_NEW.matchAll(/[^\x00-\x7f]/gu)].length}&&marks.every(m=>/^U\\+[0-9A-F]{4,5}$/.test(m.title))&&!!marks.find(m=>m.title==='U+00DF');})()`));
  check('la carte ne prétend pas montrer plus qu’elle ne montre : aucune promesse « aucun texte masqué » ; contrôle automatique chiffré, liste des non ASCII avec U+00DF ; « ce n’est pas un diff ligne à ligne » ; le reste du fichier n’est pas affiché', await page.ev(`(()=>{const t=document.querySelector('.vie-codediff').innerText;return !/Aucun texte n’est tronqué ni masqué/.test(t)&&/Contrôle automatique/.test(t)&&t.includes('${FR_NEW.length + OLD.length} caractères au total')&&t.includes('U+00DF')&&/Ce n’est pas un diff ligne à ligne/.test(t)&&/Le reste du fichier/.test(t)&&/n’est pas affiché/.test(t)&&/homoglyph|visuellement semblables/.test(t);})()`));
  await page.ev(`(()=>{document.querySelector('.vie-codecheck').scrollIntoView({block:'center',behavior:'instant'});return true;})()`); await sleep(150);
  await page.shot('code-unicode-controle');
  const realErrors = page.errors.filter(e => !/status of 409/.test(e)); check('aucune erreur JavaScript ni exception dans la console (hors les 409 volontaires des rejeux)', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

  await b.send('Browser.close').catch(() => {}); try { b.ws.close(); } catch (e) { /* ok */ }
  await Promise.race([b.closed, sleep(3000)]);
  await vieA.close(); await vieB.close();
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} PASS${failed ? `, ${failed} FAIL` : ''}`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* profil verrouillé : sans importance */ }
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('ERREUR : ' + (e && e.stack || e)); process.exit(1); });
