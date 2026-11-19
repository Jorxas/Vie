// Tests de régression V8 (QA7 : NO-GO P2-A « Révoquer / Annuler n'arrêtent pas une commande shell déjà lancée » + P3 associés) — SANS vrai moteur, SANS vraie commande :
//   - vie-proc.cjs : arrêt de l'arbre de processus avec spawn / taskkill SIMULÉS (arguments exacts, chemin absolu, aucun pid étranger, pas de pid réutilisé, repli, échec fermé) ;
//   - vie-agent.cjs : faux SDK + faux contrôleur de processus (arrêt demandé une seule fois, reçus, états, courses approbation/révocation, filet de clôture, échec fermé, refus si non interruptible) ;
//   - vie-policy.cjs : descendants protégés définis par une SUITE de noms (.config\gh, Chrome\User Data, Protect), jokers visant un nom protégé ;
//   - interface : libellés « interrompue », bouton Révoquer hors ligne, resynchronisation au retour sur l'onglet (contrôles statiques ; le navigateur est couvert par test_vie_v8_browser si présent).
// La vraie exécution (vrai SDK, vrai PowerShell, fichier-témoin TEMP) est dans test_vie_v8_realsdk.cjs. Tout ici se passe dans un dossier TEMP créé puis supprimé ; aucun réseau, aucun .env réel.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createAgent, AgentError } = require('./vie-agent.cjs');
const { createPolicy } = require('./vie-policy.cjs');
const { createProcessControl } = require('./vie-proc.cjs');
const { createFakeSdk } = require('./fake_agent_sdk.cjs');

const win = process.platform === 'win32';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const failures = [];
async function t(name, fn) { try { await fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; failures.push(name); console.log('  KO  ' + name + '\n      ' + String(e && e.stack || e).split('\n').slice(0, 4).join('\n      ')); } }
async function waitFor(fn, ms = 4000) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('délai dépassé en attendant une condition'); await sleep(5); } }
const gate = () => { let release; const promise = new Promise(r => { release = r; }); return { promise, release }; };

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vie-v8-test-')));
const home = path.join(tmp, 'home'); const vieRoot = path.join(home, 'Desktop', 'Vie'); const docs = path.join(home, 'Documents');
const mkd = p => { fs.mkdirSync(p, { recursive: true }); return p; };
mkd(vieRoot); mkd(docs); fs.writeFileSync(path.join(vieRoot, '.env'), 'ANTHROPIC_API_KEY=FAKE-ENV-CANARY-NOT-A-SECRET\n');
const FAKE_KEY = 'FAKE-KEY-NOT-A-SECRET-V8-REGRESS-0123456789';
const level = { model: 'claude-haiku-5-5', effort: 'low', label: 'test' };
const chat = { share: false, messages: [{ role: 'user', content: 'diag' }], view: 'today', today: '2026-11-18' };
const CMD = 'Write-Output SYNTHETIC_ONLY';

// --- Faux contrôleur de processus (aucun processus réel) ---------------------------------------------------------------------------------------------------------
function mockCtl() {
  const log = { spawned: [], killed: [] };
  const state = { interruptible: true, killOk: true, emitExit: true, killDelayMs: 0 };
  const ctl = {
    log, state,
    spawner({ onHandle, guard }) {
      return () => {
        if (guard) guard();
        const child = new EventEmitter(); child.pid = 40000 + log.spawned.length; child.kill = () => true; child.stdin = null; child.stdout = null;
        const h = { child, pid: child.pid, exited: false }; log.spawned.push(h); onHandle(h); return child;
      };
    },
    killTree(h) {
      log.killed.push(h.pid);
      if (!state.killOk) return { ok: false, method: 'taskkill', alreadyExited: false, ms: 1, detail: 'simulé : processus encore vivant' };
      h.exited = true; if (state.emitExit) setImmediate(() => h.child.emit('exit', 1, null));
      return { ok: true, method: 'taskkill', alreadyExited: false, ms: 1, detail: 'simulé' };
    },
    interruptible(h) { return state.interruptible && !!h && !h.exited; },
  };
  return ctl;
}
const mkAgent = (fake, ctl, extra = {}) => createAgent({ sdkLoader: fake.sdkLoader, procControl: ctl, getKey: () => FAKE_KEY, home, cwd: home, vieRoot, backupRoot: path.join(tmp, 'bk'), configDir: path.join(tmp, 'cfg'), pdftotext: null, env: { PATH: process.env.PATH || '' }, ...extra });
const start = (a, o = {}) => a.start({ sid: 's1', chat, level, maxUsd: 0.05, ctx: null, ...o });
const recs = (a, id) => a.events(id, 's1', 0).events;
const stateOf = (a, id) => a.events(id, 's1', 0).state;
const cardOf = async (a, id) => waitFor(() => recs(a, id).filter(e => e.type === 'approval').pop());
const approve = (a, id, ap) => a.decide({ runId: id, sid: 's1', id: ap.id, nonce: ap.nonce, hash: ap.hash, allow: true });

(async () => {
  console.log('\nvie-proc.cjs : arrêt d\'arbre de processus (spawn / taskkill simulés)');
  const mkSim = (o = {}) => {
    const sim = { spawned: [], sync: [], aliveSet: new Set(), kills: [] };
    const spawn = (cmd, args, opts) => { const child = new EventEmitter(); child.pid = o.pid || 5150; child.exitCode = null; child.signalCode = null; child.stderr = new EventEmitter(); child.kill = sig => { sim.kills.push(sig); if (o.childKillWorks !== false) sim.aliveSet.delete(child.pid); return true; }; sim.aliveSet.add(child.pid); sim.spawned.push({ cmd, args, opts, child }); return child; };
    const spawnSync = (cmd, args, opts) => { sim.sync.push({ cmd, args, opts }); if (o.taskkillWorks !== false) sim.aliveSet.clear(); return { status: o.taskkillWorks === false ? 128 : 0 }; };
    const ctl = createProcessControl({ platform: o.platform || 'win32', spawn, spawnSync, env: { SystemRoot: 'C:\\Windows' }, isAlive: pid => sim.aliveSet.has(pid), processKill: (pid, sig) => { sim.kills.push(['pk', pid, sig]); sim.aliveSet.clear(); }, noExitHook: true, timeoutMs: 500 });
    return { sim, ctl };
  };
  await t('spawner : le moteur est lancé par Vie (pipes, fenêtre cachée), le handle est transmis et suivi', () => {
    const { sim, ctl } = mkSim(); let got = null;
    const child = ctl.spawner({ onHandle: h => { got = h; } })({ command: 'claude.exe', args: ['--x'], cwd: home, env: { A: '1' }, signal: new AbortController().signal });
    assert.equal(sim.spawned.length, 1); assert.deepEqual(sim.spawned[0].opts.stdio, ['pipe', 'pipe', 'pipe']); assert.equal(sim.spawned[0].opts.windowsHide, true); assert.equal(sim.spawned[0].opts.detached, false);
    assert.equal(got.pid, 5150); assert.equal(got.child, child); assert.equal(ctl.liveCount(), 1);
    child.emit('exit', 0, null); assert.equal(ctl.liveCount(), 0);
  });
  await t('spawner : aucun `signal` transmis à spawn (un abort ne doit jamais tuer la seule racine, ses descendants deviendraient introuvables)', () => {
    const { sim, ctl } = mkSim(); ctl.spawner({ onHandle: () => {} })({ command: 'claude.exe', args: [], env: {}, signal: new AbortController().signal });
    assert.equal('signal' in sim.spawned[0].opts, false);
  });
  await t('spawner : la garde peut refuser le lancement (exécution déjà interrompue) -> aucun spawn', () => {
    const { sim, ctl } = mkSim();
    assert.throws(() => ctl.spawner({ onHandle: () => assert.fail('pas de handle'), guard: () => { throw new Error('interrompu'); } })({ command: 'claude.exe', args: [], env: {} }), /interrompu/);
    assert.equal(sim.spawned.length, 0);
  });
  await t('killTree (Windows) : taskkill /PID <pid> /T /F par chemin ABSOLU, une seule fois, sur le pid du handle possédé', () => {
    const { sim, ctl } = mkSim(); let h; ctl.spawner({ onHandle: x => { h = x; } })({ command: 'claude.exe', args: [], env: {} });
    const r = ctl.killTree(h);
    assert.equal(r.ok, true); assert.equal(sim.sync.length, 1);
    assert.equal(sim.sync[0].cmd, 'C:\\Windows\\System32\\taskkill.exe'); assert.deepEqual(sim.sync[0].args, ['/PID', '5150', '/T', '/F']);
    assert.equal(sim.kills.length, 0, 'pas de repli nécessaire quand taskkill a réussi');
  });
  await t('killTree : un processus DÉJÀ SORTI n\'est pas visé (pid potentiellement réutilisé) -> aucun taskkill', () => {
    const { sim, ctl } = mkSim(); let h; const child = ctl.spawner({ onHandle: x => { h = x; } })({ command: 'claude.exe', args: [], env: {} });
    child.emit('exit', 0, null);
    const r = ctl.killTree(h); assert.equal(r.ok, true); assert.equal(r.alreadyExited, true); assert.equal(sim.sync.length, 0); assert.equal(sim.kills.length, 0);
    const { sim: s2, ctl: c2 } = mkSim(); let h2; const ch2 = c2.spawner({ onHandle: x => { h2 = x; } })({ command: 'claude.exe', args: [], env: {} }); ch2.exitCode = 0;
    assert.equal(c2.killTree(h2).alreadyExited, true); assert.equal(s2.sync.length, 0);
  });
  await t('killTree : jamais un processus non possédé (objet sans child, pid texte, pid <= 4, rien) -> refus, aucun appel système', () => {
    const { sim, ctl } = mkSim();
    for (const bad of [null, undefined, {}, { pid: 1234 }, { pid: '1234', child: {} }, { pid: NaN, child: {} }]) assert.equal(ctl.killTree(bad).ok, false, JSON.stringify(bad));
    assert.equal(sim.sync.length, 0); assert.equal(sim.kills.length, 0);
    for (const pid of [0, 1, 4]) assert.equal(ctl.interruptible({ pid, child: { exitCode: null, signalCode: null }, exited: false }), false, 'pid ' + pid);
    assert.equal(ctl.interruptible(null), false); assert.equal(ctl.interruptible({ pid: 99999, exited: false }), false, 'sans child');
  });
  await t('killTree : taskkill en échec -> repli TerminateProcess sur la racine ; si le processus vit encore -> ok:false (échec fermé)', () => {
    const a = mkSim({ taskkillWorks: false }); let h; a.ctl.spawner({ onHandle: x => { h = x; } })({ command: 'c', args: [], env: {} });
    const r = a.ctl.killTree(h); assert.deepEqual(a.sim.kills, ['SIGKILL']); assert.equal(r.ok, true, 'racine tuée par le repli');
    const b = mkSim({ taskkillWorks: false, childKillWorks: false }); let h2; b.ctl.spawner({ onHandle: x => { h2 = x; } })({ command: 'c', args: [], env: {} });
    const r2 = b.ctl.killTree(h2); assert.equal(r2.ok, false); assert.match(r2.detail, /encore vivant/); assert.equal(h2.killed, false);
  });
  await t('killTree (POSIX) : groupe de processus -kill(-pid) ; lancement detached ; pas de taskkill', () => {
    const { sim, ctl } = mkSim({ platform: 'linux' }); let h; ctl.spawner({ onHandle: x => { h = x; } })({ command: 'c', args: [], env: {} });
    assert.equal(sim.spawned[0].opts.detached, true);
    const r = ctl.killTree(h); assert.equal(r.ok, true); assert.equal(sim.sync.length, 0); assert.deepEqual(sim.kills[0], ['pk', -5150, 'SIGKILL']);
  });
  await t('killTree : appels répétés = idempotents (le 2e voit « déjà sorti » ou « pas vivant »)', () => {
    const { sim, ctl } = mkSim(); let h; const child = ctl.spawner({ onHandle: x => { h = x; } })({ command: 'c', args: [], env: {} });
    assert.equal(ctl.killTree(h).ok, true); child.emit('exit', 1, null);
    const r2 = ctl.killTree(h); assert.equal(r2.ok, true); assert.equal(r2.alreadyExited, true); assert.equal(sim.sync.length, 1);
  });

  console.log('\nvie-agent.cjs : interruption réelle, états, reçus, courses (faux SDK + faux contrôleur)');
  await t('REPRO : révoquer pendant une commande approuvée -> le processus du moteur est tué UNE fois, run « cancelled » vite, reçu « interrompue », commande jamais terminée', async () => {
    const ctl = mockCtl(); const g = gate(); const done = [];   // la commande SIMULÉE est une promesse en processus (non tuable ici) : la vraie commande est testée dans test_vie_v8_realsdk.cjs
    const fake = createFakeSdk({ script: async api => { await api.use('PowerShell', { command: CMD }); return 'fin'; }, shell: async c => { await g.promise; done.push(c); return { out: 'ok' }; } });
    const a = mkAgent(fake, ctl); a.setConsent(true, 1);
    const { runId } = await start(a);
    const ap = await cardOf(a, runId); assert.equal(approve(a, runId, ap).ok, true);
    await waitFor(() => fake.calls.shell.length === 1);                     // la commande est PARTIE
    const t0 = Date.now(); a.setConsent(false);
    assert.equal(ctl.log.killed.length, 1, 'arrêt demandé de façon synchrone par la révocation'); assert.equal(ctl.log.killed[0], ctl.log.spawned[0].pid);
    await waitFor(() => stateOf(a, runId) !== 'running', 1500);
    assert.ok(Date.now() - t0 < 1500); assert.equal(stateOf(a, runId), 'cancelled'); assert.equal(a.isActive(), false);
    const rc = recs(a, runId).filter(e => e.type === 'receipt' && e.operation === 'command'); assert.equal(rc.length, 1); assert.equal(rc[0].result, 'interrupted'); assert.equal(rc[0].ok, false); assert.match(rc[0].detail, /interrompue/);
    g.release(); await sleep(30); assert.ok(!recs(a, runId).some(e => e.type === 'receipt' && e.result === 'done'), 'aucun reçu « fait » : le résultat d\'une commande tuée n\'est jamais relayé');assert.equal(recs(a, runId).filter(e => e.type === 'receipt' && e.operation === 'command').length, 1);
    assert.equal((await a.status()).unsafe, false);
  });
  await t('ORDRE : l’arbre de processus est tué AVANT l’abort du signal (sinon la racine mourrait d’abord et taskkill /T ne retrouverait plus ses descendants)', async () => {
    const ctl = mockCtl(); const g = gate(); let abortedAtKill = null; let run = null;
    const realKill = ctl.killTree; ctl.killTree = h => { abortedAtKill = run.ac.signal.aborted; return realKill(h); };
    const fake = createFakeSdk({ script: async api => { await api.use('PowerShell', { command: CMD }); return 'fin'; }, shell: async () => { await g.promise; return { out: 'ok' }; } });
    const a = mkAgent(fake, ctl); a.setConsent(true, 1);
    const { runId } = await start(a); run = a._runs.get(runId); const ap = await cardOf(a, runId); approve(a, runId, ap); await waitFor(() => fake.calls.shell.length === 1);
    a.cancel(runId, 's1'); assert.equal(abortedAtKill, false, 'le signal ne devait pas encore être interrompu au moment de l’arrêt de l’arbre'); assert.equal(run.ac.signal.aborted, true); g.release();
  });
  await t('Annuler pendant la commande : même arrêt, état « cancelled », consentement conservé, nouvelle exécution possible', async () => {
    const ctl = mockCtl(); const g = gate();
    const fake = createFakeSdk({ script: async api => { await api.use('PowerShell', { command: CMD }); return 'fin'; }, shell: async () => { await g.promise; return { out: 'ok' }; } });
    const a = mkAgent(fake, ctl); a.setConsent(true, 1);
    const { runId } = await start(a); const ap = await cardOf(a, runId); approve(a, runId, ap); await waitFor(() => fake.calls.shell.length === 1);
    a.cancel(runId, 's1'); assert.equal(ctl.log.killed.length, 1);
    await waitFor(() => stateOf(a, runId) !== 'running', 1500); assert.equal(stateOf(a, runId), 'cancelled');
    assert.equal(a.consentState().given, true); assert.equal(recs(a, runId).find(e => e.type === 'receipt' && e.operation === 'command').result, 'interrupted');
    const { runId: r2 } = await start(a); assert.ok(r2); a.cancel(r2, 's1'); g.release();
  });
  await t('idempotence : Annuler + Révoquer + Annuler + délai, dans le désordre -> UN seul arrêt, un seul reçu de commande', async () => {
    const ctl = mockCtl(); const g = gate();
    const fake = createFakeSdk({ script: async api => { await api.use('PowerShell', { command: CMD }); return 'fin'; }, shell: async () => { await g.promise; return { out: 'ok' }; } });
    const a = mkAgent(fake, ctl); a.setConsent(true, 1);
    const { runId } = await start(a); const ap = await cardOf(a, runId); approve(a, runId, ap); await waitFor(() => fake.calls.shell.length === 1);
    a.cancel(runId, 's1'); a.setConsent(false); a.cancel(runId, 's1'); await a.close();
    assert.equal(ctl.log.killed.length, 1);
    await waitFor(() => stateOf(a, runId) !== 'running', 1500); await sleep(60);
    assert.equal(recs(a, runId).filter(e => e.type === 'receipt' && e.operation === 'command').length, 1); assert.equal(recs(a, runId).filter(e => e.type === 'done').length, 1);
    g.release();
  });
  await t('délai dépassé : l\'arrêt du moteur est aussi demandé (état « error », reçu « interrompue »)', async () => {
    const ctl = mockCtl(); const g = gate();
    const fake = createFakeSdk({ script: async api => { await api.use('PowerShell', { command: CMD }); return 'fin'; }, shell: async () => { await g.promise; return { out: 'ok' }; } });
    const a = mkAgent(fake, ctl, { limits: { runMs: 400 } }); a.setConsent(true, 1);
    const { runId } = await start(a); const ap = await cardOf(a, runId); approve(a, runId, ap); await waitFor(() => fake.calls.shell.length === 1);
    await waitFor(() => stateOf(a, runId) !== 'running', 3000);
    assert.equal(stateOf(a, runId), 'error'); assert.equal(ctl.log.killed.length, 1); assert.match(a.events(runId, 's1', 0).events.find(e => e.type === 'done').note, /Délai/);
    assert.equal(recs(a, runId).find(e => e.type === 'receipt' && e.operation === 'command').result, 'interrupted'); g.release();
  });
  await t('modèle inattendu annoncé par le moteur : arrêt du moteur demandé (pas seulement un abort)', async () => {
    const ctl = mockCtl(); const g = gate();
    const fake = createFakeSdk({ driftModel: 'claude-opus-5-5', script: async api => { api.say('bonjour'); await g.promise; return 'x'; } });
    const a = mkAgent(fake, ctl); a.setConsent(true, 1);
    const { runId } = await start(a); await waitFor(() => stateOf(a, runId) !== 'running', 3000);
    assert.equal(stateOf(a, runId), 'error'); assert.equal(ctl.log.killed.length, 1); g.release();
  });
  await t('fin NORMALE : aucun arrêt forcé (le moteur se termine seul), pas de reçu « interrompue »', async () => {
    const ctl = mockCtl();
    const fake = createFakeSdk({ script: async api => { await api.use('PowerShell', { command: CMD }); return 'fin'; }, shell: async () => ({ out: 'ok' }) });
    const a = mkAgent(fake, ctl); a.setConsent(true, 1);
    const { runId } = await start(a); const ap = await cardOf(a, runId); approve(a, runId, ap);
    await waitFor(() => stateOf(a, runId) !== 'running', 3000); assert.equal(stateOf(a, runId), 'done'); assert.equal(ctl.log.killed.length, 0);
    assert.equal(recs(a, runId).find(e => e.type === 'receipt' && e.operation === 'command').result, 'done');
  });
  await t('REFUS SÛR : moteur non interruptible -> AUCUNE carte pour une commande, commande jamais exécutée, reçu « refusé » explicite ; la lecture reste possible', async () => {
    const ctl = mockCtl(); ctl.state.interruptible = false;
    fs.writeFileSync(path.join(docs, 'note.md'), 'synthétique\n');
    const fake = createFakeSdk({ script: async api => { const r = await api.use('PowerShell', { command: CMD }); const r2 = await api.use('mcp__vie__read_file', { path: path.join(docs, 'note.md') }); return `${r.allowed}/${r2.allowed}`; }, shell: async () => ({ out: 'ne doit pas tourner' }) });
    const a = mkAgent(fake, ctl); a.setConsent(true, 1);
    const { runId } = await start(a); await waitFor(() => stateOf(a, runId) !== 'running', 3000);
    assert.deepEqual(fake.calls.shell, []); assert.equal(recs(a, runId).filter(e => e.type === 'approval').length, 0);
    const rf = recs(a, runId).find(e => e.type === 'receipt' && e.result === 'refused'); assert.match(rf.detail, /non interruptible/);
    assert.equal(fake.calls.canUse.find(c => c.name === 'mcp__vie__read_file').behavior, 'allow'); assert.equal(stateOf(a, runId), 'done');
  });
  await t('SANS processus du tout (moteur qui n\'a pas utilisé spawnClaudeCodeProcess) : commande refusée par défaut (échec fermé)', async () => {
    const ctl = mockCtl(); const real = ctl.spawner; ctl.spawner = () => () => { throw new Error('jamais appelé'); };
    const fake = createFakeSdk({ script: async api => { await api.use('PowerShell', { command: CMD }); return 'fin'; }, shell: async () => ({ out: 'non' }) });
    // le faux SDK n'appelle pas le spawner si l'option est absente : on simule en retirant l'option via un contrôleur qui ne renvoie jamais de handle
    ctl.spawner = ({ onHandle, guard }) => { const f = real({ onHandle: () => {}, guard }); return f; };
    const a = mkAgent(fake, ctl); a.setConsent(true, 1);
    const { runId } = await start(a); await waitFor(() => stateOf(a, runId) !== 'running', 3000);
    assert.deepEqual(fake.calls.shell, []); assert.equal(recs(a, runId).filter(e => e.type === 'approval').length, 0);
  });
  await t('COURSE : le moteur cesse d\'être interruptible ENTRE le clic « Approuver » et la reprise -> deny + reçu « cancelled », commande jamais lancée', async () => {
    const ctl = mockCtl();
    const fake = createFakeSdk({ script: async api => { const r = await api.use('PowerShell', { command: CMD }); return String(r.allowed); }, shell: async () => ({ out: 'NON' }) });
    const a = mkAgent(fake, ctl); a.setConsent(true, 1);
    const { runId } = await start(a); const ap = await cardOf(a, runId);
    approve(a, runId, ap); ctl.state.interruptible = false;   // approuvé, puis le moteur « disparaît » avant la reprise de canUseTool (même tour synchrone)
    await waitFor(() => stateOf(a, runId) !== 'running', 3000);
    assert.deepEqual(fake.calls.shell, []); const rc = recs(a, runId).find(e => e.type === 'receipt' && e.hash === ap.hash); assert.equal(rc.result, 'cancelled'); assert.match(rc.detail, /interruptible/);
  });
  await t('COURSE : « Approuver » puis « Révoquer » dans le même tour synchrone -> la commande n\'est jamais lancée (V7 P1 #2 maintenu) et le moteur est tué', async () => {
    const ctl = mockCtl();
    const fake = createFakeSdk({ script: async api => { await api.use('PowerShell', { command: CMD }); return 'fin'; }, shell: async () => ({ out: 'NON' }) });
    const a = mkAgent(fake, ctl); a.setConsent(true, 1);
    const { runId } = await start(a); const ap = await cardOf(a, runId);
    approve(a, runId, ap); a.setConsent(false);
    await waitFor(() => stateOf(a, runId) !== 'running', 3000);
    assert.deepEqual(fake.calls.shell, []); assert.equal(ctl.log.killed.length, 1); assert.equal(stateOf(a, runId), 'cancelled');
    assert.equal(recs(a, runId).filter(e => e.type === 'receipt' && e.result === 'done').length, 0);
  });
  await t('COURSE : Révoquer puis ré-accorder (A-B-A) pendant la commande -> le moteur d\'origine reste tué, la nouvelle exécution est neuve (pas de reprise de droits)', async () => {
    const ctl = mockCtl(); const g = gate();
    const fake = createFakeSdk({ script: async api => { await api.use('PowerShell', { command: CMD }); return 'fin'; }, shell: async () => { await g.promise; return { out: 'ok' }; } });
    const a = mkAgent(fake, ctl); a.setConsent(true, 1);
    const { runId } = await start(a); const ap = await cardOf(a, runId); approve(a, runId, ap); await waitFor(() => fake.calls.shell.length === 1);
    a.setConsent(false); a.setConsent(true, 1);
    assert.equal(ctl.log.killed.length, 1); await waitFor(() => stateOf(a, runId) !== 'running', 1500); assert.equal(stateOf(a, runId), 'cancelled');
    const { runId: r2 } = await start(a); assert.notEqual(r2, runId); assert.equal(ctl.log.spawned.length, 2); assert.equal(ctl.log.killed.length, 1, 'la nouvelle exécution n\'est pas touchée'); a.cancel(r2, 's1'); g.release();
  });
  await t('COURSE : lancement refusé si la révocation précède le spawn du moteur (garde du spawner) -> aucun processus ne naît', async () => {
    const ctl = mockCtl(); const g = gate();
    const fake = createFakeSdk({ script: async () => { await g.promise; return 'x'; } });
    const real = fake.sdk.query; let spawnErr = null;
    fake.sdk.query = args => { args.options.abortController.abort('revoked'); try { args.options.spawnClaudeCodeProcess({ command: 'x', args: [], env: {}, signal: args.options.abortController.signal }); } catch (e) { spawnErr = e; } return real(args); };
    const a = mkAgent(fake, ctl); a.setConsent(true, 1);
    const { runId } = await start(a); await waitFor(() => stateOf(a, runId) !== 'running', 3000);
    assert.ok(spawnErr && /interrompue/.test(spawnErr.message)); assert.equal(ctl.log.spawned.length, 0); g.release();
  });
  await t('ÉCHEC FERMÉ : le moteur ne peut pas être arrêté -> run « error », reçu « non confirmé », unsafe=true, nouvelle exécution refusée (409 agent_unsafe), commandes jamais re-proposées', async () => {
    const ctl = mockCtl(); ctl.state.killOk = false; const g = gate();
    const fake = createFakeSdk({ script: async api => { await api.use('PowerShell', { command: CMD }); return 'fin'; }, shell: async () => { await g.promise; return { out: 'ok' }; } });
    const a = mkAgent(fake, ctl, { limits: { settleMs: 80 } }); a.setConsent(true, 1);
    const { runId } = await start(a); const ap = await cardOf(a, runId); approve(a, runId, ap); await waitFor(() => fake.calls.shell.length === 1);
    a.setConsent(false);
    await waitFor(() => stateOf(a, runId) !== 'running', 3000);
    const done = recs(a, runId).find(e => e.type === 'done'); assert.equal(done.state, 'error'); assert.match(done.note, /n’a pas pu être confirmé/);
    const rc = recs(a, runId).find(e => e.type === 'receipt' && e.operation === 'command'); assert.equal(rc.result, 'unconfirmed'); assert.match(rc.detail, /NON confirmée/);
    assert.equal((await a.status()).unsafe, true); a.setConsent(true, 1);
    await assert.rejects(() => start(a), e => e instanceof AgentError && e.status === 409 && e.code === 'agent_unsafe'); g.release();
  });
  await t('FILET : si la boucle du SDK ne se termine pas après l\'arrêt, l\'exécution est tout de même clôturée (settleMs) ; les messages tardifs sont ignorés', async () => {
    const ctl = mockCtl(); ctl.state.emitExit = false; const g = gate();
    const fake = createFakeSdk({ ignoreAbort: true, script: async api => { await api.use('PowerShell', { command: CMD }); api.say('MESSAGE-TARDIF'); return 'fin'; }, shell: async () => { await g.promise; return { out: 'ok' }; } });
    const a = mkAgent(fake, ctl, { limits: { settleMs: 120 } }); a.setConsent(true, 1);
    const { runId } = await start(a); const ap = await cardOf(a, runId); approve(a, runId, ap); await waitFor(() => fake.calls.shell.length === 1);
    const t0 = Date.now(); a.cancel(runId, 's1');
    await waitFor(() => stateOf(a, runId) !== 'running', 2000); assert.ok(Date.now() - t0 < 1500);
    assert.equal(stateOf(a, runId), 'cancelled'); const n = recs(a, runId).length; g.release(); await sleep(80);
    assert.equal(recs(a, runId).length, n, 'plus aucun événement après la clôture'); assert.ok(!recs(a, runId).some(e => e.type === 'text' && /MESSAGE-TARDIF/.test(e.text)));
    assert.equal(recs(a, runId).filter(e => e.type === 'done').length, 1);
  });
  await t('PROCESSUS NON POSSÉDÉS : seul le handle de CETTE exécution est visé ; un processus étranger du contrôleur n\'est jamais passé à killTree', async () => {
    const ctl = mockCtl(); const g = gate(); const foreign = { child: new EventEmitter(), pid: 777, exited: false }; ctl.log.spawned.push(foreign);
    const fake = createFakeSdk({ script: async api => { await api.use('PowerShell', { command: CMD }); return 'fin'; }, shell: async () => { await g.promise; return { out: 'ok' }; } });
    const a = mkAgent(fake, ctl); a.setConsent(true, 1);
    const { runId } = await start(a); const ap = await cardOf(a, runId); approve(a, runId, ap); await waitFor(() => fake.calls.shell.length === 1);
    a.setConsent(false); assert.deepEqual(ctl.log.killed, [ctl.log.spawned[1].pid]); assert.ok(!ctl.log.killed.includes(777)); g.release();
  });
  await t('write_file approuvée puis révoquée : rien n\'est écrit, aucun arrêt de processus superflu hors exécution (V7 maintenu)', async () => {
    const ctl = mockCtl(); const target = path.join(docs, 'ecrit.md');
    const fake = createFakeSdk({ script: async api => { await api.use('mcp__vie__write_file', { path: target, content: 'x' }); return 'fin'; } });
    const a = mkAgent(fake, ctl); a.setConsent(true, 1);
    const { runId } = await start(a); const ap = await cardOf(a, runId); approve(a, runId, ap); a.setConsent(false);
    await waitFor(() => stateOf(a, runId) !== 'running', 3000); assert.equal(fs.existsSync(target), false);
  });

  console.log('\nvie-policy.cjs : descendants protégés par SUITE de noms, jokers');
  if (win) {
    const pol = createPolicy({ home, cwd: home, vieRoot });
    const mk = (...p) => mkd(path.join(...p));
    const mv = d => pol.plan('mcp__vie__move_path', { from: d, to: path.join(docs, 'dest-' + path.basename(d)) });
    await t('REPRO P3 : un dossier ordinaire contenant .config\\gh est refusé (V7 : déplaçable)', () => {
      const d = mk(docs, 'sauvegarde1', 'old', '.config', 'gh'); fs.writeFileSync(path.join(d, 'hosts.yml'), 'x'); const r = mv(path.join(docs, 'sauvegarde1'));
      assert.equal(r.cls, 'deny'); assert.match(r.reason, /zone protégée.*\.config\\gh|\.config\\gh/);
    });
    await t('REPRO P3 : …contenant Chrome\\User Data (suite AppData\\Local\\Google\\Chrome\\User Data) est refusé', () => {
      mk(docs, 'sauvegarde2', 'AppData', 'Local', 'Google', 'Chrome', 'User Data'); assert.equal(mv(path.join(docs, 'sauvegarde2')).cls, 'deny');
    });
    await t('REPRO P3 : …contenant Microsoft\\Protect (DPAPI) et Microsoft\\Credentials sous AppData\\Roaming est refusé', () => {
      mk(docs, 'sauvegarde3', 'AppData', 'Roaming', 'Microsoft', 'Protect'); assert.equal(mv(path.join(docs, 'sauvegarde3')).cls, 'deny');
      mk(docs, 'sauvegarde3b', 'AppData', 'Roaming', 'Microsoft', 'Credentials'); assert.equal(mv(path.join(docs, 'sauvegarde3b')).cls, 'deny');
    });
    await t('contrôle négatif : « .config » seul, « gh » seul, « Chrome » seul, « User Data » seul dans un dossier ordinaire -> déplaçable (pas de sur-refus)', () => {
      mk(docs, 'ok1', '.config', 'autre'); mk(docs, 'ok2', 'gh'); mk(docs, 'ok3', 'Chrome', 'Profil'); mk(docs, 'ok4', 'User Data');
      for (const n of ['ok1', 'ok2', 'ok3', 'ok4']) assert.equal(mv(path.join(docs, n)).cls, 'write', n);
    });
    await t('casse et alias : « .CONFIG\\GH » / « appdata\\LOCAL\\google\\CHROME\\user data » refusés (repli de casse)', () => {
      mk(docs, 'sauvegarde4', '.CONFIG', 'GH'); assert.equal(mv(path.join(docs, 'sauvegarde4')).cls, 'deny');
      mk(docs, 'sauvegarde5', 'appdata', 'LOCAL', 'google', 'CHROME', 'user data'); assert.equal(mv(path.join(docs, 'sauvegarde5')).cls, 'deny');
    });
  } else console.log('  (sections Windows ignorées sur cette plateforme)');
  await t('jokers : un motif qui peut désigner un nom protégé (id_rs?, .s*, cred*, .g[i]t*) est REFUSÉ même avec approbation ; les motifs ordinaires restent autorisés', () => {
    const pol = createPolicy({ platform: 'win32', home: 'C:\\Users\\demo', cwd: 'C:\\Users\\demo', fs });
    const deny = ['ls id_rs?', 'ls .s*', 'Get-Content ~/id_ed2551?', 'gci cred*', 'ls [i]d_rsa', 'ls .g[i]t*', 'Get-ChildItem C:\\x\\.ss?', 'cat "$HOME\\.ssh\\id_*"', 'ls .aw?', 'Get-Item .npm*'];
    const ok = ['ls *.md', 'ls *', 'Get-ChildItem -Filter *.ps1', 'dir src/*.js', 'git status', 'echo a?b', 'Get-ChildItem -Recurse -Include *.py', 'ls Documents/Cours/*.pdf'];
    for (const c of deny) assert.ok(pol.analyzeCommand(c).hard, 'devrait être refusé : ' + c);
    for (const c of ok) assert.ok(!pol.analyzeCommand(c).hard, 'ne devrait pas être refusé : ' + c);
    const r = pol.plan('PowerShell', { command: 'ls id_rs?' }); assert.equal(r.cls, 'deny'); assert.match(r.reason, /motif générique/);
  });

  console.log('\ninterface (contrôles statiques)');
  const ui = fs.readFileSync(path.join(__dirname, 'vie-agent-ui.js'), 'utf8');
  await t('reçu « interrompue » : libellé de carte et de reçu présents (jamais « exécutée » pour une commande tuée)', () => {
    assert.match(ui, /interrupted:'approuvée puis INTERROMPUE/); assert.match(ui, /interrupted:'⏹ Interrompue'/);
  });
  await t('bandeau « Agent local inactif » : bouton Révoquer proposé (statut inconnu ou consentement connu) ; resynchronisation au focus et au retour sur l\'onglet', () => {
    assert.match(ui, /!st\|\|consented\(\)\?' <button[^']*data-ag="consent-revoke"/); assert.match(ui, /visibilitychange/); assert.match(ui, /addEventListener\('focus',resync\)/);
  });
  await t('texte de la promesse d\'interruption conservé ET maintenant tenu : « Toute exécution en cours sera interrompue »', () => { assert.match(ui, /Toute exécution en cours sera interrompue/); });

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { console.log('nettoyage partiel', e.code); }
  console.log(`\n${pass + fail} tests, ${pass} OK, ${fail} KO`); if (fail) { console.log('KO : ' + failures.join(' | ')); process.exit(1); }
})().catch(e => { console.log('ERREUR', e && e.stack || e); process.exit(2); });
