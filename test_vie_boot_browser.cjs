// Vérification NAVIGATEUR RÉELLE de l'authentification de lancement : Chrome ou Edge (profils JETABLES ISOLÉS), vrai serveur vie-server.cjs dans ce processus,
// faux Anthropic piégé (aucun réseau, aucun coût, aucune vraie clé). Aucun vrai .env, aucun fichier de l'utilisateur.
//   node test_vie_boot_browser.cjs "C:\Program Files\Google\Chrome\Application\chrome.exe"
//   node test_vie_boot_browser.cjs "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createVieServer } = require('./vie-server.cjs');

const exe = process.argv[2];
if (!exe || !fs.existsSync(exe)) { console.log('NON TESTÉ : chemin du navigateur absent ou introuvable (argument 1).'); process.exit(2); }
const FAKE_KEY = 'FAKE-BROWSER-BOOT-KEY-NOT-A-SECRET-0123456789';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vie-boot-browser-')));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };
const calls = [];
const mockFetch = async () => { calls.push(1); return new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Réponse du chat classique.' }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 20 } }), { status: 200, headers: { 'content-type': 'application/json' } }); };

async function launch(profile) {
  fs.mkdirSync(profile, { recursive: true });
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
  const errors = [], requests = [];
  const s = (m, p) => b.send(m, p, sessionId);
  b.on(m => {
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Runtime.exceptionThrown') errors.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console.error: ' + m.params.args.map(a => a.value ?? a.description).join(' '));
    if (m.method === 'Network.requestWillBeSent') requests.push({ url: m.params.request.url, method: m.params.request.method, headers: m.params.request.headers || {}, body: m.params.request.postData || '' });
  });
  for (const d of ['Page', 'Runtime', 'Log', 'DOM', 'Network']) await s(d + '.enable');
  const page = {
    errors, requests, send: s,
    // about:blank d'abord : une navigation qui ne change que le fragment est « dans le même document » (pas de rechargement, vie-boot.js ne rejouerait pas) ; le vrai lanceur ouvre toujours un nouvel onglet.
    async goto(url) { const nav = async u => { const loaded = new Promise(r => b.on(m => { if (m.sessionId === sessionId && m.method === 'Page.loadEventFired') r(); })); await s('Page.navigate', { url: u }); await loaded; }; await nav('about:blank'); await nav(url); await sleep(500); },
    async ev(expression) { const r = await s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error('evaluate: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result.value; },
    click: sel => page.ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)throw Error('introuvable: '+${JSON.stringify(sel)});e.click();return true;})()`),
    fill: (sel, v) => page.ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)throw Error('introuvable: '+${JSON.stringify(sel)});e.value=${JSON.stringify(v)};e.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`),
    async waitFor(expr, ms = 8000) { for (let t = 0; t < ms; t += 80) { let v = false; try { v = await page.ev(expr); } catch (e) { /* transition */ } if (v) return true; await sleep(80); } return false; },
    async viewport(width, height = 800) { await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); await sleep(150); },
    async cookies(url) { return (await s('Network.getCookies', { urls: [url] })).cookies; },
  };
  await page.viewport(1200, 800);
  return page;
}
const status = `(document.querySelector('#vie-status')||{innerText:''}).innerText`;
const startVie = async (port = 0, over = {}) => { const logs = []; const vie = createVieServer({ env: { ANTHROPIC_API_KEY: FAKE_KEY }, envFile: path.join(tmp, 'absent.env'), fetch: mockFetch, log: l => logs.push(l), sleep: () => Promise.resolve(), limits: { perMinute: 1000 }, ...over }); const p = await vie.listen(port); return { vie, port: p, logs, url: `http://127.0.0.1:${p}/` }; };

(async () => {
  console.log(`Navigateur : ${exe}`);
  const evilSrv = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); r.end('<!doctype html><title>evil</title><body>evil</body>'); });
  await new Promise(r => evilSrv.listen(0, '127.0.0.1', r)); const evilPort = evilSrv.address().port;
  let S = await startVie();
  const b1 = await launch(path.join(tmp, 'profile1')); const b2 = await launch(path.join(tmp, 'profile2'));
  console.log('Version :', (await b1.send('Browser.getVersion')).product);
  try {
    // --- A. Ouverture DIRECTE sans ticket (favori, saisie de l'adresse) : le site marche, tout le reste est verrouillé, rien n'est posé ----------------------------------------
    const pA = await openPage(b1);
    await pA.goto(S.url);
    check('A. ouverture directe : le site fonctionne (10 rubriques), aucune erreur JavaScript', (await pA.ev(`document.querySelectorAll('button.nav-btn').length`)) === 10 && pA.errors.length === 0, pA.errors.slice(0, 2).join(' | '));
    check('A. ouverture directe : AUCUN cookie posé par le serveur (ni sur la page, ni sur /api/health), document.cookie vide', (await pA.cookies(S.url)).length === 0 && (await pA.ev('document.cookie')) === '');
    await pA.click('#vie-launch');
    check('A. assistant verrouillé : bannière explicite avec la marche à suivre (start-vie.cmd, Entrée dans la console), envoi désactivé', await pA.waitFor(`/verrouillé/.test(${status})&&/start-vie\\.cmd/.test(${status})&&/Entrée/.test(${status})&&document.querySelector('#vie-send').disabled===true`), (await pA.ev(status)).slice(0, 160));
    await pA.click('[data-mode="agent"]').catch(() => {});
    check('A. mode Agent : verrouillé aussi (aucune requête agent émise avec un jeton, aucune carte, envoi désactivé)', await pA.waitFor(`document.querySelector('#vie-send').disabled===true`) && !pA.requests.some(r => /\/api\/(chat|agent\/(run|consent|decision)|code)/.test(r.url)));
    check('A. aucune requête privilégiée émise sans session (health anonyme seulement)', pA.requests.filter(r => /\/api\//.test(r.url)).every(r => /\/api\/health$/.test(r.url)), pA.requests.filter(r => /\/api\//.test(r.url)).map(r => r.url).join(','));

    // --- B. Lancement : fragment à usage unique, échangé puis retiré ---------------------------------------------------------------------------------------------------------
    const ticket = S.vie.issueLaunchTicket();
    const pB = await openPage(b1);
    await pB.goto(S.url + '#vie-boot=' + ticket);
    check('B. lancement : le fragment est retiré de la barre d’adresse (location.href sans ticket) et de l’historique de la page', !(await pB.ev('location.href')).includes('vie-boot') && (await pB.ev('location.hash')) === '' && !(await pB.ev('JSON.stringify(history.state)')).includes(ticket));
    check('B. le ticket n’apparaît dans AUCUNE URL ni en-tête (Referer compris) émis par le navigateur ; il n’est posté qu’UNE fois, en JSON, sur /api/auth/exchange', pB.requests.every(r => !r.url.includes(ticket) && !Object.values(r.headers).some(v => String(v).includes(ticket))) && pB.requests.filter(r => /auth\/exchange$/.test(r.url)).length === 1 && pB.requests.filter(r => /auth\/exchange$/.test(r.url))[0].method === 'POST' && JSON.parse(pB.requests.filter(r => /auth\/exchange$/.test(r.url))[0].body).ticket === ticket);
    const ck = await pB.cookies(S.url);
    check('B. cookie de session : HttpOnly, SameSite=Strict, Path=/, nom propre au port, non lisible par le script (document.cookie vide)', ck.length === 1 && ck[0].name === `vie_sid_${S.port}` && ck[0].httpOnly === true && ck[0].sameSite === 'Strict' && ck[0].path === '/' && (await pB.ev('document.cookie')) === '', JSON.stringify(ck.map(c => ({ n: c.name, h: c.httpOnly, s: c.sameSite, sec: c.secure }))));
    check('B. HTTP local : le cookie n’est pas « Secure » (limite documentée : pas de HTTPS en boucle locale)', ck[0] && ck[0].secure === false);
    await pB.click('#vie-launch');
    check('B. assistant déverrouillé : plus de bannière « verrouillé », envoi possible', await pB.waitFor(`!/verrouillé/.test(${status})&&document.querySelector('#vie-send').disabled===false`), (await pB.ev(status)).slice(0, 120));
    check('B. l’échange s’est produit AVANT toute autre requête d’API (health authentifié ensuite)', (() => { const api = pB.requests.filter(r => /\/api\//.test(r.url)); return api.length >= 2 && /auth\/exchange$/.test(api[0].url) && /health$/.test(api[1].url); })(), pB.requests.filter(r => /\/api\//.test(r.url)).map(r => r.method + ' ' + r.url.replace(/^.*\/api/, '/api')).join(', '));
    await pB.fill('#vie-input', 'Bonjour'); await pB.click('#vie-send');
    check('B. chat réel par la session (jeton CSRF + cookie) : réponse du faux Anthropic affichée', await pB.waitFor(`document.body.innerText.includes('Réponse du chat classique.')`) && calls.length === 1);
    await pB.goto(S.url);
    await pB.click('#vie-launch');
    check('B. rechargement SANS ticket : la session persiste (cookie), pas de nouvel échange', await pB.waitFor(`!/verrouillé/.test(${status})&&document.querySelector('#vie-send').disabled===false`) && pB.requests.slice(-12).every(r => !/auth\/exchange$/.test(r.url)));

    // --- C. Rejeu du même lien dans un AUTRE navigateur (profil isolé) : refusé -------------------------------------------------------------------------------------------
    const pC = await openPage(b2);
    await pC.goto(S.url + '#vie-boot=' + ticket);
    await pC.click('#vie-launch');
    check('C. lien déjà utilisé rejoué dans un autre navigateur : refusé, bannière « expiré ou déjà utilisé », aucun cookie, envoi désactivé', await pC.waitFor(`/déjà utilisé/.test(${status})&&document.querySelector('#vie-send').disabled===true`) && (await pC.cookies(S.url)).length === 0, (await pC.ev(status)).slice(0, 100));
    check('C. même après refus, le fragment est retiré de la barre d’adresse', !(await pC.ev('location.href')).includes('vie-boot'));
    const pC2 = await openPage(b2); await pC2.goto(S.url + '#vie-boot=' + 'A'.repeat(43)); await pC2.click('#vie-launch');
    check('C. ticket inventé : refusé, verrouillé', await pC2.waitFor(`/verrouillé|refusé/.test(${status})&&document.querySelector('#vie-send').disabled===true`) && (await pC2.cookies(S.url)).length === 0);
    const nEx = pC2.requests.filter(r => /auth\/exchange$/.test(r.url)).length;
    const pC3 = await openPage(b2); await pC3.goto(S.url + '#vie-boot=court'); await pC3.click('#vie-launch');
    check('C. fragment mal formé : jeté sans échange, verrouillé', pC3.requests.filter(r => /auth\/exchange$/.test(r.url)).length === 0 && !(await pC3.ev('location.href')).includes('vie-boot') && (await pC3.ev(status)).includes('verrouillé') && nEx === 1);

    // --- D. Page d'une AUTRE origine (même hôte, autre port : « same-site ») avec le navigateur connecté : le cookie Strict part, mais le serveur refuse -------------------------------
    const before = S.logs.length, callsBefore = calls.length;
    const pD = await openPage(b1); await pD.goto(`http://127.0.0.1:${evilPort}/`);
    const probe = await pD.ev(`(async()=>{const out=[];const t=(u,o)=>fetch('${S.url.replace(/\/$/, '')}'+u,{credentials:'include',...o}).then(r=>out.push(r.status),e=>out.push('err'));
      await t('/api/health');await t('/api/health',{mode:'no-cors'});
      await t('/api/agent/status');await t('/api/agent/status',{mode:'no-cors'});
      await t('/api/chat',{method:'POST',mode:'no-cors',headers:{'content-type':'text/plain'},body:JSON.stringify({mode:'rapide',share:false,messages:[{role:'user',content:'x'}]})});
      await t('/api/agent/consent',{method:'POST',mode:'no-cors',headers:{'content-type':'text/plain'},body:'{"accept":true,"v":1}'});
      await t('/api/auth/exchange',{method:'POST',mode:'no-cors',headers:{'content-type':'text/plain'},body:'{"ticket":"${'A'.repeat(43)}"}'});
      await t('/api/code',{method:'POST',mode:'no-cors',headers:{'content-type':'text/plain'},body:'{}'});
      const f=document.createElement('form');f.method='POST';f.action='${S.url}api/agent/consent';f.enctype='text/plain';f.target='_blank';document.body.append(f);try{f.submit();}catch(e){}
      return out;})()`);
    await sleep(500);
    const lines = S.logs.slice(before);
    const hit = lines.filter(l => /\/api\/(chat|agent|code|auth)/.test(l));
    check('D. page d’une autre origine même hôte (cookie Strict envoyé) : aucune requête privilégiée n’aboutit (toutes 4xx), aucun appel Anthropic, consentement agent inchangé', hit.length >= 4 && hit.every(l => / (403|415|405|400|404|429) /.test(l)) && calls.length === callsBefore && (await S.vie.agent.status()).consent.given === false, hit.join(' | ').slice(0, 300));
    check('D. la page tierce ne lit rien : réponses CORS bloquées (erreurs réseau) ou opaques', probe.every(x => x === 'err' || x === 0 || x === undefined || typeof x === 'number'), JSON.stringify(probe));

    // --- E. Redémarrage du serveur sur le même port : ancien cookie inutilisable --------------------------------------------------------------------------------------------------
    const port = S.port; await S.vie.close();
    S = await startVie(port);
    await pB.goto(S.url); await pB.click('#vie-launch');
    check('E. redémarrage du serveur (même port) : le cookie de l’ancienne exécution est refusé, l’assistant redevient verrouillé, aucun envoi possible', await pB.waitFor(`/verrouillé/.test(${status})&&document.querySelector('#vie-send').disabled===true`), (await pB.ev(status)).slice(0, 100));
    const t2 = S.vie.issueLaunchTicket(); await pB.goto(S.url + '#vie-boot=' + t2); await pB.click('#vie-launch');
    check('E. nouveau lancement après redémarrage (nouveau ticket) : l’assistant se déverrouille', await pB.waitFor(`!/verrouillé/.test(${status})&&document.querySelector('#vie-send').disabled===false`));

    // --- F. Mode structure / agent : inertes, même connecté, sans interrupteur serveur ----------------------------------------------------------------------------------------------
    check('F. mode structure absent par défaut même connecté (commutateur désactivé ou absent)', await (async () => { await pB.click('[data-vie="toggle-settings"]'); return pB.ev(`(()=>{const c=document.querySelector('#vie-dev');return !c||c.disabled===true;})()`); })());
    check('G. aucune erreur JavaScript sur les pages de test (CSP comprise)', [pA, pB, pC].every(p => p.errors.length === 0), [pA, pB, pC].flatMap(p => p.errors).slice(0, 2).join(' | '));
  } finally {
    for (const b of [b1, b2]) { try { b.ws.close(); b.proc.kill(); } catch (e) { /* déjà fermé */ } }
    await Promise.all([b1.closed, b2.closed]).catch(() => {});
    await S.vie.close(); evilSrv.close();
    await sleep(500); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* profil encore verrouillé : sans importance */ }
  }
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} PASS${failed.length ? `, ${failed.length} FAIL` : ''}`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('ERREUR', e); process.exit(1); });
