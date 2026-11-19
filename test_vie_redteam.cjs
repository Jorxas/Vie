// Tests de non-régression des correctifs issus de la revue « red team » indépendante (2026-11-15) : hors ligne, aucun réseau, aucun serveur, dossiers temporaires.
// Chaque test a un témoin négatif (l'ancien comportement dangereux) ET un témoin positif (l'usage légitime reste possible).
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPolicy } = require('./vie-policy.cjs');
const { createTools, unsafeRegex, globToRegex } = require('./vie-tools.cjs');
const D = require('./vie-dev.cjs');

const win = process.platform === 'win32';
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('  KO  ' + name + '\n      ' + String(e && e.stack || e).split('\n').slice(0, 4).join('\n      ')); } }

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vie-redteam-')));
const home = path.join(tmp, 'home'); fs.mkdirSync(path.join(home, 'Documents'), { recursive: true });
const pol = createPolicy({ home, cwd: home, vieRoot: __dirname });
const sh = command => pol.plan('PowerShell', { command });
const W = (p, content, extra) => pol.plan('mcp__vie__write_file', Object.assign({ path: p, content }, extra));

console.log('Revue red team : correctifs');

t('P1 #1 : le mode structure ne peut modifier aucun fichier chargé par le serveur', () => {
  assert.deepEqual([...D.DEV_FILES].sort(), ['app.js', 'index.html', 'styles.css', 'vie-assistant.js']);
  for (const f of ['core.js', 'vie-actions.js', 'vie-server.cjs']) assert.ok(!D.DEV_FILES.includes(f), f);
});

t('P1 #2 : la carte d’approbation n’a plus de défilement interne ni de hauteur maximale (la fin d’une commande ne peut pas être cachée)', () => {
  const css = fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf8');
  assert.match(css, /\.vie-ag-card \.vie-ag-det pre\{max-height:none;overflow:visible\}/);
  assert.ok(css.indexOf('max-height:160px;overflow:auto}') < css.indexOf('.vie-ag-card .vie-ag-det pre{max-height:none'), 'la règle de la carte vient après la règle générale');
});

t('P2 #3 : filtres durs sur les commandes — contournements par fragmentation / flux / motif / environnement refusés', () => {
  const bad = [
    'Get-Content .env.', 'Get-Content .env::$DATA', 'type *.env', 'type .e*', 'type .en[v]', "gc ('.e'+'nv')", "gc '.e' + 'nv'", 'Get-Content ".en`v"',
    'cmd /c set', 'cmd.exe /k set', 'env | sort', 'set | findstr KEY', '[System.Environment]::GetEnvironmentVariable("PATH")',
    "[System.Environment]::GetEnvironmentVariable('ANTHROPIC_'+'API_KEY')", '$env:ANTHROPIC_API_KEY', 'Write-Output $env:MY_SECRET_TOKEN',
    'Add-Type -Name x\n-MemberDefinition "[DllImport]"', 'New-ItemProperty -Path HKCU:\nSoftware\\Run -Name x',
  ];
  for (const c of bad) { const r = sh(c); assert.equal(r.cls, 'deny', 'devrait être refusée : ' + JSON.stringify(c)); }
  const good = ['Get-ChildItem Documents', 'git status', 'echo bonjour', 'Get-ChildItem -Filter *.md', 'dir .environnement-notes', 'type notes.txt', 'python exo.py'];
  for (const c of good) { const r = sh(c); assert.equal(r.cls, 'shell', 'devrait rester possible (avec approbation) : ' + JSON.stringify(c) + ' → ' + JSON.stringify(r)); }
});

t('P2 #6 : aperçu intégral des écritures — contenu ≤ 20 000 caractères montré EN ENTIER, au-delà refusé, caractères invisibles refusés', () => {
  const body = ('ligne de test éàç 😀\n').repeat(500); // ~10 000 caractères
  const p = W(path.join(home, 'Documents', 'a.txt'), body);
  assert.equal(p.cls, 'write', JSON.stringify(p).slice(0, 200));
  const pre = p.details.find(d => d.label === 'Contenu intégral qui sera écrit'); assert.equal(pre.value, body, 'aperçu = contenu intégral, aucune troncature');
  assert.ok(!/\(\+\d+ car\.\)/.test(pre.value));
  assert.equal(W(path.join(home, 'Documents', 'b.txt'), 'x'.repeat(20001)).cls, 'deny', 'au-delà de la limite relisible : refusé');
  assert.equal(W(path.join(home, 'Documents', 'c.txt'), 'x'.repeat(20000)).cls, 'write', 'limite exacte acceptée');
  const e = pol.plan('mcp__vie__edit_file', { path: path.join(home, 'Documents', 'a.txt'), old_string: 'a', new_string: 'b'.repeat(20001) });
  assert.equal(e.cls, 'deny');
  // caractères invisibles / ambigus : refus dans le chemin, le contenu, les chaînes d'édition et la commande
  for (const ch of ['‮', '᠏', '️', '​', ' ', '⠀', '﻿', ' ']) {
    assert.equal(W(path.join(home, 'Documents', 'd.txt'), 'avant' + ch + 'après').cls, 'deny', 'contenu U+' + ch.codePointAt(0).toString(16));
    assert.equal(W(path.join(home, 'Documents', 'e' + ch + '.txt'), 'x').cls, 'deny', 'chemin U+' + ch.codePointAt(0).toString(16));
    assert.equal(sh('echo a' + ch + 'b').cls, 'deny', 'commande U+' + ch.codePointAt(0).toString(16));
    assert.equal(pol.plan('mcp__vie__edit_file', { path: path.join(home, 'Documents', 'a.txt'), old_string: 'a', new_string: 'x' + ch }).cls, 'deny', 'édition');
  }
  // texte légitime : accents, œ, ß, guillemets, tirets, CRLF, emoji sans sélecteur
  assert.equal(W(path.join(home, 'Documents', 'f.txt'), 'Œuvre « très » naïve — Straße\r\nligne 2\t🙂').cls, 'write');
});

t('P2 #6/#9 : fichiers qui exécutent des programmes ou cachent des secrets (profils, .gitconfig, .env~, « .env - Copie ») refusés à l’écriture et à la lecture ; modèles .env.example autorisés', () => {
  for (const n of ['.bashrc', '.gitconfig', '.bash_profile', '.zshrc', 'serveur.rdp', 'terraform.tfstate', '.env~', '.env-old', '.env_bak', '.env - Copie', '.env.local', '.env']) {
    assert.ok(pol.protectedReason(path.join(home, 'Documents', n)), 'protégé : ' + n);
    assert.equal(W(path.join(home, 'Documents', n), 'x').cls, 'deny', 'écriture refusée : ' + n);
  }
  for (const ok of ['.env.example', '.env.sample', '.env.template', 'environment.md', 'notes.txt']) assert.equal(pol.protectedReason(path.join(home, 'Documents', ok)), null, ok);
});

t('P2 #8 : le dossier de Vie est protégé même si le serveur est lancé par un chemin alias (jonction)', () => {
  const link = path.join(tmp, 'alias-vie');
  try { fs.symlinkSync(__dirname, link, win ? 'junction' : 'dir'); } catch (e) { console.log('      (lien non créable ici : ' + e.code + ')'); return; }
  const p2 = createPolicy({ home, cwd: home, vieRoot: link });
  assert.equal(p2.plan('mcp__vie__write_file', { path: path.join(__dirname, 'nouveau-test.txt'), content: 'x' }).cls, 'deny', 'écriture dans le vrai dossier de Vie refusée');
  assert.equal(p2.plan('mcp__vie__write_file', { path: path.join(link, 'nouveau-test.txt'), content: 'x' }).cls, 'deny', 'écriture via l’alias refusée');
  assert.ok(!fs.existsSync(path.join(__dirname, 'nouveau-test.txt')));
});

t('P2 #4 : garde anti-ReDoS — groupes quantifiés, références arrière, assertions, trop de quantificateurs : refusés ; expressions ordinaires acceptées', () => {
  for (const p of ['(.|\\s)*Z', '(a+)+', '(a|aa)+$', '(a|b){2,}', '(?=a)b', '(?<=a)b', '\\1', '(a)\\1', 'a*a*a*', '.*.*.*x', '.+.+.+', '(x)?']) assert.ok(unsafeRegex(p), 'devrait être refusée : ' + p);
  for (const p of ['algo.*tri', '^\\s*def \\w+\\(', 'foo|bar', 'x{2,5}', 'password\\s*[:=]', '\\bTODO\\b', 'a.*b.*c', '\\d{4}-\\d{2}']) assert.equal(unsafeRegex(p), null, 'devrait rester possible : ' + p);
  assert.throws(() => globToRegex('**/**/**/x', true)); assert.doesNotThrow(() => globToRegex('**/*.md', true)); assert.doesNotThrow(() => globToRegex('a/**/b/**/c', true));
});

t('P2 #4 : un fichier piégé (40 espaces puis un caractère) ne bloque plus le serveur avec grep_files regex:true', () => {
  const dir = path.join(home, 'Documents', 'piege'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'x.txt'), ' '.repeat(40) + 'a\n');
  const tools = createTools({ policy: pol, backupRoot: path.join(tmp, 'bk') });
  const plan = pol.plan('mcp__vie__grep_files', { pattern: '(.|\\s)*Z', path: dir, regex: true });
  assert.equal(plan.cls, 'read');
  const t0 = Date.now(); const r = tools.read.grep_files(plan, plan.input);
  assert.ok(Date.now() - t0 < 1500, 'terminé vite : ' + (Date.now() - t0) + ' ms');
  assert.match(r.text, /refusée/i);
  // témoin positif : une expression ordinaire fonctionne
  fs.writeFileSync(path.join(dir, 'y.txt'), 'bonjour monde\n');
  const p2 = pol.plan('mcp__vie__grep_files', { pattern: 'bon.*monde', path: dir, regex: true });
  assert.match(tools.read.grep_files(p2, p2.input).text, /y\.txt:1/);
});

t('B3 (QA passe 4) : une expression admise par la garde statique mais quadratique (a*a*b) sur des lignes de 1990 caractères est INTERROMPUE par un délai réel (≈ 1 s), pas 12 s ; résultat honnête « interrompue » ; expressions ordinaires intactes', () => {
  const dir = path.join(home, 'Documents', 'quadratique'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'gros.txt'), ('a'.repeat(1990) + 'c\n').repeat(12));   // ≈ 24 Ko : l'ancien code y passait ≈ 12 s
  assert.equal(unsafeRegex('a*a*b'), null, 'la garde statique laisse passer (c’est le point du test)');
  const tools = createTools({ policy: pol, backupRoot: path.join(tmp, 'bk') });
  const plan = pol.plan('mcp__vie__grep_files', { pattern: 'a*a*b', path: dir, regex: true }); assert.equal(plan.cls, 'read');
  const t0 = Date.now(); const r = tools.read.grep_files(plan, plan.input); const ms = Date.now() - t0;
  assert.ok(ms < 3500, 'borné par le délai : ' + ms + ' ms'); assert.match(r.text, /RECHERCHE INTERROMPUE/); assert.equal(r.isError, false);
  // le matcher lui-même : même un motif que la garde refuserait est interrompu s'il arrivait jusque-là
  const { lineMatcher, RegexTimeout } = require('./vie-tools.cjs'); const m = lineMatcher('(a+)+b', '');
  const t1 = Date.now(); assert.throws(() => m(['a'.repeat(45) + 'c'], 300), RegexTimeout); assert.ok(Date.now() - t1 < 1500, 'catastrophique interrompu : ' + (Date.now() - t1) + ' ms');
  assert.deepEqual(lineMatcher('bon.*monde', 'i')(['xx', 'BONJOUR MONDE', 'rien'], 500), [1], 'témoin positif');
  assert.deepEqual(lineMatcher('a', '')(['a'.repeat(2001), 'a'], 500), [1], 'lignes de plus de 2000 caractères ignorées comme avant');
  fs.writeFileSync(path.join(dir, 'ok.txt'), 'bonjour monde\n');
  const p2 = pol.plan('mcp__vie__grep_files', { pattern: 'bon.*monde', path: dir, regex: true }); const r2 = tools.read.grep_files(p2, p2.input);
  assert.match(r2.text, /ok\.txt:1/); assert.ok(!/INTERROMPUE/.test(r2.text));
});

t('P2 #7 : un coût rapporté de 0 alors que des tours ont eu lieu n’est jamais considéré comme fiable', () => {
  const src = fs.readFileSync(path.join(__dirname, 'vie-agent.cjs'), 'utf8');
  assert.match(src, /total_cost_usd === 0 && Number\(r\.num_turns\) > 0/);
});

t('P3 : comparaisons à temps constant sans exception sur chaînes non ASCII de même longueur ; verrou de démarrage de l’agent ; lanceurs sans node.exe du dossier courant', () => {
  for (const f of ['vie-server.cjs', 'vie-approvals.cjs', 'vie-dev.cjs']) {
    const s = fs.readFileSync(path.join(__dirname, f), 'utf8');
    assert.ok(!/a\.length === b\.length && crypto\.timingSafeEqual\(Buffer\.from\(a\)/.test(s), f + ' : ancienne comparaison');
    assert.ok(!/t\.length !== token\.length/.test(s), f);
  }
  const { createApprovals } = require('./vie-approvals.cjs'); assert.equal(typeof createApprovals, 'function');
  const agent = fs.readFileSync(path.join(__dirname, 'vie-agent.cjs'), 'utf8');
  assert.ok(agent.indexOf('starting = true') < agent.indexOf('await loadSdk()') || agent.indexOf('starting = true; try { await loadSdk()') > 0, 'verrou avant l’attente du moteur');
  for (const f of ['start-vie.cmd', 'start-vie-dev.cmd']) assert.match(fs.readFileSync(path.join(__dirname, f), 'utf8'), /set NoDefaultCurrentDirectoryInExePath=1/);
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* nettoyage au mieux */ }
console.log(`${pass}/${pass + fail} PASS`);
process.exit(fail ? 1 : 0);
