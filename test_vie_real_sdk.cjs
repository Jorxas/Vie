// Test d'INTÉGRATION avec le VRAI SDK @anthropic-ai/claude-agent-sdk et le VRAI binaire Claude Code, face à un FAUX Anthropic local (127.0.0.1, flux SSE scripté).
// Aucun appel réseau externe, aucun coût, aucune vraie clé (clé factice). Répertoire TEMPORAIRE INOFFENSIF. Nécessite `npm ci --ignore-scripts` (sinon : NON TESTÉ, code 2).
// Ce que ça prouve : le câblage réel (outils MCP en processus, canUseTool, hook PreToolUse, schéma des entrées PowerShell, reçus). Ce que ça ne prouve PAS : le comportement du vrai modèle.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { createAgent } = require('./vie-agent.cjs');
try { require.resolve('@anthropic-ai/claude-agent-sdk/package.json'); } catch (e) { try { require('./node_modules/@anthropic-ai/claude-agent-sdk/package.json'); } catch (e2) { console.log('NON TESTÉ : SDK non installé (npm ci --ignore-scripts).'); process.exit(2); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vie-real-sdk-')));
const home = path.join(tmp, 'home'); fs.mkdirSync(path.join(home, 'Cours'), { recursive: true }); fs.mkdirSync(path.join(home, 'Documents'));
fs.writeFileSync(path.join(home, 'Cours', 'cours1.md'), '# Cours\nle tri fusion\n');
fs.writeFileSync(path.join(home, '.env'), 'TOKEN=FAKE-NOT-REAL-ENV-VALUE-12345\n');
const target = path.join(home, 'Documents', 'rapport.md');
const FAKE_KEY = 'FAKE-REAL-SDK-KEY-NOT-A-SECRET-0123456789';
let pass = 0, fail = 0; const failures = [];
const check = (name, ok, detail = '') => { if (ok) pass++; else { fail++; failures.push(name); } console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };

// --- Faux Anthropic : un script de tours (chaque tour = un bloc tool_use ou du texte final) -------------------------------------
const requests = []; const seenKeys = new Set();
let turns = [];
const sse = (res, events) => { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); for (const [ev, data] of events) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); res.end(); };
function turnEvents(model, turn, idx) {
  const msg = { id: 'msg_' + idx, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 1 } };
  const ev = [['message_start', { type: 'message_start', message: msg }]];
  if (turn.tool) {
    ev.push(['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_' + idx, name: turn.tool, input: {} } }]);
    ev.push(['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(turn.input) } }]);
  } else {
    ev.push(['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }]);
    ev.push(['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: turn.text } }]);
  }
  ev.push(['content_block_stop', { type: 'content_block_stop', index: 0 }]);
  ev.push(['message_delta', { type: 'message_delta', delta: { stop_reason: turn.tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } }]);
  ev.push(['message_stop', { type: 'message_stop' }]);
  return ev;
}
let mainCalls = 0;
const mock = http.createServer((req, res) => {
  const chunks = []; req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8'); let body = null; try { body = JSON.parse(raw); } catch (e) { /* non JSON */ }
    seenKeys.add(req.headers['x-api-key'] || req.headers.authorization || '');
    requests.push({ method: req.method, url: req.url, stream: body && body.stream, model: body && body.model, tools: body && Array.isArray(body.tools) ? body.tools.map(t => t.name) : null, system: body && JSON.stringify(body.system || '').slice(0, 20000), raw: raw.length });
    if (req.method === 'POST' && /\/v1\/messages/.test(req.url) && body) {
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      if (!hasTools && !body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ id: 'msg_aux', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 2 } })); }
      const turn = turns[Math.min(mainCalls, turns.length - 1)]; mainCalls++;
      if (body.stream) return sse(res, turnEvents(body.model, turn, mainCalls));
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ id: 'msg_x', type: 'message', role: 'assistant', model: body.model, content: [turn.tool ? { type: 'tool_use', id: 'toolu_' + mainCalls, name: turn.tool, input: turn.input } : { type: 'text', text: turn.text }], stop_reason: turn.tool ? 'tool_use' : 'end_turn', usage: { input_tokens: 50, output_tokens: 20 } }));
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
  });
});

// Sonde d'EXFILTRATION : un proxy factice noté dans HTTP(S)_PROXY du binaire. Toute connexion sortante qui respecte ces variables (télémétrie, mise à jour, etc.) y est comptée.
const proxyHits = [];
const proxy = http.createServer((req, res) => { proxyHits.push(`${req.method} ${String(req.url).slice(0, 80)}`); res.writeHead(502); res.end(); });
proxy.on('connect', (req, sock) => { proxyHits.push(`CONNECT ${req.url}`); sock.destroy(); });
(async () => {
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${mock.address().port}`;
  const agent = createAgent({ home, cwd: home, backupRoot: path.join(tmp, 'bk'), configDir: path.join(tmp, 'cfg'), pdftotext: null, getKey: () => FAKE_KEY, env: { ...process.env, ANTHROPIC_BASE_URL: 'https://exfil.invalid', AWS_SECRET_ACCESS_KEY: 'FAKE-AWS-LEAK-CHECK' },
    childEnvExtra: { ANTHROPIC_BASE_URL: base, HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}`, HTTPS_PROXY: `http://127.0.0.1:${proxy.address().port}`, NO_PROXY: '127.0.0.1,localhost' }, approvalTtlMs: 60000, limits: { runMs: 150000 } });
  agent.setConsent(true, 1);
  const st = await agent.status();
  check('statut avec le vrai SDK : prêt', st.state === 'ready' && st.sdk.installed === true);
  const chat = { messages: [{ role: 'user', content: 'analyse mes cours' }], share: false, context: null, view: 'today', today: '2026-11-12' };
  const level = { model: 'claude-haiku-5-5', effort: 'medium', label: 'Haiku 5.5' };
  const waitDone = async (runId, onApproval) => {
    const t0 = Date.now(); let since = 0; const all = [];
    for (;;) {
      const r = agent.events(runId, 's1', since); since = r.next; all.push(...r.events);
      for (const e of r.events) if (e.type === 'approval' && onApproval) onApproval(e);
      if (r.state !== 'running') return { state: r.state, events: all };
      if (Date.now() - t0 > 120000) throw new Error('délai du test dépassé');
      await sleep(100);
    }
  };

  // Scénario A : lecture (liste, lecture de fichier, lecture de .env refusée), puis texte final avec proposition
  turns = [
    { tool: 'mcp__vie__list_dir', input: { path: home } },
    { tool: 'mcp__vie__read_file', input: { path: path.join(home, 'Cours', 'cours1.md') } },
    { tool: 'mcp__vie__read_file', input: { path: path.join(home, '.env') } },
    { text: 'Résumé : cours sur le tri fusion.\n```vie-proposals\n[{"name":"navigate_section","input":{"section":"study"}}]\n```' },
  ];
  let r1 = await agent.start({ sid: 's1', chat, level, maxUsd: 0.3 });
  const A = await waitDone(r1.runId);
  const tools = A.events.filter(e => e.type === 'tool'); const rcp = A.events.filter(e => e.type === 'receipt'); const done = A.events.find(e => e.type === 'done');
  check('A. vrai SDK : exécution terminée, 2 lectures autorisées sans carte', A.state === 'done' && tools.length === 2 && A.events.filter(e => e.type === 'approval').length === 0, JSON.stringify(done && { state: done.state, note: done.note }));
  check('A. lecture de .env refusée par la politique (hook ou canUseTool), aucun contenu renvoyé', rcp.some(x => x.result === 'refused') && !JSON.stringify(A.events).includes('FAKE-NOT-REAL-ENV-VALUE'));
  check('A. réponse finale et proposition du tableau de bord extraites', done && /tri fusion/.test(done.reply) && done.proposals.length === 1 && done.proposals[0].section === 'study');
  check('A. le faux Anthropic a reçu la clé factice (auth du binaire) et le modèle choisi, rien d’autre', [...seenKeys].some(k => k.includes(FAKE_KEY)) && requests.filter(x => x.tools).every(x => x.model === 'claude-haiku-5-5'), 'modèles : ' + [...new Set(requests.map(x => x.model))].join(','));
  const mainReq = requests.find(x => x.tools && x.tools.length);
  const names = mainReq ? mainReq.tools : [];
  check('A. outils exposés au modèle : nos outils MCP + PowerShell/Bash seulement (aucun Read/Write/WebFetch/Agent…)', names.length > 0 && names.every(n => n.startsWith('mcp__vie__') || ['PowerShell', 'Bash', 'DeferredToolPlaceholder'].includes(n)) && names.includes('PowerShell'), names.join(','));
  check('A. le prompt système envoyé est le nôtre (règles de l’agent), pas celui de Claude Code', !!mainReq && /MODE AGENT/.test(mainReq.system) && /NON FIABLES/.test(mainReq.system));
  check('A. aucune requête vers autre chose que le faux Anthropic local', requests.every(x => /^\/(v1\/)?(messages|complete|api|v1)/.test(x.url) || x.url === '/' || /^\/v1\//.test(x.url)), [...new Set(requests.map(x => x.method + ' ' + x.url.split('?')[0]))].join(', '));

  // Scénario B : écriture refusée puis commande approuvée (PowerShell réel : schéma des entrées du vrai outil)
  mainCalls = 0; requests.length = 0;
  turns = [
    { tool: 'mcp__vie__write_file', input: { path: target, content: 'rapport\n' } },
    { tool: 'PowerShell', input: { command: 'Write-Output "bonjour-vie"', description: 'Affiche un texte', timeout: 20000 } },
    { text: 'Terminé.' },
  ];
  r1 = await agent.start({ sid: 's1', chat, level, maxUsd: 0.3 });
  const cards = [];
  const B = await waitDone(r1.runId, e => { cards.push(e); const allow = e.tool === 'PowerShell'; setTimeout(() => agent.decide({ runId: r1.runId, sid: 's1', id: e.id, nonce: e.nonce, hash: e.hash, allow, ackNetwork: false }), 150); });
  const rb = B.events.filter(e => e.type === 'receipt');
  check('B. écriture : carte présentée, REFUSÉE → fichier absent, reçu « denied »', cards.some(c => c.tool === 'write_file') && !fs.existsSync(target) && rb.some(x => x.result === 'denied' && x.operation === 'write_file'));
  const shellCard = cards.find(c => c.tool === 'PowerShell');
  check('B. PowerShell réel : le schéma d’entrée du vrai outil passe la validation fermée, carte avec commande exacte', !!shellCard && shellCard.command === 'Write-Output "bonjour-vie"', shellCard ? '' : 'aucune carte PowerShell : ' + JSON.stringify(B.events.filter(e => e.type === 'receipt').map(e => [e.tool, e.result, e.detail])));
  const shellRc = rb.find(x => x.operation === 'command');
  check('B. commande approuvée : exécutée par le vrai outil, reçu avec sortie', !!shellRc && shellRc.ok === true && /bonjour-vie/.test(shellRc.output || ''), shellRc ? JSON.stringify({ ok: shellRc.ok, result: shellRc.result, out: (shellRc.output || '').slice(0, 80) }) : 'pas de reçu de commande');
  check('B. run terminé proprement, coût rapporté ou estimé', B.state === 'done' && A.events.find(e => e.type === 'done').usage.usd >= 0);

  // Scénario C : le modèle tente un outil intégré non fourni et une commande interdite
  mainCalls = 0; requests.length = 0;
  turns = [
    { tool: 'PowerShell', input: { command: 'Get-Content .env' } },
    { tool: 'WebFetch', input: { url: 'https://exemple.test', prompt: 'x' } },
    { tool: 'Write', input: { file_path: target, content: 'pirate' } },
    { text: 'Fin.' },
  ];
  r1 = await agent.start({ sid: 's1', chat, level, maxUsd: 0.3 });
  const C = await waitDone(r1.runId, e => setTimeout(() => agent.decide({ runId: r1.runId, sid: 's1', id: e.id, nonce: e.nonce, hash: e.hash, allow: true }), 100));
  check('C. commande citant .env : refus dur SANS carte ; outils non fournis inopérants ; aucun fichier créé', C.events.filter(e => e.type === 'approval').length === 0 && !fs.existsSync(target), JSON.stringify(C.events.filter(e => e.type === 'receipt').map(e => [e.tool, e.result])));

  // Scénario D : annulation d'une exécution réelle en attente de carte
  mainCalls = 0;
  turns = [{ tool: 'PowerShell', input: { command: 'Write-Output "jamais"' } }, { text: 'x' }];
  r1 = await agent.start({ sid: 's1', chat, level, maxUsd: 0.3 });
  await waitFor(() => agent.events(r1.runId, 's1', 0).events.some(e => e.type === 'approval'), 60000);
  agent.cancel(r1.runId, 's1');
  const D = await waitDone(r1.runId);
  check('D. annulation pendant une carte : exécution « cancelled », commande jamais exécutée', D.state === 'cancelled' && !D.events.some(e => e.type === 'receipt' && e.operation === 'command' && e.ok));
  async function waitFor(fn, ms) { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('délai'); await sleep(100); } }

  check('E. aucune connexion sortante tentée par le binaire (proxy sonde HTTP(S)_PROXY : 0 requête, hors faux Anthropic en NO_PROXY)', proxyHits.length === 0, proxyHits.slice(0, 4).join(' | '));
  await agent.close(); await new Promise(r => mock.close(r)); await new Promise(r => proxy.close(r));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* sans importance */ }
  console.log(`\n${pass}/${pass + fail} PASS${fail ? ' — ÉCHECS : ' + failures.join(' | ') : ''}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERREUR', e && e.stack || e); try { mock.close(); fs.rmSync(tmp, { recursive: true, force: true }); } catch (x) { /* ignoré */ } process.exit(1); });
