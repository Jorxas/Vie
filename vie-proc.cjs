// Contrôle des processus du moteur agent (V8). Le SDK lance le binaire Claude Code, qui lance lui-même les shells (PowerShell/Bash) des commandes approuvées.
// V7 : « Révoquer » / « Annuler » ne faisaient qu'abandonner l'AbortController côté Node ; la commande déjà partie continuait et pouvait écrire après la révocation (QA7, vrai SDK).
// Ici Vie POSSÈDE le processus du moteur (option spawnClaudeCodeProcess du SDK) et sait le terminer avec tout son arbre de descendants :
//  - Windows : `taskkill /PID <pid> /T /F` (arbre vivant du processus que Vie a lancé, pid protégé de toute réutilisation tant que le handle Node est ouvert) ;
//  - POSIX   : groupe de processus (detached) -> kill(-pid) ;
//  - jamais par nom, jamais un pid venu d'ailleurs : seul un handle créé par ce module peut être tué, et pas s'il est déjà sorti (pid potentiellement réutilisé).
// Limite connue et assumée : un descendant déjà « orphelin » (son parent est mort avant la révocation, ex. Start-Process détaché) n'est plus rattaché à l'arbre vivant et n'est PAS tué.
// Tout est injectable (spawn, spawnSync, platform) pour les tests ; rien ici n'écrit sur le disque.
'use strict';
const cp = require('node:child_process');
const nodeFs = require('node:fs');
const nodePath = require('node:path');

const sleepSync = ms => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { /* tant pis : pas d'attente */ } };

// Registre commun à tous les contrôleurs : UN seul écouteur « exit » pour le processus Node (pas un par exécution).
const LIVE = new Set(); let exitHooked = false;
function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  // Si Vie s'arrête (même brutalement côté Node, pas via SIGKILL), les moteurs encore vivants sont terminés avec leur arbre : rien ne doit survivre au serveur.
  process.on('exit', () => { for (const kill of [...LIVE]) { try { kill(); } catch (e) { /* dernier recours */ } } });
}

function createProcessControl(opts = {}) {
  const platform = opts.platform || process.platform;
  const spawn = opts.spawn || cp.spawn;
  const spawnSync = opts.spawnSync || cp.spawnSync;
  const pkill = opts.processKill || ((pid, sig) => process.kill(pid, sig));
  const killProbe = opts.isAlive || (pid => { try { pkill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } });
  const env = opts.env || process.env;
  const timeoutMs = opts.timeoutMs || 8000;
  const handles = new Set();

  // taskkill.exe par chemin absolu (jamais résolu par PATH : un dossier piégé dans PATH ne doit pas pouvoir remplacer l'outil d'arrêt).
  const taskkillPath = () => nodePath.win32.join(env.SystemRoot || env.SYSTEMROOT || env.windir || 'C:\\Windows', 'System32', 'taskkill.exe');

  const exited = h => h.exited || (h.child.exitCode !== null && h.child.exitCode !== undefined) || (h.child.signalCode !== null && h.child.signalCode !== undefined);

  // Fournit la fonction `spawnClaudeCodeProcess` du SDK pour UNE exécution. `onHandle` reçoit le handle possédé ; `guard()` peut refuser le lancement (exécution déjà interrompue).
  function spawner({ onHandle, guard }) {
    return options => {
      if (guard) guard();
      if (!options || typeof options.command !== 'string' || !options.command) throw new Error('commande de lancement du moteur absente');
      const child = spawn(options.command, options.args || [], { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: platform !== 'win32' });   // pas de `signal` : un abort ne doit JAMAIS tuer la seule racine (ses descendants deviendraient introuvables) ; l'arrêt passe par killTree
      const h = { child, pid: child.pid, exited: false, startedAt: Date.now(), killed: null };
      // La sortie d'erreur du moteur n'est pas relayée (elle peut contenir des chemins ou des extraits) : on la vide seulement, sinon le tube se remplit et bloque le moteur.
      if (child.stderr) child.stderr.on('data', () => {});
      child.once('exit', () => { h.exited = true; handles.delete(h); if (h.unregister) h.unregister(); });
      child.once('error', () => { h.exited = true; handles.delete(h); if (h.unregister) h.unregister(); });
      handles.add(h);
      if (!opts.noExitHook) { const kill = () => killTree(h); h.unregister = () => LIVE.delete(kill); LIVE.add(kill); hookExit(); }
      if (onHandle) onHandle(h);
      return child;
    };
  }
  // Vrai si le processus du moteur est encore possédé ET vivant : seule condition sous laquelle une commande approuvée est interruptible.
  function interruptible(h) {
    if (!h || !h.child || !Number.isInteger(h.pid) || h.pid <= 4 || exited(h)) return false;
    if (platform === 'win32') { try { return nodeFs.existsSync(taskkillPath()); } catch (e) { return false; } }
    return true;
  }

  // Termine le processus du moteur et tout son arbre. Renvoie { ok, method, alreadyExited, ms, detail } ; ok = le processus racine n'existe plus (arbre terminé avec lui).
  function killTree(h) {
    const t0 = Date.now();
    if (!h || !h.child || !Number.isInteger(h.pid)) return { ok: false, method: 'none', alreadyExited: false, ms: 0, detail: 'processus non possédé' };
    if (exited(h)) return { ok: true, method: 'none', alreadyExited: true, ms: 0, detail: 'déjà terminé' };
    let method = 'none', detail = '';
    try {
      if (platform === 'win32') {
        method = 'taskkill';
        const r = spawnSync(taskkillPath(), ['/PID', String(h.pid), '/T', '/F'], { windowsHide: true, timeout: timeoutMs, encoding: 'utf8' });
        detail = r.error ? `taskkill : ${r.error.code || 'erreur'}` : `taskkill code ${r.status}`;
      } else {
        method = 'process-group';
        try { pkill(-h.pid, 'SIGKILL'); } catch (e) { detail = `groupe : ${e.code || 'erreur'}`; }
      }
    } catch (e) { detail = `${method} : ${e && e.code || 'erreur'}`; }
    // Repli : terminer au moins le processus racine (TerminateProcess / SIGKILL). Sans l'arbre, mais jamais rien.
    if (killProbe(h.pid) && !exited(h)) { try { h.child.kill('SIGKILL'); } catch (e) { /* déjà parti */ } }
    for (let i = 0; i < 40 && killProbe(h.pid) && !exited(h); i++) sleepSync(25);
    const dead = exited(h) || !killProbe(h.pid);
    h.killed = dead;
    return { ok: dead, method, alreadyExited: false, ms: Date.now() - t0, detail: dead ? detail : `${detail} ; processus encore vivant`.trim() };
  }
  return { spawner, killTree, interruptible, liveCount: () => handles.size, _handles: handles };
}

module.exports = { createProcessControl };
