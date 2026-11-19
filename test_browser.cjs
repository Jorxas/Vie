// Vérification navigateur réelle (facultative, hors ligne) : Chrome ou Edge en file://, profil JETABLE créé dans le dossier temporaire.
// Aucun paquet : protocole DevTools via le WebSocket intégré à Node. Le vrai profil de l'utilisateur n'est jamais ouvert ni lu.
//   node test_browser.cjs "C:\Program Files\Google\Chrome\Application\chrome.exe"
//   node test_browser.cjs "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
// Variable facultative : VIE_SHOTS_DIR=<dossier> pour enregistrer des captures d'écran.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const C = require('./core.js');

const exe = process.argv[2];
if (!exe || !fs.existsSync(exe)) { console.log('NON TESTÉ : chemin du navigateur absent ou introuvable (argument 1).'); process.exit(2); }
const KEY = 'vie-personal-v1';
const PAGE = pathToFileURL(path.join(__dirname, 'index.html')).href;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vie-browser-'));
const profile = path.join(tmp, 'profile'), downloads = path.join(tmp, 'downloads'), files = path.join(tmp, 'files');
for (const d of [profile, downloads, files]) fs.mkdirSync(d);
const results = [];
let current = null; // navigateur en cours : fermé en cas d'erreur pour ne laisser ni processus ni profil
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };

async function launch() {
  try { fs.unlinkSync(path.join(profile, 'DevToolsActivePort')); } catch (e) { /* absent */ }
  const proc = spawn(exe, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let info = null;
  for (let i = 0; i < 150 && !info; i++) {
    await sleep(100);
    try { const [port, p] = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/); if (port && p) info = { port, p }; } catch (e) { /* pas encore */ }
  }
  assert.ok(info, 'DevToolsActivePort introuvable');
  const ws = new WebSocket(`ws://127.0.0.1:${info.port}${info.p}`);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(Error('connexion DevTools impossible')); });
  let id = 0; const pending = new Map(), handlers = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(Error(m.error.message)) : res(m.result); } else if (m.method) handlers.forEach(h => h(m));
  };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  const closed = new Promise(r => proc.once('exit', r));
  return { proc, ws, send, on: h => handlers.push(h), closed };
}

async function openPage(b) {
  const { targetId } = await b.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await b.send('Target.attachToTarget', { targetId, flatten: true });
  const errors = [], dialogs = [];
  const s = (m, p) => b.send(m, p, sessionId);
  b.on(m => {
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Runtime.exceptionThrown') errors.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console.error: ' + m.params.args.map(a => a.value ?? a.description).join(' '));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push('log: ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
    if (m.method === 'Page.javascriptDialogOpening') { dialogs.push(m.params.message); s('Page.handleJavaScriptDialog', { accept: true }); }
  });
  for (const d of ['Page', 'Runtime', 'Log', 'DOM']) await s(d + '.enable');
  const page = {
    errors, dialogs,
    async goto() { const loaded = new Promise(r => b.on(m => { if (m.sessionId === sessionId && m.method === 'Page.loadEventFired') r(); })); await s('Page.navigate', { url: PAGE }); await loaded; await sleep(300); },
    async ev(expression) { const r = await s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error('evaluate: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result.value; },
    click(sel) { return page.ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)throw Error('introuvable: '+${JSON.stringify(sel)});e.click();return true;})()`); },
    fill(sel, v) { return page.ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)throw Error('introuvable: '+${JSON.stringify(sel)});e.value=${JSON.stringify(v)};return true;})()`); },
    stored: () => page.ev(`localStorage.getItem(${JSON.stringify(KEY)})`),
    toast: () => page.ev(`document.querySelector('#toast').textContent`),
    async waitToast(re, ms = 4000) { for (let t = 0; t < ms; t += 100) { const x = await page.toast(); if (x && re.test(x)) return x; await sleep(100); } return await page.toast(); },
    clearToast: () => page.ev(`document.querySelector('#toast').textContent=''`),
    async setFile(p) { const { root } = await s('DOM.getDocument'); const { nodeId } = await s('DOM.querySelector', { nodeId: root.nodeId, selector: '#file-import' }); await s('DOM.setFileInputFiles', { files: [p], nodeId }); },
    async viewport(width) { await s('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 }); await sleep(150); },
    async shot(name) { if (!process.env.VIE_SHOTS_DIR) return; fs.mkdirSync(process.env.VIE_SHOTS_DIR, { recursive: true }); const r = await s('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(process.env.VIE_SHOTS_DIR, name + '.png'), Buffer.from(r.data, 'base64')); },
  };
  return page;
}

async function exportNow(page) {
  for (const f of fs.readdirSync(downloads)) fs.unlinkSync(path.join(downloads, f));
  await page.click('[data-action="export"]');
  return waitDownload();
}
async function waitDownload() {
  for (let i = 0; i < 60; i++) { const f = fs.readdirSync(downloads).filter(x => x.endsWith('.json')); if (f.length) return path.join(downloads, f[0]); await sleep(100); }
  return null;
}

(async () => {
  console.log(`Navigateur : ${exe}\nProfil jetable : ${profile}`);
  let b = current = await launch();
  const version = await b.send('Browser.getVersion');
  console.log('Version :', version.product);
  await b.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  let page = await openPage(b);
  await page.goto();

  // 1. Démarrage
  check('démarrage : titre et 10 rubriques', (await page.ev('document.title')).startsWith('VIE') && (await page.ev(`document.querySelectorAll('button.nav-btn').length`)) === 10);
  check('démarrage : aucun bandeau de récupération ni d’incertitude', await page.ev(`!document.querySelector('#uncertain-banner') && !document.querySelector('.warning-box[role=alert]')`));
  check('démarrage : file:// donne accès à localStorage', await page.ev(`(()=>{try{localStorage.setItem('__t','1');localStorage.removeItem('__t');return true}catch(e){return false}})()`));

  // 2. Tâche + persistance
  await page.click('[data-action="add-task"]'); await page.fill('#field-title', 'Tâche navigateur'); await page.click('#modal-save'); await sleep(200);
  check('tâche créée et persistée', JSON.parse(await page.stored()).tasks.some(t => t.title === 'Tâche navigateur'));

  // 3. P1 #2 en conditions réelles : setItem échoue, puis nouvelle tentative sur le même formulaire
  await page.click('[data-view="study"]'); await page.click('[data-action="edit-course"][data-id="c0"]');
  await page.fill('#field-progress', 'Révisé navigateur'); await page.fill('#field-next', 'Exercice navigateur');
  const beforeCourse = await page.stored();
  await page.ev(`window.__realSet=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw new DOMException('quota','QuotaExceededError')};true`);
  await page.clearToast(); await page.click('#modal-save');
  const failToast = await page.waitToast(/Enregistrement impossible/);
  check('cours : échec d’écriture annoncé, aucun faux succès', /^Enregistrement impossible/.test(failToast) && (await page.stored()) === beforeCourse, failToast);
  check('cours : formulaire conservé pour réessayer', await page.ev(`document.querySelector('#modal').open`));
  await page.ev(`Storage.prototype.setItem=window.__realSet;true`);
  await page.clearToast(); await page.click('#modal-save');
  const okToast = await page.waitToast(/enregistrées/);
  const c0 = JSON.parse(await page.stored()).courses.find(c => c.id === 'c0');
  check('cours : 2e tentative réellement persistée', okToast === 'Modifications enregistrées localement.' && c0.progress === 'Révisé navigateur' && c0.next === 'Exercice navigateur', okToast);

  // 4. Export réel (téléchargement) + validation du JSON par core.js
  await page.click('[data-view="settings"]');
  const dl = await exportNow(page);
  check('export : fichier téléchargé', !!dl, dl ? path.basename(dl) : '');
  let exported = null;
  try { exported = JSON.parse(fs.readFileSync(dl, 'utf8')); C.validateImported(exported); } catch (e) { exported = null; }
  check('export : JSON valide pour validateImported', !!exported && exported.tasks.some(t => t.title === 'Tâche navigateur') && exported.courses.find(c => c.id === 'c0').progress === 'Révisé navigateur');

  // 5. Import valide (displayName modifié) puis import mal formé
  const good = JSON.parse(JSON.stringify(exported)); good.settings.displayName = 'IMPORTE-NAVIGATEUR';
  const goodFile = path.join(files, 'bon.json'); fs.writeFileSync(goodFile, JSON.stringify(good));
  await page.clearToast(); await page.setFile(goodFile);
  const impToast = await page.waitToast(/Données importées|refusé/);
  check('import valide : accepté et persisté', impToast === 'Données importées.' && JSON.parse(await page.stored()).settings.displayName === 'IMPORTE-NAVIGATEUR', impToast);
  const stable = await page.stored();
  const badFiles = {
    'JSON illisible': ['{pas du json', /fichier JSON illisible/],
    'horaire de nuit': [JSON.stringify({ ...good, settings: { ...good.settings, workShifts: [{ day: 1, start: '22:00', end: '06:00', confirmed: true }] } }), /Intervalle invalide/],
    'cours fin = début': [JSON.stringify({ ...good, settings: { ...good.settings, courseBlocks: [{ title: 'X', day: 1, start: '10:00', end: '10:00' }] } }), /Intervalle invalide/],
    'liste avec null': [JSON.stringify({ ...good, tasks: [null] }), /Import refusé/],
  };
  for (const [label, [text, re]] of Object.entries(badFiles)) {
    const f = path.join(files, 'mauvais.json'); fs.writeFileSync(f, text);
    await page.clearToast(); await page.setFile(f);
    const t = await page.waitToast(/Import refusé|Données importées/);
    check(`import mal formé refusé (${label})`, re.test(t) && (await page.stored()) === stable, t);
  }
  check('import : aucune fenêtre de confirmation pour un fichier refusé', page.dialogs.length === 1, `${page.dialogs.length} confirmation(s) au total`);

  // 6. P1 #3 en conditions réelles : setItem réussit, puis getItem lève
  await page.ev(`(()=>{const rs=Storage.prototype.setItem,rg=Storage.prototype.getItem;window.__rs=rs;window.__rg=rg;window.__brick=false;window.__armed=false;
    Storage.prototype.setItem=function(k,v){const r=rs.call(this,k,v);if(window.__armed&&k==='${KEY}'){window.__brick=true;window.__armed=false}return r};
    Storage.prototype.getItem=function(k){if(window.__brick&&k==='${KEY}')throw new DOMException('denied','SecurityError');return rg.call(this,k)};return true})()`);
  const trueStored = async () => page.ev(`window.__rg.call(localStorage,'${KEY}')`);
  const before6 = await trueStored();
  const next6 = JSON.parse(JSON.stringify(good)); next6.settings.displayName = 'INCERTAIN-TEST';
  const f6 = path.join(files, 'incertain.json'); fs.writeFileSync(f6, JSON.stringify(next6));
  await page.ev('window.__armed=true;true'); await page.clearToast(); await page.setFile(f6);
  const t6 = await page.waitToast(/incertain|importées|impossible/);
  check('relecture impossible : mode incertain annoncé, jamais « Données importées »', /Enregistrement incertain/.test(t6) && !/restauré|importées/.test(t6), t6);
  check('relecture impossible : bandeau durable visible', await page.ev(`!!document.querySelector('#uncertain-banner')`));
  await page.click('[data-view="week"]');
  check('relecture impossible : bandeau toujours là après navigation', await page.ev(`!!document.querySelector('#uncertain-banner')`));
  await page.shot('bandeau-incertain');
  await page.click('[data-view="study"]'); await page.click('[data-action="edit-course"][data-id="c0"]'); await page.fill('#field-progress', 'Ne doit pas passer'); await page.clearToast(); await page.click('#modal-save');
  const blocked = await page.waitToast(/incertain/);
  await page.ev(`document.querySelector('#modal').open&&document.querySelector('#modal').close();true`);
  await page.ev('window.__brick=false;true');
  const after6 = await trueStored();
  check('mode incertain : écriture ordinaire bloquée, stockage non modifié par cette tentative', /incertain/.test(blocked) && JSON.parse(after6).courses.find(c => c.id === 'c0').progress === 'Révisé navigateur', blocked);
  check('mode incertain : les octets réels sont ceux d’avant (restauration aveugle) ou ceux importés — jamais autre chose', after6 === before6 || JSON.parse(after6).settings.displayName === 'INCERTAIN-TEST', after6 === before6 ? 'ancien contenu' : 'nouveau contenu');
  await page.click('[data-view="settings"]');
  const dl6 = await exportNow(page);
  let exp6 = null; try { exp6 = JSON.parse(fs.readFileSync(dl6, 'utf8')); C.validateImported(exp6); } catch (e) { exp6 = null; }
  check('mode incertain : export de l’état affiché possible, JSON valide, sans l’import non confirmé', !!exp6 && exp6.settings.displayName === 'IMPORTE-NAVIGATEUR', exp6 ? exp6.settings.displayName : 'pas de fichier');
  await page.click('[data-action="uncertain-recheck"]'); await sleep(300);
  check('relecture explicite : incertitude levée une fois le stockage lisible', await page.ev(`!document.querySelector('#uncertain-banner')`));
  const dispName = JSON.parse(await trueStored()).settings.displayName;
  await page.clearToast(); await page.click('[data-view="today"]'); await page.click('[data-action="add-task"]'); await page.fill('#field-title', 'Après incertitude'); await page.click('#modal-save'); await sleep(250);
  check('après relecture : écriture ordinaire de nouveau persistée', JSON.parse(await trueStored()).tasks.some(t => t.title === 'Après incertitude'), 'displayName stocké = ' + dispName);
  await page.ev(`Storage.prototype.setItem=window.__rs;Storage.prototype.getItem=window.__rg;true`);

  // 7. Largeurs et rubriques
  const views = ['today', 'week', 'projects', 'study', 'career', 'life', 'finance', 'goals', 'ideas', 'settings'];
  for (const w of [390, 768, 1440]) {
    await page.viewport(w);
    let overflow = [];
    for (const v of views) { await page.click(`#nav [data-view="${v}"]`); await sleep(60); if (await page.ev('document.documentElement.scrollWidth>window.innerWidth')) overflow.push(v); }
    check(`largeur ${w} px : aucun débordement horizontal (10 rubriques)`, overflow.length === 0, overflow.join(','));
    await page.click('#nav [data-view="week"]'); await page.shot('semaine-' + w);
  }
  check('aucune erreur JavaScript pendant la session', page.errors.length === 0, page.errors.slice(0, 3).join(' | '));
  const expectedTask = 'Après incertitude';

  // 8. Redémarrage réel du navigateur avec le même profil jetable
  await b.send('Browser.close').catch(() => {}); await Promise.race([b.closed, sleep(8000)]);
  b = current = await launch(); page = await openPage(b); await page.goto();
  const persisted = JSON.parse(await page.stored());
  check('redémarrage : données conservées (tâche, cours, import)', persisted.tasks.some(t => t.title === expectedTask) && persisted.courses.find(c => c.id === 'c0').progress === 'Révisé navigateur' && persisted.tasks.some(t => t.title === 'Tâche navigateur'));
  check('redémarrage : aucune erreur JavaScript', page.errors.length === 0, page.errors.slice(0, 3).join(' | '));
  await b.send('Browser.close').catch(() => {}); await Promise.race([b.closed, sleep(8000)]);
})().catch(err => { check('exécution du script', false, err.stack || String(err)); }).finally(async () => {
  if (current && current.proc.exitCode === null) { try { current.proc.kill(); } catch (e) { /* déjà fermé */ } await Promise.race([current.closed, sleep(5000)]); }
  await sleep(500);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { console.log('Nettoyage du profil jetable à faire à la main :', tmp); }
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} PASS${failed ? `, ${failed} FAIL` : ''}`);
  process.exit(failed ? 1 : 0);
});
