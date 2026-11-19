// Politique du mode Agent « Ordinateur » : canonicalisation des chemins Windows, zones protégées, analyse des commandes, empreinte des appels d'outils.
// Module PUR : aucun effet de bord (lecture du système de fichiers seulement, par un `fs` injectable). Il ne décide jamais d'autoriser une écriture ou une commande :
// il classe l'appel (lecture / écriture / commande / refus dur) ; seule une approbation explicite de l'utilisateur, côté interface, peut autoriser les deux dernières classes.
// Les listes de refus sont une DÉFENSE EN PROFONDEUR heuristique, pas une garantie : le vrai rempart d'une commande est la carte d'approbation qui en montre le texte exact.
'use strict';
const nodePath = require('node:path');
const crypto = require('node:crypto');

class PolicyError extends Error { constructor(code, message) { super(message || code); this.code = code; } }

// Outils exposés au modèle : les outils « vie » (serveur MCP en processus, implémentés dans vie-tools.cjs) et deux shells du SDK. Rien d'autre n'est jamais autorisé.
const MCP_PREFIX = 'mcp__vie__';
const READ_TOOLS = ['list_roots', 'list_dir', 'read_file', 'read_pdf', 'glob_files', 'grep_files'];
const WRITE_TOOLS = ['write_file', 'edit_file', 'move_path', 'delete_file'];
const SHELL_TOOLS = ['PowerShell', 'Bash'];
const bare = name => (typeof name === 'string' && name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name);

// Premier caractère invisible / ambigu d'un texte (même esprit que la politique de vie-dev.cjs) ; null si le texte est entièrement lisible. Espace, tabulation, LF et CRLF sont admis.
function hiddenChar(t) {
  const re = /[\p{Cf}\p{Cc}\p{Cn}\p{Co}\p{Cs}\p{Zl}\p{Zp}\p{Zs}\p{Default_Ignorable_Code_Point}\u2800\uFFFC\uFFFD]/gu;
  const s = t.replace(/\r\n/g, '\n');
  let m; while ((m = re.exec(s))) { const ch = m[0]; if (ch === ' ' || ch === '\t' || ch === '\n') continue; return 'U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'); }
  return null;
}
const LIM = { moveDepth: 10, moveEntries: 20000, path: 1024, content: 20000, edit: 20000, command: 4000, pattern: 200, desc: 300, timeoutMs: 120000, readBytes: 25 * 1024 * 1024, editFile: 5 * 1024 * 1024 };

// Comparaison de noms de fichiers « à la Windows » : NFKC (formes pleine chasse, ligatures), puis majuscules puis minuscules (NTFS compare avec une table de majuscules :
// « ı » sans point = « I », « ſ » = « S », signe Kelvin = « k »). Sur-correspondance voulue : un nom qui SERAIT équivalent pour le système est traité comme le nom protégé.
const fold = s => String(s).normalize('NFKC').toUpperCase().toLowerCase();
// Caractères invisibles / ambigus rendus VISIBLES (⟦U+202E⟧) dans l'ancien contenu d'un fichier montré sur une carte : on ne les cache jamais, on ne les nettoie pas.
const HIDDEN_RE = new RegExp('[\\p{Cf}\\p{Cc}\\p{Cn}\\p{Co}\\p{Cs}\\p{Zl}\\p{Zp}\\p{Zs}\\p{Default_Ignorable_Code_Point}' + String.fromCodePoint(0x2800, 0xFFFC, 0xFFFD) + ']', 'gu');
function visible(text) {
  return text.replace(/\r\n/g, '\n').replace(HIDDEN_RE, ch => (ch === ' ' || ch === '\t' || ch === '\n' ? ch : '⟦U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0') + '⟧'));
}
// Différence ligne à ligne COMPLÈTE de la zone modifiée : préfixe et suffixe de lignes identiques résumés (nombre indiqué), 3 lignes de contexte, puis TOUTES les lignes
// retirées (« - ») et TOUTES les lignes ajoutées (« + ») entre les deux. Aucune ligne modifiée n'est jamais omise ni raccourcie.
function lineDiff(oldText, newText) {
  const a = oldText.split('\n'), b = newText.split('\n');
  let p = 0; while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0; while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const out = [], ctx = 3;
  const head = Math.max(0, p - ctx), tail = Math.min(s, ctx);
  if (head > 0) out.push(`@@ ${head} ligne(s) identique(s) avant @@`);
  for (let i = head; i < p; i++) out.push('  ' + a[i]);
  for (let i = p; i < a.length - s; i++) out.push('- ' + a[i]);
  for (let i = p; i < b.length - s; i++) out.push('+ ' + b[i]);
  for (let i = a.length - s; i < a.length - s + tail; i++) out.push('  ' + a[i]);
  if (s - tail > 0) out.push(`@@ ${s - tail} ligne(s) identique(s) après @@`);
  const changed = (a.length - s - p) + (b.length - s - p);
  return { text: out.join('\n'), changed };
}

// --- Persistance / démarrage automatique (écriture, déplacement et suppression REFUSÉS, même avec approbation) -----------------------------------------------
// Un fichier de ce genre s'exécute plus tard sans que l'utilisateur ait cliqué sur quoi que ce soit (ouverture de PowerShell, d'un dossier dans VS Code, `git commit`, un nom de commande
// du PATH, ouverture de session). Une carte d'approbation ne suffit pas : le contenu d'un tel fichier n'est pas relu au moment où il s'exécute. Les noms sont comparés avec `fold`
// (casse, plein chasse, ligatures, « / » et « \ » confondus) et le contrôle porte sur le chemin SAISI et sur le chemin RÉEL (une jonction `.vscode` -> autre dossier ne contourne rien).
const PERSIST_DIRS = new Set(['.vscode', '.vscode-server', '.vscode-insiders', '.cursor', '.devcontainer', '.husky', '.githooks', '.git-hooks', '.lefthook', 'windowspowershell', 'start menu', 'xlstart', '.npm-global']);
const PERSIST_SEQ = [
  ['powershell', 'modules'], ['.config', 'powershell'], ['.config', 'fish'], ['.config', 'git'],
  ['appdata', 'roaming', 'npm'], ['appdata', 'roaming', 'nvm'], ['appdata', 'local', 'pnpm'], ['appdata', 'local', 'yarn', 'bin'], ['appdata', 'local', 'microsoft', 'windowsapps'],
  ['appdata', 'roaming', 'code'], ['appdata', 'roaming', 'code - insiders'], ['appdata', 'roaming', 'cursor'],
  ['appdata', 'roaming', 'microsoft', 'templates'], ['appdata', 'roaming', 'microsoft', 'word', 'startup'], ['appdata', 'roaming', 'microsoft', 'excel'],
  ['scoop', 'shims'], ['.cargo', 'bin'], ['.local', 'bin'], ['.dotnet', 'tools'],
];
const PERSIST_FILES = [
  /(^|[_.-])profile\.ps1$/,                                   // profile.ps1, Microsoft.PowerShell_profile.ps1, Microsoft.VSCode_profile.ps1, AllUsersAllHosts…
  /\.code-workspace$/, /^\.huskyrc/, /^\.pre-commit-config\.ya?ml$/, /^\.?lefthook(-local)?(\.|$)/, /^\.lintstagedrc/, /^lint-staged\.config\./, /^\.pnpmfile\.cjs$/, /^\.yarnrc/,
  /^(\.zshenv|\.zlogin|\.zlogout|\.bash_login|\.bash_logout|\.xinitrc|\.xprofile|\.xsessionrc|\.profile|\.bashrc|\.bash_profile|\.zshrc|\.zprofile|\.gitconfig)$/,
  /^(sitecustomize|usercustomize)\.py$/, /\.pth$/, /\.(lnk|url|scr|pif)$/, /^microsoft\.windowsterminal/,
];
function persistenceReason(p) {
  const norm = fold(p).replace(/[\\/]+/g, '/');
  const c = norm.split('/').filter(Boolean);
  const name = c[c.length - 1] || '';
  for (const d of c) if (PERSIST_DIRS.has(d)) return `zone de démarrage automatique ou de hooks (« ${d} »)`;
  for (const seq of PERSIST_SEQ) for (let i = 0; i + seq.length <= c.length; i++) if (seq.every((s, k) => c[i + k] === s)) return `zone de démarrage automatique, de PATH ou de modèles (${seq.join('/')})`;
  for (const re of PERSIST_FILES) if (re.test(name)) return `fichier exécuté automatiquement (« ${name} » : profil de shell, tâche d’éditeur, hook ou raccourci)`;
  if (c.some(x => x.startsWith('microsoft.windowsterminal'))) return 'configuration de Windows Terminal (commande de démarrage)';
  return null;
}
// Schéma FERMÉ des entrées : [type, obligatoire, min, max]. Toute clé inconnue ou valeur hors bornes est un refus (échec fermé).
const SPECS = {
  list_roots: {},
  list_dir: { path: ['path', 1], max: ['int', 0, 1, 300] },
  read_file: { path: ['path', 1], offset: ['int', 0, 1, 10000000], limit: ['int', 0, 1, 2000] },
  read_pdf: { path: ['path', 1], first_page: ['int', 0, 1, 99999], last_page: ['int', 0, 1, 99999] },
  glob_files: { pattern: ['str', 1, 1, LIM.pattern], path: ['path', 0], max: ['int', 0, 1, 500] },
  grep_files: { pattern: ['str', 1, 1, LIM.pattern], path: ['path', 0], glob: ['str', 0, 1, LIM.pattern], regex: ['bool', 0], ignore_case: ['bool', 0], max: ['int', 0, 1, 200] },
  write_file: { path: ['path', 1], content: ['str', 1, 0, LIM.content], overwrite: ['bool', 0] },
  edit_file: { path: ['path', 1], old_string: ['str', 1, 1, LIM.edit], new_string: ['str', 1, 0, LIM.edit], replace_all: ['bool', 0] },
  move_path: { from: ['path', 1], to: ['path', 1] },
  delete_file: { path: ['path', 1] },
  shell: { command: ['str', 1, 1, LIM.command], description: ['str', 0, 0, LIM.desc], timeout: ['int', 0, 1, LIM.timeoutMs], run_in_background: ['bool', 0], dangerouslyDisableSandbox: ['bool', 0] },
};

// --- Zones protégées (lecture ET écriture refusées, même avec approbation) -------------------------------------------------
const DENY_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.azure', '.kube', '.docker', '.git', '.claude', '.claude-code-bridge', '.gcloud', '.minikube', '.password-store', '$recycle.bin', 'system volume information']);
const DENY_SEQ = [
  ['.config', 'gh'], ['.config', 'gcloud'], ['.config', 'git', 'credentials'],
  ['appdata', 'roaming', 'microsoft', 'credentials'], ['appdata', 'local', 'microsoft', 'credentials'], ['appdata', 'roaming', 'microsoft', 'protect'],
  ['appdata', 'roaming', 'microsoft', 'vault'], ['appdata', 'local', 'microsoft', 'vault'],
  ['appdata', 'local', 'google', 'chrome', 'user data'], ['appdata', 'local', 'microsoft', 'edge', 'user data'], ['appdata', 'local', 'bravesoftware'],
  ['appdata', 'roaming', 'mozilla'], ['appdata', 'roaming', 'opera software'], ['appdata', 'roaming', 'discord'], ['appdata', 'roaming', '1password'], ['appdata', 'roaming', 'bitwarden'],
  ['windows', 'system32', 'config'],
];
const DENY_FILES = [
  [/^\.env/i, /^\.env\.(example|sample|template|dist)$/i], // .env et toutes ses variantes (.env.local, .env~, .env-old, « .env - Copie »…) sauf les modèles
  [/^(\.gitconfig|\.bashrc|\.bash_profile|\.profile|\.zshrc|\.zprofile|\.inputrc|.*\.rdp|.*\.tfstate|.*\.kubeconfig|kubeconfig)$/i], // fichiers qui exécutent des programmes ou donnent accès à des machines
  [/^(\.npmrc|\.pypirc|\.netrc|_netrc|\.git-credentials|\.pgpass|\.my\.cnf|\.dockercfg|\.htpasswd|\.vault-token)$/],
  [/^id_(rsa|dsa|ecdsa|ed25519)/],
  [/\.(pem|key|pfx|p12|ppk|kdbx|kdb|keystore|jks|asc|gpg|wallet)$/],
  [/^(credentials|secrets?)(\.(json|ya?ml|toml|ini|txt))?$/, null],
  [/^\.?credentials\.json$/], [/^client_secret.*\.json$/], [/service[-_]?account.*\.json$/],
  [/^(login data|cookies|web data|local state|network persistent state|ntuser\.dat.*|wallet\.dat)$/],
  [/^(pagefile|hiberfil|swapfile)\.sys$/],
  [/^(consolehost_history\.txt|\.bash_history|\.zsh_history|\.python_history|\.node_repl_history|\.psql_history|\.mysql_history)$/],
];

function createPolicy(opts = {}) {
  const platform = opts.platform || process.platform;
  const win = platform === 'win32';
  const P = win ? nodePath.win32 : nodePath.posix;
  const fs = opts.fs || require('node:fs');
  const home = P.resolve(opts.home || require('node:os').homedir());
  const cwd = P.resolve(opts.cwd || home);
  const vieRoot = opts.vieRoot ? realpathSafe(P.resolve(opts.vieRoot)) : null;
  const norm = s => (win ? fold(s) : s);
  const comps = real => norm(real).split(/[\\/]+/).filter(Boolean);

  function realpathSafe(abs) { try { return (fs.realpathSync.native || fs.realpathSync)(abs); } catch (e) { return abs; } }
  function realpathBest(abs) {
    const rp = fs.realpathSync.native || fs.realpathSync;
    try { return rp(abs); } catch (e) {
      // Cible inexistante (création) : on résout le plus proche ancêtre existant, puis on rajoute le reste (déjà normalisé, sans « .. »).
      const rest = [];
      let cur = abs;
      for (let i = 0; i < 64; i++) {
        const parent = P.dirname(cur);
        rest.unshift(P.basename(cur));
        if (parent === cur) throw new PolicyError('path_unresolvable', 'chemin irrésolvable');
        cur = parent;
        try { return P.join(rp(cur), ...rest); } catch (e2) { /* on remonte */ }
      }
      throw new PolicyError('path_unresolvable', 'chemin irrésolvable');
    }
  }
  // Chemin utilisateur -> chemin réel absolu. Refuse : préfixes de périphérique (\\?\, \\.\), UNC et lecteurs réseau, flux de données alternatifs (::$DATA), noms réservés,
  // points ou espaces finaux. Résout jonctions, liens symboliques et noms courts 8.3 (realpath natif) AVANT toute décision.
  // canonPair : { abs, real } — `abs` = chemin saisi résolu LEXICALEMENT (« .. », « . », barres), `real` = chemin réel après liens. Les écritures contrôlent les DEUX.
  function canonPair(input, base) {
    if (typeof input !== 'string' || !input.trim() || input.length > LIM.path || input.includes('\0')) throw new PolicyError('path_invalid', 'chemin invalide');
    let p = input.trim();
    if (p === '~' || /^~[\\/]/.test(p)) p = P.join(home, p.slice(1));
    if (win) {
      if (/^[\\/]{2}[?.][\\/]/.test(p)) throw new PolicyError('path_device', 'chemins de périphérique (\\\\?\\, \\\\.\\) refusés');
      if (/^[\\/]{2}/.test(p)) throw new PolicyError('path_unc', 'chemins réseau (UNC) refusés par défaut');
      const noDrive = p.replace(/^[A-Za-z]:/, '');
      if (noDrive.includes(':')) throw new PolicyError('path_ads', 'flux de données alternatif ou « : » interdit');
      if (/[<>"|?*]/.test(p)) throw new PolicyError('path_chars', 'caractères interdits dans un chemin Windows');
      for (const c of p.split(/[\\/]+/)) {
        if (!c || /^[A-Za-z]:$/.test(c) || c === '.' || c === '..') continue;
        if (/[. ]$/.test(c)) throw new PolicyError('path_trailing', 'composant se terminant par un point ou une espace (ambigu sous Windows)');
        if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(c)) throw new PolicyError('path_reserved', 'nom de périphérique réservé');
      }
    }
    const abs = P.resolve(base || cwd, p);
    const real = realpathBest(abs);
    if (win && /^[\\/]{2}/.test(real)) throw new PolicyError('path_unc', 'chemins réseau (UNC) refusés par défaut');
    return { abs, real };
  }
  const canon = (input, base) => canonPair(input, base).real;
  function protectedName(name) {
    const n = norm(name);
    if (DENY_DIRS.has(n)) return `dossier protégé « ${name} »`;
    for (const [re, except] of DENY_FILES) if (re.test(n) && !(except && except.test(n))) return `fichier protégé « ${name} » (secret, clé ou identifiant)`;
    return null;
  }
  // Raison de protection d'un chemin RÉEL (null = non protégé). Appelée aussi sur chaque entrée rencontrée pendant un parcours.
  function protectedReason(real) {
    const c = comps(real);
    for (const part of c) { const r = protectedName(part); if (r) return r; }
    for (const seq of DENY_SEQ) {
      for (let i = 0; i + seq.length <= c.length; i++) if (seq.every((s, k) => c[i + k] === s)) return `zone protégée (${seq.join('\\')})`;
    }
    return null;
  }
  const inside = (real, dir) => { if (!dir) return false; const a = norm(real), b = norm(dir); return a === b || a.startsWith(b.endsWith(P.sep) ? b : b + P.sep); };
  // Déplacer ou renommer un DOSSIER déplace tout ce qu'il contient. Un chemin qui CONTIENT (ou est) une zone protégée ne peut donc pas être déplacé non plus : le dossier de Vie, le dossier
  // utilisateur et les zones protégées/de démarrage ancrées dans le dossier utilisateur (AppData\Roaming\Microsoft\Credentials, .config\gh…). Comparaison sur chemins RÉELS normalisés
  // (realpath natif : jonctions, liens, noms 8.3 ; casse et pleine chasse repliées par `norm`) ; appelée sur le chemin réel ET sur le chemin saisi.
  const homeReal = realpathSafe(home);
  const ANCHORED = [...DENY_SEQ, ...PERSIST_SEQ].filter(seq => seq[0] !== 'windows').map(seq => seq.reduce((acc, s) => P.join(acc, s), homeReal));
  function ancestorReason(p) {
    if (vieRoot && inside(vieRoot, p)) return 'ce chemin contient le dossier de Vie : le déplacer déplacerait aussi son code, sa politique et son .env';
    if (inside(home, p) || inside(homeReal, p)) return 'ce chemin contient (ou est) ton dossier utilisateur : le déplacer déplacerait aussi des zones protégées';
    for (const z of ANCHORED) if (inside(z, p)) return `ce chemin contient une zone protégée (${P.relative(homeReal, z) || z}) : la déplacer avec son parent est refusé`;
    return null;
  }
  // V7 (P2) — DESCENDANTS PROTÉGÉS. Déplacer un dossier déplace aussi tout ce qu'il contient : un dossier ORDINAIRE qui contient un .git, un .env, un .ssh, une clé… emporterait une zone
  // annoncée comme protégée (V6 : permis après approbation). RÈGLE EXPLICITE : un dossier dont l'arborescence contient un élément protégé (mêmes noms que pour la lecture : protectedName)
  // n'est jamais déplacé par l'agent ; l'utilisateur le déplace lui-même. Inspection BORNÉE (moveDepth niveaux, moveEntries éléments) et FAIL-CLOSED : si l'inspection ne peut pas être
  // menée jusqu'au bout (trop profond, trop d'éléments, dossier illisible, lien cassé), le déplacement est REFUSÉ — « rien trouvé » ne vaut jamais « permis » quand on n'a pas tout vu.
  // Les liens (jonctions, liens symboliques) ne sont pas suivis (seul le lien serait déplacé) mais leur nom est contrôlé, et un lien dont la CIBLE est protégée ou introuvable est refusé.
  // Appelée sur le chemin RÉEL, au plan ET de nouveau juste avant le déplacement (vie-tools.cjs) : la fenêtre qui reste est celle de l'appel système lui-même.
  const SCAN = { depth: Math.max(1, Math.floor(Number(opts.moveScan && opts.moveScan.depth) || LIM.moveDepth)), entries: Math.max(1, Math.floor(Number(opts.moveScan && opts.moveScan.entries) || LIM.moveEntries)) };
  function descendantReason(real) {
    const incomplete = why => `inspection incomplète (${why}) : par prudence, ce dossier n'est pas déplacé par Vie (déplace-le toi-même dans l'Explorateur)`;
    let top; try { top = fs.lstatSync(real); } catch (e) { return e && e.code === 'ENOENT' ? null : incomplete('chemin illisible'); }
    if (!top.isDirectory()) return null;
    const rp = fs.realpathSync.native || fs.realpathSync;
    // V8 : le contrôle ne portait que sur le NOM de chaque élément ; une zone protégée définie par une SUITE de noms (.config\gh, Chrome\User Data, Microsoft\Protect…) était déplaçable
    // dans un dossier ordinaire. On garde donc la piste des composants (normalisés) et on teste chaque suite protégée à la fin de la piste de CHAQUE élément rencontré.
    const seqByLast = new Map(); for (const seq of DENY_SEQ) { const k = seq[seq.length - 1]; (seqByLast.get(k) || seqByLast.set(k, []).get(k)).push(seq); }
    const seqHit = trail => { for (const seq of seqByLast.get(trail[trail.length - 1]) || []) { if (seq.length > trail.length) continue; let ok = true; for (let i = 0; i < seq.length; i++) if (trail[trail.length - seq.length + i] !== seq[i]) { ok = false; break; } if (ok) return seq; } return null; };
    const stack = [{ dir: real, depth: 0, trail: comps(real) }]; let seen = 0;
    while (stack.length) {
      const { dir, depth, trail } = stack.pop();
      let list; try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return incomplete('un sous-dossier est illisible'); }
      for (const ent of list) {
        if (++seen > SCAN.entries) return incomplete(`plus de ${SCAN.entries} éléments`);
        const child = P.join(dir, ent.name), rel = visible(P.relative(real, child));
        const nm = protectedName(ent.name);
        if (nm) return `ce dossier contient une zone protégée (« ${rel} » : ${nm}) : le déplacer l'emporterait`;
        const childTrail = trail.concat(norm(ent.name)); const sh = seqHit(childTrail);
        if (sh) return `ce dossier contient une zone protégée (« ${rel} » : ${sh.join('\\')}) : le déplacer l'emporterait`;
        if (ent.isSymbolicLink()) {
          let tgt; try { tgt = rp(child); } catch (e) { return incomplete(`le lien « ${rel} » est cassé ou illisible`); }
          const pr = protectedReason(tgt); if (pr) return `ce dossier contient un lien (« ${rel} ») vers une zone protégée (${pr})`;
        } else if (ent.isDirectory()) {
          if (depth + 1 >= SCAN.depth) return incomplete(`plus de ${SCAN.depth} niveaux de profondeur`);
          stack.push({ dir: child, depth: depth + 1, trail: childTrail });
        }
      }
    }
    return null;
  }
  function writeDenied(real, typed) {
    const pr = protectedReason(real);
    if (pr) return pr;
    // Persistance : contrôlée sur le chemin réel ET sur le chemin saisi (une jonction / un lien nommé autrement ne doit pas faire disparaître « .vscode » ou « .husky »).
    for (const p of typed && typed !== real ? [real, typed] : [real]) { const ps = persistenceReason(p); if (ps) return ps; }
    if (vieRoot && inside(real, vieRoot)) return 'le dossier de Vie lui-même n’est jamais modifié par l’agent (code, politique, .env)';
    const c = comps(real);
    if (c.length <= 1) return 'racine de lecteur';
    if (win && c.length === 2 && c[0] === String((opts.systemDrive || process.env.SystemDrive || 'C:')).toLowerCase()) return 'racine du lecteur système';
    if (win) {
      if (['windows', 'program files', 'program files (x86)', 'programdata', 'recovery', 'boot'].includes(c[1])) return `dossier système (${c[1]}) : l’agent n’a pas de droits administrateur et ne modifie pas le système`;
      const j = c.join('\\');
      if (j.includes('start menu\\programs\\startup')) return 'dossier de démarrage automatique';
    }
    return null;
  }

  // --- Commandes (shell) --------------------------------------------------------------------------------------------------------------
  const HARD = [
    [/(^|[\\/\s'"`=:(])\.env(\.(?!example|sample|template|dist)[\w.-]+)?($|[\s'"`;|&)])/i, 'cite un fichier .env (secret)'],
    [/(^|[\\/\s=:(])(\*\.env|\.e[*?\[][\w*?\[\]]*|\.en[*?\[][\w*?\[\]]*)($|[\s;|&)])/i, 'vise un fichier .env par un motif générique'],
    [/\.ssh\b|\bid_(rsa|dsa|ecdsa|ed25519)\b|\.aws\b|\.gnupg\b|\.npmrc\b|\.pypirc\b|\.netrc\b|\.git-credentials|\.claude\b|\.claude-code-bridge/i, 'cite une clé, un identifiant ou un dossier de jetons'],
    [/anthropic_api_key|api[_-]?key\s*[:=]|\bbearer\s+[a-z0-9._-]{16,}|\bsk-ant-/i, 'cite ou cherche une clé d’API'],
    [/login data|\\cookies\b|ntuser\.dat|\\config\\sam\b|consolehost_history|\bcmdkey\b|\bvaultcmd\b|\bmimikatz\b|\blsass\b|\bprocdump\b|\breg\s+save\b|\\credentials\\|appdata\\[a-z]+\\(google\\chrome|microsoft\\edge|mozilla)/i, 'vise un magasin d’identifiants ou un profil de navigateur'],
    [/\b(gci|get-childitem|ls|dir)\s+(-path\s+)?env:|\bprintenv\b|(^|[\r\n;&|])\s*(set|env)\s*($|[\r\n;&|])|\bcmd(\.exe)?\s+\/[ck]\s+set\b|\bgetenvironmentvariable|\bget-item\s+env:|\$env:\s*\w*(api|key|token|secret|pass)/i, 'liste les variables d’environnement (peuvent contenir des secrets)'],
    [/\bformat-volume\b|\bformat\s+[a-z]:|\bdiskpart\b|\bbcdedit\b|\bcipher\s+\/w\b|\bvssadmin\s+delete\b|\bwbadmin\s+delete\b|\bclear-disk\b|\bremove-partition\b|\bset-disk\b/i, 'commande destructrice de disque ou de sauvegarde'],
    [/\breg(\.exe)?\s+(delete|add|import|load)\b|\bnew-itemproperty\b[\s\S]*\\run\b|\bset-itemproperty\b[\s\S]*(\\run\b|hklm|hkcr)|\bhk(lm|cr):/i, 'modifie le registre système'],
    [/\b(takeown|icacls|cacls)\b|\bnet\s+(user|localgroup)\b|\bset-executionpolicy\b|\bsc(\.exe)?\s+(delete|config|create)\b|\bschtasks\s+\/create\b|\bnew-service\b|\bregister-scheduledtask\b|\b(add|set)-mppreference\b|\bdisable-windowsoptionalfeature\b|\bnetsh\s+(advfirewall|firewall)\b/i, 'change des droits, services, tâches planifiées ou protections du système'],
    [/-verb\s+runas|\brunas\b|\bsudo\b|\bgsudo\b/i, 'élévation de privilèges (Vie n’a pas de droits administrateur)'],
    [/\b(shutdown|restart-computer|stop-computer|logoff)\b/i, 'arrêt ou redémarrage de la machine'],
    // Persistance (profils PowerShell, tâches / paramètres VS Code, hooks Git et Husky, shims npm du PATH, dossier de démarrage) : même zones que les écritures de fichiers refusées par `persistenceReason`.
    [/\$profile\b|\$pshome\b|\bprofile\.ps1\b|_profile\.ps1|\bwindowspowershell\b|[\\/]powershell[\\/]+modules|\.vscode|\.code-workspace\b|\.devcontainer\b|\.husky\b|\.githooks\b|\.git-hooks\b|\.git[\\/]+hooks|\bcore\.hookspath\b|\bpre-commit-config\b|\blefthook\b|appdata%?[\\/]+(roaming[\\/]+)?(npm|nvm)\b|\bstart menu\b|\bshell:startup\b|[\\/]startup[\\/]|\.zshenv\b|sitecustomize|usercustomize|\bxlstart\b|windowsterminal/i, 'vise un profil de shell, un hook, une tâche d’éditeur, un dossier du PATH ou un dossier de démarrage (persistance)'],
    [/-encodedcommand\b|\s-enc\s|\s-e\s+[a-z0-9+/=]{20,}|frombase64string|\binvoke-expression\b|\biex\b|\bdownloadstring\b|\bdownloadfile\b|\badd-type\b[\s\S]*dllimport|\[reflection\.assembly\]::load/i, 'commande obfusquée ou exécution de code téléchargé'],
  ];
  // Suppression récursive visant une racine (lecteur, dossier utilisateur) : verbe de suppression + drapeau récursif + cible racine, dans cet ordre quelconque.
  const DEL_VERB = /\b(remove-item|ri|rm|rmdir|rd|del|erase)\b/i;
  const REC_FLAG = /(-recurse\b|\s-r\b|\s\/s\b|\s-rf\b|\s-fr\b)/i;
  const ROOT_TARGET = /(?:^|[\s'"=])(?:[a-z]:[\\/]?\*?|~[\\/]?\*?|\$home[\\/]?\*?|\$env:userprofile[\\/]?\*?|%userprofile%[\\/]?\*?|%homepath%[\\/]?\*?|[\\/]\*?)(?=$|[\s'"])/i;
  const NETWORK = /\b(curl|wget|invoke-webrequest|iwr|invoke-restmethod|irm|start-bitstransfer|bitsadmin|certutil|scp|sftp|ssh|ftp|telnet|ncat|netcat|nc|nslookup|resolve-dnsname|test-netconnection|ping|tracert|mailto|send-mailmessage)\b|\bgit\s+(push|pull|fetch|clone|remote|submodule|ls-remote)\b|\bnet\.webclient\b|\btcpclient\b|\bsystem\.net\.|https?:\/\/|ftp:\/\/|\\\\[\w.-]+\\/i;
  const INSTALL = /\b(npm|pnpm|yarn|pip3?|pipx|cargo|gem|go)\s+(install|i|add|ci|get|update|upgrade)\b|\b(winget|choco|scoop|msiexec)\b|\bnpx\b|\binstall-(module|package|script)\b|\bsetup\.exe\b/i;
  // V8 : un joker (*, ?, [..]) dans un nom de fichier ou de dossier qui peut désigner un nom protégé (id_rs?, .s*, cred*…) atteignait la carte d'approbation alors qu'un nom littéral est refusé.
  // Chaque jeton à joker (au moins 2 caractères littéraux, pour ne pas bloquer « * » ou « *.md ») est converti en expression régulière et comparé aux noms protégés connus.
  const WILD_NAMES = ['.ssh', '.aws', '.gnupg', '.azure', '.kube', '.docker', '.git', '.claude', '.claude-code-bridge', '.gcloud', '.minikube', '.password-store', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', '.npmrc', '.pypirc', '.netrc', '.git-credentials', '.pgpass', '.gitconfig', '.bashrc', '.bash_history', '.env', '.env.local', 'credentials', 'credentials.json', 'secrets', 'secrets.json', 'login data', 'cookies', 'web data', 'local state', 'ntuser.dat', 'consolehost_history.txt'];
  function wildcardHit(cmd) {
    for (const raw of cmd.split(/[\s'"`;|&()=,<>{}\\/]+/)) {
      if (!/[*?\[]/.test(raw) || raw.startsWith('-') || raw.startsWith('$')) continue;
      if (raw.replace(/[*?\[\]]/g, '').length < 2) continue;
      let re; try { re = new RegExp('^' + raw.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i'); } catch (e) { continue; }
      if (WILD_NAMES.some(n => re.test(n))) return raw.slice(0, 40);
    }
    return null;
  }
  function analyzeCommand(cmd) {
    const lines = cmd.split(/\r?\n/);
    if (lines.length > 25) return { hard: 'plus de 25 lignes : découpe la commande' };
    // Les filtres durs sont testés sur la commande telle quelle ET sur une forme normalisée (guillemets, « + », accents graves, ::$DATA, points/espaces finaux retirés) : un contournement par fragmentation est un refus.
    const flat = cmd.replace(/::\$data/ig, '').replace(/['"`]/g, '').replace(/\s*\+\s*/g, '').replace(/[. ]+(?=$|[\s;|&)])/gm, '');
    for (const [re, why] of HARD) if (re.test(cmd) || re.test(flat)) return { hard: why };
    const wild = wildcardHit(cmd) || wildcardHit(flat); if (wild) return { hard: `vise un nom protégé par un motif générique (« ${wild} » correspond à un secret, une clé ou un dossier de jetons)` };
    if (DEL_VERB.test(cmd) && REC_FLAG.test(cmd) && ROOT_TARGET.test(cmd)) return { hard: 'suppression récursive d’une racine, du dossier utilisateur ou d’un lecteur' };
    return { network: NETWORK.test(cmd), install: INSTALL.test(cmd) };
  }

  // --- Validation d'entrée + plan d'un appel d'outil -------------------------------------------------------------------------------------
  function validateInput(specName, input) {
    const spec = SPECS[specName];
    if (!spec) throw new PolicyError('unknown_tool', 'outil inconnu');
    if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new PolicyError('bad_input', 'entrée d’outil invalide');
    for (const k of Object.keys(input)) if (!Object.prototype.hasOwnProperty.call(spec, k)) throw new PolicyError('bad_input', `paramètre inconnu « ${String(k).slice(0, 30)} »`);
    const out = {};
    for (const [k, [type, req, min, max]] of Object.entries(spec)) {
      const v = input[k];
      if (v === undefined || v === null) { if (req) throw new PolicyError('bad_input', `« ${k} » obligatoire`); continue; }
      if ((type === 'path' || type === 'str') && typeof v === 'string') { const hc = hiddenChar(v); if (hc) throw new PolicyError('hidden_char', `« ${k} » contient un caractère invisible ou ambigu (${hc}) : refusé, la carte d’approbation ne peut pas le montrer`); }
      if (type === 'path') { if (typeof v !== 'string') throw new PolicyError('bad_input', `« ${k} » : texte attendu`); out[k] = v; }
      else if (type === 'str') { if (typeof v !== 'string' || v.length < (min ?? 0) || v.length > max) throw new PolicyError('bad_input', `« ${k} » : texte de ${min ?? 0} à ${max} caractères`); out[k] = v; }
      else if (type === 'int') { if (!Number.isInteger(v) || v < min || v > max) throw new PolicyError('bad_input', `« ${k} » : entier de ${min} à ${max}`); out[k] = v; }
      else if (type === 'bool') { if (typeof v !== 'boolean') throw new PolicyError('bad_input', `« ${k} » : booléen attendu`); out[k] = v; }
    }
    return out;
  }
  const canonJson = v => (Array.isArray(v) ? '[' + v.map(canonJson).join(',') + ']' : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonJson(v[k])).join(',') + '}' : JSON.stringify(v));
  const hashCall = (tool, input, scope) => crypto.createHash('sha256').update(canonJson({ tool, input, scope: scope || '' })).digest('hex');
  const clip = (s, n) => (s.length > n ? s.slice(0, n) + `… (+${s.length - n} car.)` : s);
  const sizeOf = real => { try { const st = fs.lstatSync(real); return st.isFile() ? st.size : null; } catch (e) { return undefined; } };
  const fmtBytes = n => (n < 1024 ? `${n} octets` : n < 1048576 ? `${(n / 1024).toFixed(1)} Ko` : `${(n / 1048576).toFixed(1)} Mo`);

  // Renvoie { cls: 'read'|'write'|'shell'|'deny', ... }. Ne lève jamais : tout problème devient un refus motivé.
  function plan(rawName, rawInput, scope) {
    const tool = bare(rawName);
    try {
      if (SHELL_TOOLS.includes(tool)) {
        const input = validateInput('shell', rawInput);
        if (input.run_in_background) return { cls: 'deny', tool, reason: 'l’exécution en arrière-plan est interdite (pas d’exécution sans interface)' };
        if (input.dangerouslyDisableSandbox) return { cls: 'deny', tool, reason: 'désactivation du bac à sable interdite' };
        const a = analyzeCommand(input.command);
        if (a.hard) return { cls: 'deny', tool, reason: `commande refusée même avec approbation : ${a.hard}` };
        const risks = ['Une commande peut lire, modifier ou supprimer des fichiers, ou lancer des programmes, avec les droits de ton compte Windows.', 'Vie ne peut pas prévoir tout ce que fait une commande : relis-la entièrement.'];
        if (a.network) risks.unshift('RÉSEAU : cette commande semble communiquer avec Internet ou un autre poste ; ce qu’elle envoie quitte ton PC.');
        if (a.install) risks.unshift('INSTALLATION : cette commande semble installer ou mettre à jour un logiciel (modifie ton système et télécharge du code).');
        return { cls: 'shell', tool, input, hash: hashCall(tool, input, scope), paths: [], command: input.command, network: a.network, install: a.install, risks, rollback: 'Aucun retour arrière automatique : une commande n’est pas annulable par Vie.', title: `${tool} : exécuter une commande`, details: [{ label: 'Dossier de travail', value: cwd }, ...(input.timeout ? [{ label: 'Délai maximal', value: `${Math.round(input.timeout / 1000)} s` }] : []), ...(input.description ? [{ label: 'Description donnée par le modèle', value: clip(input.description, 300) }] : [])] };
      }
      if (READ_TOOLS.includes(tool)) {
        const input = validateInput(tool, rawInput);
        const paths = [];
        const out = { ...input };
        if (tool === 'list_roots') return { cls: 'read', tool, input: out, hash: hashCall(tool, out, scope), paths };
        // glob/grep sans « path » partent du dossier de travail de l'agent.
        const real = input.path ? canon(input.path) : cwd;
        const pr = protectedReason(real);
        if (pr) return { cls: 'deny', tool, reason: `chemin refusé : ${pr}` };
        out.path = real;
        paths.push({ path: real, role: 'lire' });
        return { cls: 'read', tool, input: out, hash: hashCall(tool, out, scope), paths };
      }
      if (WRITE_TOOLS.includes(tool)) {
        const input = validateInput(tool, rawInput);
        const out = { ...input };
        const paths = [], details = [], risks = [];
        let rollback = '', title = '';
        // Vie ne crée jamais de dossiers : un parent absent est refusé avant toute carte (l'écriture échouerait de toute façon).
        const needParent = real => { let ok = false; try { ok = fs.statSync(P.dirname(real)).isDirectory(); } catch (e) { ok = false; } if (!ok) throw new PolicyError('no_parent', 'le dossier parent n’existe pas (Vie ne crée pas de dossiers)'); };
        let base = ''; // empreinte du fichier TEL QU'IL EST au moment de la carte : liée à l'empreinte de l'appel (un fichier modifié entre la carte et l'exécution invalide l'approbation)
        const resolveW = (k, role) => {
          const { abs, real } = canonPair(input[k]);
          const why = writeDenied(real, abs) || ancestorReason(real) || (abs !== real ? ancestorReason(abs) : null);
          if (why) throw new PolicyError('write_denied', `${role} refusé : ${why}`);
          out[k] = real; paths.push({ path: real, role });
          if (!inside(real, home)) risks.push(`HORS de ton dossier utilisateur : ${real}`);
          return real;
        };
        // Un fichier à plusieurs noms (lien physique) peut être, sous un autre nom, un profil ou un hook : refusé (échec fermé).
        const noHardLink = real => { try { if (fs.lstatSync(real).nlink > 1) throw new PolicyError('hardlink', 'le fichier a plusieurs noms (lien physique) : impossible de savoir quel fichier est réellement modifié'); } catch (e) { if (e instanceof PolicyError) throw e; } };
        // Contenu actuel montré en ENTIER (UTF-8 valide, sans octet nul, ≤ LIM.content caractères) ; sinon refus : jamais d'aperçu partiel d'un écrasement.
        const readWhole = (real, sz, what) => {
          if (sz > LIM.content * 4) throw new PolicyError('old_too_large', `${what} : le contenu actuel (${fmtBytes(sz)}) est trop volumineux pour être montré en entier sur la carte : refusé (échec fermé)`);
          const buf = fs.readFileSync(real);
          let txt; try { txt = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf); } catch (e) { throw new PolicyError('old_binary', `${what} : le contenu actuel n’est pas du texte UTF-8 : il ne peut pas être montré en entier : refusé (échec fermé)`); }
          if (buf.includes(0) || txt.length > LIM.content) throw new PolicyError('old_too_large', `${what} : le contenu actuel est binaire ou dépasse ${LIM.content} caractères : refusé (échec fermé)`);
          base = crypto.createHash('sha256').update(buf).digest('hex');
          return txt;
        };
        if (tool === 'write_file') {
          const real = resolveW('path', 'écrire');
          needParent(real);
          const sz = sizeOf(real);
          const sha = crypto.createHash('sha256').update(input.content, 'utf8').digest('hex');
          let old = null;
          if (sz === undefined) { title = 'Créer un fichier'; rollback = 'Nouveau fichier : pour revenir en arrière, supprime-le.'; if (input.overwrite) risks.push('« overwrite » demandé mais le fichier n’existe pas : il sera créé.'); }
          else if (sz === null) throw new PolicyError('not_a_file', 'la cible existe mais n’est pas un fichier');
          else if (!input.overwrite) throw new PolicyError('exists', 'le fichier existe déjà et « overwrite » n’est pas demandé');
          else { noHardLink(real); old = readWhole(real, sz, 'écraser'); title = 'Remplacer un fichier existant'; risks.push(`Le contenu actuel (${fmtBytes(sz)}) sera REMPLACÉ.`); rollback = 'L’ancien contenu est copié dans le dossier de sauvegardes de Vie juste avant l’écriture (chemin indiqué dans le reçu).'; }
          details.push({ label: 'Taille écrite', value: `${fmtBytes(Buffer.byteLength(input.content, 'utf8'))} · ${input.content.length} caractères · sha256 ${sha.slice(0, 16)}…` });
          if (old !== null) {
            const d = lineDiff(visible(old), input.content.replace(/\r\n/g, '\n'));
            details.push({ label: 'Contenu ACTUEL (sera remplacé), en entier', value: visible(old), pre: true }, { label: `Différences ligne à ligne (${d.changed} ligne(s) retirée(s) ou ajoutée(s))`, value: d.text || '(aucune différence)', pre: true });
          }
          details.push({ label: 'Contenu intégral qui sera écrit', value: input.content, pre: true });
        } else if (tool === 'edit_file') {
          const real = resolveW('path', 'modifier');
          const sz = sizeOf(real);
          if (typeof sz !== 'number') throw new PolicyError('not_a_file', 'le fichier à modifier est introuvable');
          if (sz > LIM.editFile) throw new PolicyError('too_big', 'fichier trop gros pour une édition (plus de 5 Mo)');
          noHardLink(real);
          const buf = fs.readFileSync(real); base = crypto.createHash('sha256').update(buf).digest('hex');
          const count = buf.toString('utf8').split(input.old_string).length - 1;
          title = 'Modifier un fichier (remplacement exact)'; rollback = 'L’ancien contenu est copié dans le dossier de sauvegardes de Vie juste avant la modification.';
          const d = lineDiff(input.old_string.replace(/\r\n/g, '\n'), input.new_string.replace(/\r\n/g, '\n'));
          if (count === 0) risks.push('Le texte à remplacer est introuvable dans le fichier actuel : l’exécution échouera sans rien modifier.');
          else if (count > 1 && !input.replace_all) risks.push(`Le texte apparaît ${count} fois et « replace_all » n’est pas demandé : l’exécution échouera sans rien modifier.`);
          details.push({ label: 'Occurrences dans le fichier actuel', value: `${count}${input.replace_all ? ' (toutes seront remplacées)' : ' (une seule remplacée, refus s’il y en a plusieurs)'}` },
            { label: `Différence appliquée à chaque occurrence (${d.changed} ligne(s) retirée(s) ou ajoutée(s))`, value: d.text || '(aucune différence)', pre: true },
            { label: 'Texte remplacé, en entier', value: input.old_string, pre: true }, { label: 'Remplacé par, en entier', value: input.new_string, pre: true });
        } else if (tool === 'move_path') {
          const a = resolveW('from', 'déplacer (source)'), b = resolveW('to', 'déplacer (destination)');
          const dr = descendantReason(a); if (dr) throw new PolicyError('write_denied', `déplacer (source) refusé : ${dr}`);
          needParent(b);
          title = 'Déplacer ou renommer'; rollback = `Pour annuler : redéplace « ${b} » vers « ${a} ».`;
          if (sizeOf(b) !== undefined) throw new PolicyError('exists', 'la destination existe déjà : Vie n’écrase jamais par un déplacement');
        } else if (tool === 'delete_file') {
          const real = resolveW('path', 'supprimer');
          const sz = sizeOf(real);
          if (typeof sz !== 'number') throw new PolicyError('not_a_file', 'seuls les fichiers peuvent être supprimés (pas les dossiers)');
          title = 'Supprimer un fichier'; risks.unshift(`Suppression de ${fmtBytes(sz)}.`); rollback = 'Une copie est conservée dans le dossier de sauvegardes de Vie (fichier ≤ 50 Mo) : le fichier n’est pas envoyé à la corbeille.';
        }
        risks.push('Un fichier lu ou fourni par un tiers peut contenir des instructions trompeuses : ne valide que ce que TU veux.');
        return { cls: 'write', tool, input: out, hash: hashCall(tool, base ? { ...out, '@base': base } : out, scope), baseSha256: base || undefined, paths, details, risks, rollback, title, outsideUser: risks.some(r => r.startsWith('HORS')) };
      }
      return { cls: 'deny', tool, reason: `outil « ${String(rawName).slice(0, 40)} » non autorisé dans le mode Agent` };
    } catch (e) {
      if (e instanceof PolicyError) return { cls: 'deny', tool, reason: e.message };
      return { cls: 'deny', tool, reason: 'appel d’outil invalide' };
    }
  }

  return { platform, home, cwd, vieRoot, canon, canonPair, persistenceReason, protectedReason, protectedName, writeDenied, ancestorReason, descendantReason, moveScan: SCAN, analyzeCommand, validateInput, plan, hashCall, canonJson, inside, comps, P, fmtBytes };
}

// Masquage heuristique des secrets dans tout texte lu qui part vers le modèle ou vers l'interface. Pas fiable à 100 % : c'est une ceinture, pas une garantie.
const SECRET_PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{16,}/g, '[clé-masquée]'],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, '[clé-aws-masquée]'],
  [/\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g, '[jeton-github-masqué]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '[jeton-slack-masqué]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[clé-privée-masquée]'],
  [/\b((?:password|passwd|pwd|secret|token|api[_-]?key|apikey|authorization)\s*["']?\s*[:=]\s*["']?)([^\s"',;]{6,})/gi, '$1[masqué]'],
];
function redact(text, extra) {
  let s = String(text);
  for (const [re, rep] of SECRET_PATTERNS) s = s.replace(re, rep);
  if (extra) for (const x of [].concat(extra)) if (typeof x === 'string' && x.length >= 12) s = s.split(x).join('[clé-masquée]');
  return s;
}

module.exports = { createPolicy, PolicyError, persistenceReason, lineDiff, visible, fold, redact, READ_TOOLS, WRITE_TOOLS, SHELL_TOOLS, MCP_PREFIX, SPECS, LIM, DENY_DIRS, DENY_SEQ, bare };
