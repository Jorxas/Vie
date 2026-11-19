// V8 — VRAIE exécution contrôlée de l'interruption : vrai SDK @anthropic-ai/claude-agent-sdk + vrai binaire Claude Code + vrai PowerShell, face à un FAUX Anthropic local (127.0.0.1).
// Reproduit le NO-GO QA7 (P2-A) : une commande PowerShell approuvée dort puis crée un fichier-témoin ; Révoquer / Annuler / délai / fermeture pendant la commande doivent l'ARRÊTER
// (témoin jamais créé, arbre de processus terminé, run clôturé vite), sans toucher aux processus qui ne sont pas à Vie (processus « leurre » lancés par le test).
// Garanties de sécurité du test : dossier TEMP jetable ; clé factice ; aucun appel réseau externe (ANTHROPIC_BASE_URL -> 127.0.0.1) ; aucun .env, aucun vrai fichier ; commandes inoffensives
// (Start-Sleep + création d'un fichier vide dans le TEMP) ; aucun vrai modèle. Windows + SDK installé requis (sinon : NON TESTÉ, code 2). Durée ≈ 1,5 min.
// usage : node test_vie_v8_realsdk.cjs [racine_du_projet]   (par défaut : le dossier de ce fichier ; les ZIP extraits peuvent ainsi être testés tels quels)
'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http'), cp = require('node:child_process');
const root = path.resolve(process.argv[2] || __dirname);
const { createAgent } = require(path.join(root, 'vie-agent.cjs'));
if (process.platform !== 'win32') { console.log('NON TESTÉ : ce test vise PowerShell sous Windows.'); process.exit(2); }
if (!fs.existsSync(path.join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'))) { console.log('NON TESTÉ : SDK absent (npm ci --ignore-scripts).'); process.exit(2); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vie-v8-real-'))); const home = path.join(tmp, 'home'); fs.mkdirSync(path.join(home, 'Documents'), { recursive: true });
const FAKE_KEY = 'FAKE-REAL-SDK-KEY-NOT-A-SECRET-V8-0123456789';
let pass = 0, fail = 0; const failures = [];
const check = (name, ok, detail = '') => { if (ok) pass++; else { fail++; failures.push(name); } console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };

// --- Faux Anthropic (scénario = liste de tours) ----------------------------------------------------------------------------------------------------------------
let turns = [], mainCalls = 0;
const sse = (res, events) => { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); for (const [ev, data] of events) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); res.end(); };
function turnEvents(model, turn, idx) {
  const msg = { id: 'msg_' + idx, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 1 } };
  const ev = [['message_start', { type: 'message_start', message: msg }]];
  if (turn.tool) { ev.push(['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_' + idx, name: turn.tool, input: {} } }]); ev.push(['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(turn.input) } }]); }
  else { ev.push(['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }]); ev.push(['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: turn.text } }]); }
  ev.push(['content_block_stop', { type: 'content_block_stop', index: 0 }], ['message_delta', { type: 'message_delta', delta: { stop_reason: turn.tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } }], ['message_stop', { type: 'message_stop' }]);
  return ev;
}
const mock = http.createServer((req, res) => { const ch = []; req.on('data', c => ch.push(c)); req.on('end', () => {
  let body = null; try { body = JSON.parse(Buffer.concat(ch).toString('utf8')); } catch (e) { /* non JSON */ }
  if (req.method === 'POST' && /\/v1\/messages/.test(req.url) && body) {
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    if (!hasTools && !body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ id: 'msg_aux', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 2 } })); }
    const turn = turns[Math.min(mainCalls, turns.length - 1)]; mainCalls++;
    if (body.stream) return sse(res, turnEvents(body.model, turn, mainCalls));
    res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ id: 'msg_x', type: 'message', role: 'assistant', model: body.model, content: [turn.tool ? { type: 'tool_use', id: 'toolu_' + mainCalls, name: turn.tool, input: turn.input } : { type: 'text', text: turn.text }], stop_reason: turn.tool ? 'tool_use' : 'end_turn', usage: { input_tokens: 50, output_tokens: 20 } }));
  }
  res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); }); });

// --- Processus du test : photographie de l'arbre des descendants (hors le contrôleur lui-même) --------------------------------------------------------------------
function snapshot() {
  const r = cp.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$l = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name); [pscustomobject]@{ self = $PID; list = $l } | ConvertTo-Json -Compress -Depth 4'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  let o; try { o = JSON.parse(r.stdout); } catch (e) { return null; }
  return o && Array.isArray(o.list) ? o : null;
}
// Descendants de rootPid, sans le sous-arbre du contrôleur (le PowerShell de snapshot lui-même) ni celui des leurres.
function descendantsOf(rootPid, snap, excludeRoots = []) {
  const kids = new Map(); for (const p of snap.list) { if (!kids.has(p.ParentProcessId)) kids.set(p.ParentProcessId, []); kids.get(p.ParentProcessId).push(p); }
  const out = new Map(), stack = [rootPid], skip = new Set([...excludeRoots, snap.self]);
  while (stack.length) { const pid = stack.pop(); for (const c of kids.get(pid) || []) { if (skip.has(c.ProcessId) || out.has(c.ProcessId)) continue; out.set(c.ProcessId, c.Name); stack.push(c.ProcessId); } }
  return out;
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// Leurres : processus du test (PowerShell dormant) qui n'appartiennent PAS au moteur de Vie ; ils doivent survivre à toutes les interruptions.
const decoys = [];
const spawnDecoy = () => { const d = cp.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 300'], { stdio: 'ignore', windowsHide: true }); decoys.push(d); return d; };

(async () => {
  await new Promise(r => mock.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${mock.address().port}`;
  const mkAgent = (extra = {}) => createAgent({ home, cwd: home, backupRoot: path.join(tmp, 'bk'), configDir: path.join(tmp, 'cfg'), pdftotext: null, getKey: () => FAKE_KEY, env: { ...process.env, ANTHROPIC_BASE_URL: 'https://exfil.invalid' }, childEnvExtra: { ANTHROPIC_BASE_URL: base }, approvalTtlMs: 60000, limits: { runMs: 120000 }, ...extra });
  const chat = { messages: [{ role: 'user', content: 'diag' }], share: false, context: null, view: 'today', today: '2026-11-18' }; const level = { model: 'claude-haiku-5-5', effort: 'low', label: 'Haiku 5.5' };
  const marker = n => path.join(tmp, 'marker_' + n + '.txt');
  const q = s => s.replace(/'/g, "''");
  const decoyA = spawnDecoy(), decoyB = spawnDecoy(); await sleep(800);

  // sc = { n, cmd(sleepS), sleepS, act: 'revoke'|'cancel'|'close'|'timeout'|null, afterDecideMs, runMs }
  async function scenario(sc) {
    const agent = mkAgent(sc.runMs ? { limits: { runMs: sc.runMs } } : {}); agent.setConsent(true, 1); mainCalls = 0;
    turns = [{ tool: 'PowerShell', input: { command: sc.cmd, description: 'témoin long', timeout: 60000 } }, { text: 'Terminé.' }];
    const before = snapshot(); const baseline = before ? new Set(descendantsOf(process.pid, before).keys()) : null;
    const r = await agent.start({ sid: 's', chat, level, maxUsd: 0.3 });
    let since = 0, decided = false, state = 'running', tDecide = 0, tAct = 0, tEnd = 0; const t0 = Date.now(); let events = [];
    while (true) {
      const ev = agent.events(r.runId, 's', since); since = ev.next; state = ev.state; events = events.concat(ev.events);
      const ap = ev.events.find(e => e.type === 'approval');
      if (ap && !decided) {
        decided = true;
        if (sc.act === 'revoke-pending' || sc.act === 'cancel-pending') { tAct = Date.now(); if (sc.act === 'revoke-pending') agent.setConsent(false); else agent.cancel(r.runId, 's'); }
        else {
          agent.decide({ runId: r.runId, sid: 's', id: ap.id, nonce: ap.nonce, hash: ap.hash, allow: true }); tDecide = Date.now();
          if (sc.act && sc.act !== 'timeout') setTimeout(() => { tAct = Date.now(); if (sc.act === 'revoke') agent.setConsent(false); else if (sc.act === 'cancel') agent.cancel(r.runId, 's'); else if (sc.act === 'close') agent.close(); }, sc.afterDecideMs);
        }
      }
      if (state !== 'running') { tEnd = Date.now(); break; }
      if (Date.now() - t0 > 90000) { agent.cancel(r.runId, 's'); tEnd = Date.now(); break; }
      await sleep(15);
    }
    const existsAtEnd = fs.existsSync(marker(sc.n));
    await sleep(Math.max(500, (sc.sleepS + 3) * 1000 - (Date.now() - (tDecide || t0))));   // attend largement la fin théorique de la commande
    const existsLater = fs.existsSync(marker(sc.n));
    const after = snapshot(); const leftovers = after && baseline ? [...descendantsOf(process.pid, after, [decoyA.pid, decoyB.pid]).entries()].filter(([pid]) => !baseline.has(pid)) : null;
    const rc = events.find(e => e.type === 'receipt' && e.operation === 'command');
    const done = events.find(e => e.type === 'done');
    const st = await agent.status();
    const out = { state, endedAfterActMs: tAct ? tEnd - tAct : null, actAfterDecideMs: tAct && tDecide ? tAct - tDecide : null, existsAtEnd, existsLater, receipt: rc ? rc.result : null, leftovers: leftovers === null ? '?' : leftovers.map(([p, n]) => `${n}:${p}`), unsafe: st.unsafe, note: done && done.note, active: agent.isActive(), agent };
    return out;
  }
  const show = o => JSON.stringify({ ...o, agent: undefined });

  // 0) TÉMOIN POSITIF : sans interruption, la commande crée bien son fichier (sinon les autres résultats ne prouveraient rien)
  { const sc = { n: 'ctrl', sleepS: 4, act: null }; sc.cmd = `Start-Sleep -Seconds 4; New-Item -ItemType File -Path '${q(marker('ctrl'))}' -Force | Out-Null`;
    const o = await scenario(sc); check('témoin positif : sans interruption, la commande aboutit (fichier-témoin créé, reçu « done »)', o.existsLater && o.receipt === 'done' && o.state === 'done', show(o)); o.agent.close(); }
  // 1) RÉVOQUER à 2,5 s (REPRO exact de QA7 P2-A)
  { const sc = { n: 'revoke', sleepS: 7, act: 'revoke', afterDecideMs: 2500 }; sc.cmd = `Start-Sleep -Seconds 7; New-Item -ItemType File -Path '${q(marker('revoke'))}' -Force | Out-Null`;
    const o = await scenario(sc);
    check('REVOKE à 2,5 s : fichier-témoin JAMAIS créé (ni à la fin du run, ni après la fin théorique de la commande)', !o.existsAtEnd && !o.existsLater, show(o));
    check('REVOKE : run clôturé « cancelled » en moins de 3 s après la révocation, plus actif', o.state === 'cancelled' && o.endedAfterActMs !== null && o.endedAfterActMs < 3000 && !o.active, show(o));
    check('REVOKE : reçu de la commande « interrupted » (jamais « done »), pas de processus de l\'arbre resté vivant, moteur non marqué dangereux', o.receipt === 'interrupted' && Array.isArray(o.leftovers) && o.leftovers.length === 0 && o.unsafe === false, show(o));
    check('REVOKE : les processus leurres (non possédés par Vie) sont toujours vivants', alive(decoyA.pid) && alive(decoyB.pid)); o.agent.close(); }
  // 2) ANNULER à 2,5 s, puis une NOUVELLE exécution fonctionne
  { const sc = { n: 'cancel', sleepS: 7, act: 'cancel', afterDecideMs: 2500 }; sc.cmd = `Start-Sleep -Seconds 7; New-Item -ItemType File -Path '${q(marker('cancel'))}' -Force | Out-Null`;
    const o = await scenario(sc);
    check('CANCEL à 2,5 s : fichier-témoin jamais créé, run « cancelled » en < 3 s, reçu « interrupted », aucun résidu', !o.existsAtEnd && !o.existsLater && o.state === 'cancelled' && o.endedAfterActMs < 3000 && o.receipt === 'interrupted' && Array.isArray(o.leftovers) && o.leftovers.length === 0, show(o));
    check('CANCEL : le consentement est conservé et l\'agent n\'est pas marqué dangereux (une exécution suivante est possible)', o.agent.consentState().given === true && o.unsafe === false);
    const sc2 = { n: 'after', sleepS: 1, act: null }; sc2.cmd = `New-Item -ItemType File -Path '${q(marker('after'))}' -Force | Out-Null`;
    const o2 = await scenario({ ...sc2 }); check('après un Annuler, une nouvelle exécution (nouveau moteur) aboutit : fichier créé, reçu « done »', o2.existsLater && o2.receipt === 'done', show(o2)); o2.agent.close(); o.agent.close(); }
  // 3) ARBRE DE DESCENDANTS : PowerShell -> cmd -> PowerShell fils (qui crée le témoin) ; révoquer à 2,5 s
  { const inner = `Start-Sleep -Seconds 7; New-Item -ItemType File -Path ''${q(marker('tree'))}'' -Force | Out-Null`;
    const sc = { n: 'tree', sleepS: 7, act: 'revoke', afterDecideMs: 2500, cmd: `& cmd.exe /c "powershell.exe -NoProfile -NonInteractive -Command ${inner.replace(/"/g, '\\"').replace(/''/g, "'")}"` };
    sc.cmd = `cmd.exe /c powershell.exe -NoProfile -NonInteractive -Command "Start-Sleep -Seconds 7; New-Item -ItemType File -Path '${q(marker('tree'))}' -Force | Out-Null"`;
    const o = await scenario(sc);
    check('ARBRE (PowerShell -> cmd -> PowerShell fils) : REVOKE à 2,5 s -> témoin du petit-fils jamais créé et aucun descendant resté vivant', !o.existsAtEnd && !o.existsLater && o.state === 'cancelled' && Array.isArray(o.leftovers) && o.leftovers.length === 0, show(o)); o.agent.close(); }
  // 4) RÉVOCATION IMMÉDIATE (≈ quelques ms après la décision : la commande est « partie » côté moteur, cas cité par QA7)
  { const sc = { n: 'fast', sleepS: 6, act: 'revoke', afterDecideMs: 3 }; sc.cmd = `Start-Sleep -Seconds 6; New-Item -ItemType File -Path '${q(marker('fast'))}' -Force | Out-Null`;
    const o = await scenario(sc); check('REVOKE ~3 ms après la décision : témoin jamais créé, run clôturé, aucun résidu', !o.existsLater && o.state === 'cancelled' && Array.isArray(o.leftovers) && o.leftovers.length === 0, show(o)); o.agent.close(); }
  // 5) DÉLAI maximal de l'exécution dépassé (runMs = 4 s) pendant une commande de 9 s
  { const sc = { n: 'timeout', sleepS: 9, act: 'timeout', runMs: 4000 }; sc.cmd = `Start-Sleep -Seconds 9; New-Item -ItemType File -Path '${q(marker('timeout'))}' -Force | Out-Null`;
    const o = await scenario(sc); check('DÉLAI dépassé (4 s) : commande arrêtée (témoin jamais créé), run « error » avec note de délai, reçu « interrupted »', !o.existsLater && o.state === 'error' && /Délai/.test(o.note || '') && o.receipt === 'interrupted' && Array.isArray(o.leftovers) && o.leftovers.length === 0, show(o)); o.agent.close(); }
  // 6) FERMETURE du serveur (close) pendant la commande
  { const sc = { n: 'close', sleepS: 7, act: 'close', afterDecideMs: 2500 }; sc.cmd = `Start-Sleep -Seconds 7; New-Item -ItemType File -Path '${q(marker('close'))}' -Force | Out-Null`;
    const o = await scenario(sc); check('FERMETURE (agent.close) pendant la commande : témoin jamais créé, aucun résidu', !o.existsLater && Array.isArray(o.leftovers) && o.leftovers.length === 0, show(o)); }
  // 7) RÉVOCATION pendant que la CARTE est en attente (avant toute décision) : rien ne part, le moteur est tué
  { const sc = { n: 'pending', sleepS: 5, act: 'revoke-pending' }; sc.cmd = `Start-Sleep -Seconds 5; New-Item -ItemType File -Path '${q(marker('pending'))}' -Force | Out-Null`;
    const o = await scenario(sc); check('RÉVOCATION avec carte en attente : commande jamais lancée (témoin absent), run « cancelled », aucun résidu', !o.existsLater && o.state === 'cancelled' && Array.isArray(o.leftovers) && o.leftovers.length === 0, show(o)); o.agent.close(); }
  // 8) ANNULATION avec carte en attente
  { const sc = { n: 'pending2', sleepS: 5, act: 'cancel-pending' }; sc.cmd = `Start-Sleep -Seconds 5; New-Item -ItemType File -Path '${q(marker('pending2'))}' -Force | Out-Null`;
    const o = await scenario(sc); check('ANNULATION avec carte en attente : commande jamais lancée, run « cancelled », aucun résidu', !o.existsLater && o.state === 'cancelled' && Array.isArray(o.leftovers) && o.leftovers.length === 0, show(o)); o.agent.close(); }
  check('à la fin, les deux leurres (étrangers à Vie) sont toujours vivants : aucun processus non possédé n\'a été tué', alive(decoyA.pid) && alive(decoyB.pid));

  for (const d of decoys) { try { cp.spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(d.pid), '/T', '/F'], { windowsHide: true }); } catch (e) { /* */ } }
  mock.close(); await sleep(500);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { console.log('nettoyage partiel', e.code); }
  console.log(`\n${pass + fail} contrôles, ${pass} PASS, ${fail} FAIL`); if (fail) { console.log('FAIL : ' + failures.join(' | ')); process.exit(1); } process.exit(0);
})().catch(e => { console.log('ERREUR', e && e.stack || e); for (const d of decoys) { try { d.kill(); } catch (e2) { /* */ } } process.exit(2); });
