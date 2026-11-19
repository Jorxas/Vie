// Tests hors ligne du MODE STRUCTURE (écriture de code) : interrupteur serveur, approbation à usage unique, aperçu intégral, annulation, validation par sous-processus.
// Anthropic est SIMULÉ (fetch injecté) : aucun réseau, aucun coût, aucune vraie clé. Tout se passe dans des dossiers temporaires ; jamais de .env réel.
//   node test_vie_code.cjs
'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createVieServer } = require('./vie-server.cjs');
const { login } = require('./test_vie_auth.cjs');
const D = require('./vie-dev.cjs');

const FAKE_KEY = 'FAKE-KEY-NOT-A-SECRET-0123456789abcdefghij';
const results = [];
const check = (name, fn) => results.push({ name, fn });
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const WEB = ['index.html', 'styles.css', 'app.js', 'vie-assistant.js']; // core.js et vie-actions.js sont chargés par le SERVEUR (qui détient la clé) : jamais modifiables par le mode structure
const PROTECTED = ['vie-server.cjs', 'vie-dev.cjs', '.env', 'test_x.cjs', 'package.json'];

function req(port, { method = 'GET', url = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const h = { ...headers };
    if (data !== null) h['Content-Length'] = Buffer.byteLength(data);
    const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch (e) { /* pas du JSON */ } resolve({ status: res.statusCode, headers: res.headers, text, json }); });
    });
    r.on('error', reject);
    if (data !== null) r.write(data);
    r.end();
  });
}
const same = port => ({ Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' });
const anthropicOk = (content, extra = {}) => ({ id: 'msg_x', type: 'message', role: 'assistant', model: 'm', content, stop_reason: 'tool_use', usage: { input_tokens: 1000, output_tokens: 500 }, ...extra });
const tool = (name, input, id = 'tu_' + name) => ({ type: 'tool_use', id, name, input });
const edit = (file, old_text, new_text, reason = 'test') => tool('propose_code_edit', { file, old_text, new_text, reason }, 'tu_' + Math.random().toString(36).slice(2, 8));

function devRoot() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vie-code-test-')));
  for (const f of WEB) fs.writeFileSync(path.join(dir, f), f.endsWith('.js') ? `'use strict';\nmodule.exports = { name: '${f}' };\n// marqueur-unique-${f}\n// alpha-1\n// beta-2\n` : `<!-- ${f} -->\n`);
  for (const f of PROTECTED) fs.writeFileSync(path.join(dir, f), f === 'package.json' ? '{"name":"vie-test","private":true}' : 'INTOUCHABLE');
  return dir;
}
const shaOf = (root, files) => sha(files.map(f => fs.readFileSync(path.join(root, f), 'utf8')).join('|'));
const read = (root, f) => fs.readFileSync(path.join(root, f), 'utf8');

// Serveur de test : l'« Anthropic » simulé renvoie h.blocks. Le basculement VIE_DEV vient de env, comme au vrai démarrage.
async function boot({ env = { VIE_DEV: 'on' }, key = true, root = devRoot(), clock = { t: Date.now() }, opts = {} } = {}) {
  const h = { blocks: [{ type: 'text', text: 'ok' }], calls: 0, logs: [], root, clock };
  const e = { ...env, ...(key ? { ANTHROPIC_API_KEY: FAKE_KEY } : {}) };
  const vie = createVieServer({ env: e, envFile: path.join(root, 'absent.env'), fetch: async () => { h.calls++; return new Response(JSON.stringify(anthropicOk(h.blocks)), { status: 200, headers: { 'content-type': 'application/json' } }); }, sleep: () => Promise.resolve(), log: l => h.logs.push(l), limits: { perMinute: 10000 }, root, now: () => clock.t, ...opts });
  const port = await vie.listen(0);
  h.vie = vie; h.port = port;
  h.session = async () => {
    const { cookie, token } = await login(vie);   // même chemin que la production : ticket émis en processus -> POST /api/auth/exchange
    const s = { cookie, token, hdr: (over = {}) => ({ ...same(port), 'Content-Type': 'application/json', Cookie: s.cookie, 'X-Vie-Token': s.token, ...over }) };
    s.post = (url, body, over) => req(port, { method: 'POST', url, headers: s.hdr(over), body });
    // demande de chat en mode structure : renvoie la réponse, dont proposals / rejected
    s.ask = (blocks, body = {}) => { h.blocks = blocks; return s.post('/api/chat', { mode: 'rapide', share: false, messages: [{ role: 'user', content: 'Modifie le code' }], view: 'today', today: '2026-11-14', dev: true, ...body }); };
    s.apply = (p, over = {}) => s.post('/api/code', { id: p.id, nonce: p.nonce, hash: p.hash, confirm: true, ...over });
    s.undo = (u, over = {}) => s.post('/api/code/undo', { id: u.id, nonce: u.nonce, hash: u.hash, confirm: true, ...over });
    return s;
  };
  h.done = async () => { await vie.close(); fs.rmSync(root, { recursive: true, force: true }); };
  return h;
}
// Une proposition valide déjà émise par le serveur
async function proposed(h, s, blocks) { const r = await s.ask(blocks); assert.equal(r.status, 200, r.text); assert.ok(r.json.proposals.length >= 1, JSON.stringify(r.json)); return r.json.proposals; }

// === 1. Interrupteur serveur, désactivé par défaut ======================================================================================================
check('par défaut (sans VIE_DEV) : /api/health dev.enabled=false ; dev:true refusé AVANT tout appel amont, même avec session + jeton + clé valides', async () => {
  const h = await boot({ env: {} });
  try {
    assert.equal(h.vie.config.devEnabled, false);
    const s = await h.session();
    const hr = await req(h.port, { url: '/api/health', headers: { Host: `127.0.0.1:${h.port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: s.cookie } });
    assert.equal(hr.json.dev.enabled, false);
    const r = await s.ask([edit('app.js', 'marqueur-unique-app.js', 'x')]);
    assert.equal(r.status, 403); assert.equal(r.json.error, 'dev_disabled');
    assert.equal(h.calls, 0, 'aucun appel Anthropic : le code n’a pas été lu ni envoyé');
    const r2 = await s.ask([], { dev: false }); assert.equal(r2.status, 200, 'le chat normal fonctionne sans le mode structure');
    assert.ok(!h.fetchBodies); assert.equal(h.vie.codeGate.enabled, false);
  } finally { await h.done(); }
});
check('interrupteur : seul VIE_DEV=on (insensible à la casse, espaces tolérés) dans l’environnement du PROCESSUS l’active ; off / 1 / true / yes / vide / .env : non', async () => {
  for (const [v, want] of [['on', true], ['ON', true], [' On ', true], ['off', false], ['1', false], ['true', false], ['yes', false], ['', false], ['onx', false], [undefined, false]]) {
    const root = devRoot();
    // même un .env contenant VIE_DEV=on (fichier de TEST, jamais le vrai .env) ne doit rien changer
    fs.writeFileSync(path.join(root, 'test.env'), 'VIE_DEV=on\nANTHROPIC_API_KEY=' + FAKE_KEY + '\n');
    const vie = createVieServer({ env: v === undefined ? {} : { VIE_DEV: v }, envFile: path.join(root, 'test.env'), root, log: () => {}, fetch: async () => { throw new Error('réseau interdit'); } });
    try { assert.equal(vie.config.devEnabled, want, JSON.stringify(v)); assert.equal(vie.codeGate.enabled, want); assert.equal(vie.config.apiKey, FAKE_KEY, 'la clé du .env de test est bien lue : seul VIE_DEV est ignoré'); } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});
check('interrupteur indépendant de la clé API : activé sans clé (chat = 503 no_key, mais /api/code reste soumis à l’approbation) ; désactivé AVEC clé valide', async () => {
  const a = await boot({ key: false });
  try {
    const s = await a.session();
    assert.equal(a.vie.codeGate.enabled, true);
    assert.equal((await s.ask([])).json.error, 'no_key');
    assert.equal((await s.post('/api/code', { id: 'x'.repeat(10), nonce: 'y'.repeat(20), hash: 'a'.repeat(64), confirm: true })).json.error, 'approval_invalid');
  } finally { await a.done(); }
  const b = await boot({ env: {}, key: true });
  try { assert.equal(b.vie.config.apiKey, FAKE_KEY); assert.equal(b.vie.codeGate.enabled, false); } finally { await b.done(); }
});
check('interrupteur coupé : /api/code et /api/code/undo = 403 dev_disabled, MÊME avec une approbation authentique émise ailleurs ; aucun fichier ni sauvegarde touché', async () => {
  const root = devRoot();
  const on = await boot({ root });
  const s1 = await on.session();
  const [p] = await proposed(on, s1, [edit('app.js', 'marqueur-unique-app.js', 'AUTHENTIQUE')]);
  const [q] = await proposed(on, s1, [edit('styles.css', '<!-- styles.css -->', 'x')]);
  await on.vie.close();
  const before = shaOf(root, WEB);
  const off = await boot({ root, env: {} });
  try {
    const s2 = await off.session();
    for (const sess of [s2]) {
      for (const [u, body] of [['/api/code', { id: p.id, nonce: p.nonce, hash: p.hash, confirm: true }], ['/api/code/undo', { id: q.id, nonce: q.nonce, hash: q.hash, confirm: true }], ['/api/code', {}], ['/api/code', { file: 'app.js', old: 'x', new: 'y' }]]) {
        const r = await sess.post(u, body); assert.equal(r.status, 403, u + r.text); assert.equal(r.json.error, 'dev_disabled');
      }
    }
    assert.equal(shaOf(root, WEB), before); assert.ok(!fs.existsSync(path.join(root, '.vie-backups')));
  } finally { await off.done(); }
});

// === 2. Authentification seule insuffisante ===============================================================================================================
check('session + jeton valides ne suffisent PAS : ancien format {file, old, new} refusé, id inconnu refusé, confirm absent / faux refusé ; aucun fichier touché', async () => {
  const h = await boot();
  try {
    const s = await h.session(); const before = shaOf(h.root, WEB);
    assert.equal((await s.post('/api/code', { file: 'app.js', old: 'marqueur-unique-app.js', new: 'PWNED' })).status, 400, 'paramètres inconnus');
    assert.equal((await s.post('/api/code', { file: 'app.js', old: 'marqueur-unique-app.js', new: 'PWNED', id: 'a'.repeat(10), nonce: 'b'.repeat(20), hash: 'c'.repeat(64), confirm: true })).status, 400, 'contenu fourni par le client : refusé');
    for (const body of [{}, { id: 'a'.repeat(10) }, { id: 1, nonce: 2, hash: 3, confirm: true }, { id: 'a'.repeat(10), nonce: 'b'.repeat(20), hash: 'c'.repeat(64) }]) assert.equal((await s.post('/api/code', body)).status, 400, JSON.stringify(body));
    const r = await s.post('/api/code', { id: 'a'.repeat(10), nonce: 'b'.repeat(20), hash: 'c'.repeat(64), confirm: true }); assert.equal(r.status, 403); assert.equal(r.json.error, 'approval_invalid');
    assert.equal(shaOf(h.root, WEB), before); assert.ok(!fs.existsSync(path.join(h.root, '.vie-backups')));
  } finally { await h.done(); }
});
check('/api/code : exige cookie de session + jeton + même origine + Host + JSON ; GET refusé ; routes d’aperçu / lecture inexistantes ; requêtes refusées ne consomment pas l’approbation', async () => {
  const h = await boot();
  try {
    const s = await h.session(); const [p] = await proposed(h, s, [edit('app.js', '// beta-2', '// beta-9')]);
    const bad = [[{ Cookie: '' }, 403, 'bad_session'], [{ 'X-Vie-Token': 'faux' }, 403, 'bad_token'], [{ 'X-Vie-Token': '' }, 403, 'bad_token'], [{ Origin: 'https://evil.example' }, 403], [{ 'Sec-Fetch-Site': 'cross-site' }, 403], [{ Host: 'evil.example' }, 403], [{ 'Content-Type': 'text/plain' }, 415]];
    for (const [over, st, err] of bad) {
      const r = await s.post('/api/code', { id: p.id, nonce: p.nonce, hash: p.hash, confirm: true }, over);
      assert.equal(r.status, st, JSON.stringify(over) + r.text); if (err) assert.equal(r.json.error, err);
    }
    assert.equal(read(h.root, 'app.js').includes('beta-9'), false, 'aucune des requêtes altérées n’a écrit');
    assert.equal((await req(h.port, { method: 'GET', url: '/api/code', headers: { ...same(h.port), Cookie: s.cookie } })).status, 405);
    assert.equal((await req(h.port, { method: 'GET', url: '/api/code/undo', headers: { ...same(h.port), Cookie: s.cookie } })).status, 405);
    for (const u of ['/api/code/preview', '/api/code/proposal', '/api/code/read', '/api/code/undo/x', '/api/code/']) assert.equal((await s.post(u, { id: p.id, nonce: p.nonce, hash: p.hash, confirm: true })).status, 404, u);
    assert.equal((await s.apply(p)).status, 200, 'l’approbation est restée intacte après les refus ci-dessus');
  } finally { await h.done(); }
});

// === 3. Propositions : émises par le serveur, contenu borné et lisible =====================================================================================
check('proposition = enregistrée par le serveur : id + nonce + empreinte SHA-256 du contenu complet + expiration + statistiques ; l’aperçu n’écrit rien', async () => {
  const h = await boot();
  try {
    const s = await h.session(); const before = shaOf(h.root, WEB);
    const [p] = await proposed(h, s, [edit('app.js', 'marqueur-unique-app.js', 'nouveau\n// deux lignes', 'raison')]);
    assert.equal(p.kind, 'code'); assert.equal(p.file, 'app.js'); assert.equal(p.old, 'marqueur-unique-app.js'); assert.equal(p.new, 'nouveau\n// deux lignes');
    assert.match(p.id, /^[A-Za-z0-9_-]{8,40}$/); assert.match(p.nonce, /^[A-Za-z0-9_-]{16,64}$/); assert.match(p.hash, /^[0-9a-f]{64}$/);
    assert.equal(p.hash, D.editHash('replace', 'app.js', p.old, p.new), 'empreinte du contenu complet (fichier, opération, ancien, nouveau)');
    assert.equal(p.expiresAt, h.clock.t + 600000);
    assert.deepEqual([p.stats.oldChars, p.stats.newChars, p.stats.oldLines, p.stats.newLines, p.stats.atLine], [22, 22, 1, 2, 3]);
    assert.equal(shaOf(h.root, WEB), before, 'l’aperçu (réponse du chat) n’écrit rien'); assert.ok(!fs.existsSync(path.join(h.root, '.vie-backups')));
    const [p2] = await proposed(h, s, [edit('app.js', 'marqueur-unique-app.js', 'nouveau\n// deux lignes')]);
    assert.notEqual(p.id, p2.id); assert.notEqual(p.nonce, p2.nonce); assert.equal(p.hash, p2.hash, 'même contenu = même empreinte');
    const text = JSON.stringify(h.logs); assert.ok(!text.includes(p.nonce) && !text.includes('deux lignes'), 'journal : ni nonce ni contenu');
  } finally { await h.done(); }
});
check('queue masquée : tout aperçu qui ne peut pas être relu en entier est REFUSÉ par le serveur (plus de 6000 / 12000 caractères, invisibles, bidirectionnel, contrôle, CR seul)', async () => {
  const h = await boot();
  try {
    const s = await h.session();
    const ok6000 = 'marqueur-unique-app.js'; assert.ok(ok6000.length < 6000);
    const cases = {
      'old > 6000': edit('app.js', 'a'.repeat(6001), 'x'), 'new > 12000': edit('app.js', ok6000, 'n'.repeat(12001)),
      'bidi RLO': edit('app.js', ok6000, 'visible\u202E// cache'), 'isolat bidi': edit('app.js', ok6000, 'a\u2066b\u2069'), 'largeur nulle': edit('app.js', ok6000, 'abc\u200Bdef'), 'BOM': edit('app.js', ok6000, '\uFEFFx'),
      'NUL': edit('app.js', ok6000, 'a\u0000b'), 'contrôle ESC': edit('app.js', ok6000, 'a\u001b[2Jb'), 'CR seul': edit('app.js', ok6000, 'visible\rcaché'), 'U+2028': edit('app.js', ok6000, 'a\u2028b'),
      'balise Unicode': edit('app.js', ok6000, 'x\u{E0041}'), 'sélecteur de variante': edit('app.js', ok6000, 'x\uFE01'),
      'identique': edit('app.js', ok6000, ok6000), 'absent': edit('app.js', 'texte-qui-nexiste-pas', 'x'), 'erreur de syntaxe': edit('app.js', "module.exports = { name: 'app.js' };", 'module.exports = = ;'),
    };
    h.blocks = Object.values(cases);
    // 8 propositions au plus par réponse : on les envoie une par une
    for (const [name, blk] of Object.entries(cases)) { const r = await s.ask([blk]); assert.equal(r.status, 200, name); assert.deepEqual(r.json.proposals, [], name + ' : refusée'); assert.equal(r.json.rejected.length, 1, name); }
    assert.equal(Object.keys(cases).length, 15);
    // limites exactes : acceptées (dernier caractère inclus)
    fs.appendFileSync(path.join(h.root, 'app.js'), '// ' + 'z'.repeat(5997) + '\n');
    const full = '// ' + 'z'.repeat(5997); assert.equal(full.length, 6000);
    const r = await s.ask([edit('app.js', full, 'n'.repeat(12000))]); assert.equal(r.json.proposals.length, 1, JSON.stringify(r.json.rejected));
    assert.equal(r.json.proposals[0].old.length, 6000); assert.equal(r.json.proposals[0].new.length, 12000); assert.equal(r.json.proposals[0].new, 'n'.repeat(12000), 'texte renvoyé INTÉGRALEMENT');
    // CRLF légitime accepté
    fs.appendFileSync(path.join(h.root, 'app.js'), '// crlf-a\r\n// crlf-b\r\n');
    assert.equal((await s.ask([edit('app.js', '// crlf-a\r\n', '// crlf-c\r\n')])).json.proposals.length, 1);
  } finally { await h.done(); }
});
check('Unicode (audit Codex P2) : U+180F, U+FE0F, autres sélecteurs de variante, largeur nulle, bidirectionnel, espaces trompeurs, contrôles… REFUSÉS avec le code Unicode ; la raison aussi ; rien n’est nettoyé ni écrit', async () => {
  const h = await boot();
  try {
    const s = await h.session(); const before = shaOf(h.root, WEB);
    const cp = n => String.fromCodePoint(n);
    const bad = { 'U+180F': cp(0x180F), 'U+FE0F': cp(0xFE0F), 'VS-1 U+FE00': cp(0xFE00), 'VS-15 U+FE0E': cp(0xFE0E), 'VS-17 U+E0100': cp(0xE0100), 'U+180B': cp(0x180B), 'ZWJ': cp(0x200D), 'ZWNJ': cp(0x200C), 'U+200B': cp(0x200B), 'U+2060': cp(0x2060), 'U+2063': cp(0x2063), 'BOM': cp(0xFEFF), 'U+00AD': cp(0xAD), 'U+034F': cp(0x34F), 'U+3164': cp(0x3164), 'U+FFA0': cp(0xFFA0), 'RLO': cp(0x202E), 'LRI': cp(0x2066), 'LRM': cp(0x200E), 'U+061C': cp(0x61C), 'NBSP': cp(0xA0), 'U+2003': cp(0x2003), 'U+202F': cp(0x202F), 'U+3000': cp(0x3000), 'U+1680': cp(0x1680), 'braille vide': cp(0x2800), 'U+0085': cp(0x85), 'U+2029': cp(0x2029), 'balise': cp(0xE0041), 'usage privé': cp(0xE000), 'U+FFFF': cp(0xFFFF), 'substitut isolé': cp(0xD800), 'keycap FE0F': '1' + cp(0xFE0F) + cp(0x20E3), 'emoji FE0F': cp(0x26A0) + cp(0xFE0F), 'famille ZWJ': cp(0x1F468) + cp(0x200D) + cp(0x1F469) };
    const old = 'marqueur-unique-app.js';
    for (const [name, ch] of Object.entries(bad)) {
      // dans le nouveau texte (identifiant JS qui « semble » identique), dans le texte remplacé, et dans la raison
      for (const [zone, blk] of [['new', edit('app.js', old, 'const total' + ch + ' = 1; // ' + name)], ['reason', edit('app.js', old, 'visible', 'raison' + ch + 'x')]]) {
        const r = await s.ask([blk]); assert.equal(r.status, 200, name); assert.deepEqual(r.json.proposals, [], name + ' / ' + zone + ' : refusée'); assert.equal(r.json.rejected.length, 1, name);
        assert.match(r.json.rejected[0].reason, /U\+[0-9A-F]{4,5}/, name + ' : le message nomme le point de code'); assert.ok(!r.json.rejected[0].reason.includes(ch), name + ' : le message ne reproduit pas le caractère');
      }
    }
    // l’ancien défaut précis : deux identifiants identiques à l’écran
    const r1 = await s.ask([edit('app.js', old, 'let ok' + cp(0x180F) + ' = 1;')]); assert.match(r1.json.rejected[0].reason, /U\+180F/);
    const r2 = await s.ask([edit('app.js', old, 'let ok' + cp(0xFE0F) + ' = 1;')]); assert.match(r2.json.rejected[0].reason, /U\+FE0F/);
    assert.equal(shaOf(h.root, WEB), before, 'aucun fichier modifié'); assert.ok(!fs.existsSync(path.join(h.root, '.vie-backups')), 'aucune sauvegarde');
  } finally { await h.done(); }
});
check('Unicode positif : texte FR / DE / typographique / emoji sans sélecteur / CJK / CRLF proposé et renvoyé OCTET POUR OCTET (aucune normalisation), et appliqué tel quel', async () => {
  const h = await boot();
  try {
    const s = await h.session();
    const fr = '// Ça marche : où êtes-vous ? Größe, Straße, Übung, « guillemets », 12 € … œuvre 🙂 👍🏽 🇫🇷 日本語\r\n// ligne CRLF\tavec tabulation';
    const r = await s.ask([edit('app.js', 'marqueur-unique-app.js', fr, 'raison : élégante ✔')]);
    assert.equal(r.json.proposals.length, 1, JSON.stringify(r.json.rejected)); const p = r.json.proposals[0];
    assert.equal(p.new, fr, 'texte renvoyé identique'); assert.equal(Buffer.from(p.new).equals(Buffer.from(fr)), true); assert.equal(p.reason, 'raison : élégante ✔');
    assert.equal(p.stats.newChars, fr.length); assert.ok(p.stats.nonAscii > 10);
    const a = await s.apply(p); assert.equal(a.status, 200, a.text);
    assert.ok(read(h.root, 'app.js').includes(fr), 'fichier écrit avec exactement ces caractères');
  } finally { await h.done(); }
});
check('liste blanche : serveur, garde-fous, .env, tests, package.json, chemins hors dossier, séparateurs, NUL : jamais proposés ; aucun fichier protégé modifié', async () => {
  const h = await boot();
  try {
    const s = await h.session(); const h0 = shaOf(h.root, PROTECTED);
    const names = ['core.js', 'vie-actions.js', 'vie-agent-ui.js', 'vie-server.cjs', 'vie-dev.cjs', '.env', 'test_x.cjs', 'package.json', '../vie-server.cjs', '..\\x', 'vie-agent.cjs', '.vie-backups/x', 'C:\\Windows\\win.ini', 'app.js\0', 'APP.JS', 'app.js ', './app.js', '', 'vie-assistant.js/../vie-server.cjs'];
    for (const f of names) { const r = await s.ask([edit(f, 'INTOUCHABLE', 'PWNED')]); assert.equal(r.status, 200, JSON.stringify(f)); assert.deepEqual(r.json.proposals, [], JSON.stringify(f)); }
    assert.equal(shaOf(h.root, PROTECTED), h0); assert.ok(!fs.existsSync(path.join(h.root, '.vie-backups')));
    assert.deepEqual([...D.DEV_FILES].sort(), [...WEB].sort());
  } finally { await h.done(); }
});
check('sans consentement : une proposition jamais approuvée n’écrit jamais (l’apprentissage / le chat / la santé / les redémarrages ne l’appliquent pas)', async () => {
  const h = await boot();
  try {
    const s = await h.session(); const before = shaOf(h.root, WEB);
    await proposed(h, s, [edit('app.js', 'marqueur-unique-app.js', 'x')]);
    await s.ask([], { dev: true }); await s.ask([], { dev: false });
    await req(h.port, { url: '/api/health', headers: { Host: `127.0.0.1:${h.port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: s.cookie } });
    assert.equal(shaOf(h.root, WEB), before); assert.ok(!fs.existsSync(path.join(h.root, '.vie-backups')));
  } finally { await h.done(); }
});
check('dev:true sans cookie de session = 403 bad_session (aucun appel amont) ; dev non booléen = 400 ; outils de code absents sans dev:true', async () => {
  const h = await boot();
  try {
    const s = await h.session();
    const r = await s.ask([], {}); assert.equal(r.status, 200);
    const noCookie = await s.post('/api/chat', { mode: 'rapide', share: false, messages: [{ role: 'user', content: 'x' }], dev: true }, { Cookie: '' }); assert.equal(noCookie.status, 403); assert.equal(noCookie.json.error, 'bad_session');
    const calls = h.calls;
    assert.equal((await s.post('/api/chat', { mode: 'rapide', share: false, messages: [{ role: 'user', content: 'x' }], dev: 'oui' })).status, 400);
    assert.equal(h.calls, calls);
    const r2 = await s.ask([edit('app.js', 'marqueur-unique-app.js', 'y')], { dev: false }); assert.deepEqual(r2.json.proposals, [], 'sans dev:true, propose_code_edit est un outil non autorisé'); assert.equal(r2.json.rejected.length, 1);
  } finally { await h.done(); }
});

// === 4. Approbation : falsification, rejeu, périmé, expiration ============================================================================================
check('approbation FALSIFIÉE : mauvais nonce / mauvaise empreinte / empreinte d’un autre contenu / identifiant d’un autre / autre session : 403 approval_invalid ; l’authentique reste valable après', async () => {
  const h = await boot();
  try {
    const sA = await h.session(), sB = await h.session(); const before = shaOf(h.root, WEB);
    const [p, q] = await proposed(h, sA, [edit('app.js', '// alpha-1', '// alpha-X'), edit('styles.css', '<!-- styles.css -->', '<!-- autre -->')]);
    const flip = t => t.slice(0, -1) + (t.slice(-1) === 'a' ? 'b' : 'a');
    const forgedHash = D.editHash('replace', 'app.js', '// alpha-1', '// PWNED');   // empreinte valide d’un AUTRE contenu
    const tries = [
      [sA, { nonce: flip(p.nonce) }], [sA, { nonce: q.nonce }], [sA, { nonce: '' }], [sA, { hash: flip(p.hash) }], [sA, { hash: forgedHash }], [sA, { hash: q.hash }], [sA, { id: q.id }], [sA, { id: 'inconnu' + 'x'.repeat(8) }],
      [sB, {}],   // autre session (cookie + jeton valides, mais ce n’est pas la session qui a reçu la proposition)
      [sB, { nonce: p.nonce, hash: p.hash }],
    ];
    for (const [sess, over] of tries) { const r = await sess.apply(p, over); assert.equal(r.status, 403, JSON.stringify(over) + r.text); assert.equal(r.json.error, 'approval_invalid'); }
    // injection de contenu : aucun champ supplémentaire n’est accepté
    assert.equal((await sA.apply(p, { new: '// PWNED' })).status, 400); assert.equal((await sA.apply(p, { file: 'vie-server.cjs' })).status, 400); assert.equal((await sA.apply(p, { confirm: 'true' })).status, 400); assert.equal((await sA.apply(p, { confirm: false })).status, 400);
    assert.equal(shaOf(h.root, WEB), before); assert.ok(!fs.existsSync(path.join(h.root, '.vie-backups')));
    const ok = await sA.apply(p); assert.equal(ok.status, 200, ok.text);
    assert.equal(read(h.root, 'app.js').includes('// alpha-X') && !read(h.root, 'app.js').includes('PWNED'), true);
  } finally { await h.done(); }
});
check('flux positif : approbation valide = UNE écriture exacte du contenu approuvé, sauvegarde de l’état précédent, annulation fournie ; autres fichiers inchangés ; journal sans contenu', async () => {
  const h = await boot();
  try {
    const s = await h.session(); const app0 = read(h.root, 'app.js'), others = ['index.html', 'styles.css', 'vie-assistant.js'], o0 = shaOf(h.root, others), prot0 = shaOf(h.root, PROTECTED);
    const [p] = await proposed(h, s, [edit('app.js', '// alpha-1', '// alpha-nouveau', 'raison')]);
    const r = await s.apply(p);
    assert.equal(r.status, 200, r.text); assert.equal(r.json.ok, true); assert.equal(r.json.file, 'app.js'); assert.equal(r.json.restart, false);
    assert.equal(read(h.root, 'app.js'), app0.replace('// alpha-1', '// alpha-nouveau'), 'seule la zone approuvée a changé');
    assert.equal(fs.readFileSync(path.join(h.root, '.vie-backups', r.json.backup), 'utf8'), app0, 'la sauvegarde contient l’ancien contenu exact');
    assert.ok(r.json.undo && r.json.undo.id && r.json.undo.nonce && /^[0-9a-f]{64}$/.test(r.json.undo.hash));
    assert.equal(shaOf(h.root, others), o0); assert.equal(shaOf(h.root, PROTECTED), prot0);
    const logs = JSON.stringify(h.logs); assert.ok(logs.includes('app.js') && !logs.includes('alpha-nouveau') && !logs.includes(p.nonce) && !logs.includes(r.json.undo.nonce));
    assert.ok(h.vie.server.listening, 'pas de redémarrage sans allowRestart');
  } finally { await h.done(); }
});
check('REJEU : la même approbation ne sert qu’une fois (409 approval_used), y compris après succès ; une approbation refusée pour fichier périmé est aussi consommée', async () => {
  const h = await boot();
  try {
    const s = await h.session();
    const [p] = await proposed(h, s, [edit('app.js', '// alpha-1', '// A1')]);
    assert.equal((await s.apply(p)).status, 200); const after = read(h.root, 'app.js');
    for (let i = 0; i < 3; i++) { const r = await s.apply(p); assert.equal(r.status, 409); assert.equal(r.json.error, 'approval_used'); }
    assert.equal(read(h.root, 'app.js'), after);
    // même contenu redemandé après coup : texte déjà absent → refusé dès la proposition
    const again = await s.ask([edit('app.js', '// alpha-1', '// A1')]); assert.deepEqual(again.json.proposals, []);
    // rejeu simultané : deux requêtes parallèles, une seule écriture
    const [q] = await proposed(h, s, [edit('app.js', '// beta-2', '// B2')]);
    const rs = await Promise.all([s.apply(q), s.apply(q), s.apply(q)]);
    assert.deepEqual(rs.map(r => r.status).sort(), [200, 409, 409]);
    assert.equal(read(h.root, 'app.js').split('// B2').length, 2, 'écrit une seule fois');
  } finally { await h.done(); }
});
check('PÉRIMÉ : fichier modifié depuis la proposition (même ailleurs dans le fichier, même d’un octet, ou supprimé) = 409 stale, rien n’est écrit, l’approbation est brûlée', async () => {
  const h = await boot();
  try {
    const s = await h.session();
    const [a, b, c] = await proposed(h, s, [edit('app.js', '// alpha-1', '// A'), edit('styles.css', '<!-- styles.css -->', '<!-- S -->'), edit('index.html', '<!-- index.html -->', '<!-- I -->')]);
    fs.appendFileSync(path.join(h.root, 'app.js'), '// ajout externe\n');                         // modification externe ailleurs dans le fichier
    fs.writeFileSync(path.join(h.root, 'styles.css'), '<!-- styles.css -->\n'.replace('\n', ' \n'));  // un octet de plus
    fs.rmSync(path.join(h.root, 'index.html'));                                                      // fichier supprimé
    const snap = shaOf(h.root, ['app.js', 'styles.css']);
    for (const p of [a, b]) { const r = await s.apply(p); assert.equal(r.status, 409); assert.equal(r.json.error, 'stale'); assert.equal((await s.apply(p)).json.error, 'approval_used'); }
    const rc = await s.apply(c); assert.ok([409, 500].includes(rc.status), rc.text); assert.ok(!fs.existsSync(path.join(h.root, 'index.html')));
    assert.equal(shaOf(h.root, ['app.js', 'styles.css']), snap); assert.ok(!fs.existsSync(path.join(h.root, '.vie-backups')) || fs.readdirSync(path.join(h.root, '.vie-backups')).length === 0);
  } finally { await h.done(); }
});
check('EXPIRATION : approbation refusée après 10 minutes (409 approval_expired), rien d’écrit ; l’annulation expire après 1 heure', async () => {
  const clock = { t: Date.parse('2026-11-14T10:00:00Z') };
  const h = await boot({ clock });
  try {
    const s = await h.session();
    const [p] = await proposed(h, s, [edit('app.js', '// alpha-1', '// E')]);
    clock.t += 600000 + 1000; const before = shaOf(h.root, WEB);
    const r = await s.apply(p); assert.equal(r.status, 409); assert.equal(r.json.error, 'approval_expired'); assert.equal(shaOf(h.root, WEB), before);
    const [q] = await proposed(h, s, [edit('app.js', '// alpha-1', '// E2')]);
    clock.t += 599000; const ok = await s.apply(q); assert.equal(ok.status, 200, ok.text);
    clock.t += 3600000 + 1000; const u = await s.undo(ok.json.undo); assert.equal(u.status, 409); assert.equal(u.json.error, 'approval_expired'); assert.ok(read(h.root, 'app.js').includes('// E2'));
  } finally { await h.done(); }
});

// === 5. Annulation ===========================================================================================================================================
check('annulation : approbation propre à usage unique, restaure l’octet près ; refusée si le fichier a changé depuis ; ne permet pas de rejouer la modification', async () => {
  const h = await boot();
  try {
    const s = await h.session(); const sB = await h.session(); const app0 = read(h.root, 'app.js');
    const [p] = await proposed(h, s, [edit('app.js', '// alpha-1', '// U1')]);
    const r = await s.apply(p); assert.equal(r.status, 200);
    // falsifications de l’annulation
    assert.equal((await s.undo(r.json.undo, { nonce: 'f'.repeat(20) })).json.error, 'approval_invalid');
    assert.equal((await s.undo(r.json.undo, { hash: 'f'.repeat(64) })).json.error, 'approval_invalid');
    assert.equal((await sB.undo(r.json.undo)).json.error, 'approval_invalid', 'autre session');
    assert.equal((await s.undo(p)).json.error, 'approval_invalid', 'l’approbation d’une modification n’est pas une annulation');
    assert.equal((await s.undo(r.json.undo, { confirm: undefined })).status, 400);
    assert.ok(read(h.root, 'app.js').includes('// U1'));
    const u = await s.undo(r.json.undo); assert.equal(u.status, 200, u.text); assert.equal(read(h.root, 'app.js'), app0);
    assert.equal((await s.undo(r.json.undo)).json.error, 'approval_used');
    assert.equal((await s.apply(p)).json.error, 'approval_used', 'l’annulation ne ressuscite pas l’approbation de la modification');
    assert.equal(read(h.root, 'app.js'), app0);
    // l’état annulé est conservé dans une sauvegarde « avant-annulation »
    assert.ok(fs.readdirSync(path.join(h.root, '.vie-backups')).some(n => n.includes('avant-annulation') && fs.readFileSync(path.join(h.root, '.vie-backups', n), 'utf8').includes('// U1')));
    // fichier modifié après la modification : annulation refusée (aucun écrasement)
    const [q] = await proposed(h, s, [edit('app.js', '// alpha-1', '// U2')]); const r2 = await s.apply(q); assert.equal(r2.status, 200);
    fs.appendFileSync(path.join(h.root, 'app.js'), '// travail ultérieur de l’utilisateur\n'); const mid = read(h.root, 'app.js');
    const bad = await s.undo(r2.json.undo); assert.equal(bad.status, 409); assert.equal(bad.json.error, 'stale'); assert.equal(read(h.root, 'app.js'), mid);
  } finally { await h.done(); }
});
check('annulation désactivée sans interrupteur ; sauvegarde altérée = annulation refusée ; redémarrage = toutes les approbations (modification ET annulation) invalides', async () => {
  const root = devRoot();
  const h = await boot({ root });
  const s = await h.session(); const [p] = await proposed(h, s, [edit('app.js', '// alpha-1', '// R1')]); const [q] = await proposed(h, s, [edit('styles.css', '<!-- styles.css -->', '<!-- R -->')]);
  const r = await s.apply(p); assert.equal(r.status, 200);
  fs.writeFileSync(path.join(root, '.vie-backups', r.json.backup), 'ALTÉRÉE');
  const t = await s.undo(r.json.undo); assert.equal(t.status, 400); assert.equal(t.json.error, 'code_refused'); assert.ok(read(root, 'app.js').includes('// R1'));
  const [p2] = await proposed(h, s, [edit('app.js', '// beta-2', '// R2')]); const r2 = await s.apply(p2); assert.equal(r2.status, 200);
  await h.vie.close();
  // « redémarrage » : nouvelle instance, même dossier, même environnement VIE_DEV=on
  const h2 = await boot({ root });
  try {
    const s2 = await h2.session(); const before = shaOf(root, WEB);
    for (const sess of [s, s2]) {
      assert.equal((await s2.apply(q)).json.error, 'approval_invalid'); assert.equal((await s2.undo(r2.json.undo)).json.error, 'approval_invalid');
      void sess;
    }
    assert.equal(shaOf(root, WEB), before);
  } finally { await h2.done(); }
});

// === 6. Propositions multiples sur un même fichier =============================================================================================================
check('plusieurs modifications du même fichier : les zones disjointes se suivent (même contenu approuvé, jamais élargi) ; zones qui se chevauchent ou état externe : périmé', async () => {
  const h = await boot();
  try {
    const s = await h.session(); const app0 = read(h.root, 'app.js');
    const [a, b] = await proposed(h, s, [edit('app.js', '// alpha-1', '// alpha-Z'), edit('app.js', '// beta-2', '// beta-Z')]);
    assert.equal((await s.apply(a)).status, 200); assert.equal((await s.apply(b)).status, 200, 'sœur non chevauchante : suit le nouvel état');
    assert.equal(read(h.root, 'app.js'), app0.replace('// alpha-1', '// alpha-Z').replace('// beta-2', '// beta-Z'));
    const [c, d] = await proposed(h, s, [edit('app.js', '// alpha-Z', '// α'), edit('app.js', 'alpha-Z\n// beta', 'XX')]);
    assert.equal((await s.apply(c)).status, 200); const r = await s.apply(d); assert.equal(r.status, 409); assert.equal(r.json.error, 'stale', 'zone chevauchante : jamais rebasée');
    // modification externe entre l’approbation de la première et de la seconde : la seconde reste valable seulement si l’état précédent était le même au moment de l’écriture de la première
    const [e, f] = await proposed(h, s, [edit('app.js', '// α', '// 1'), edit('app.js', '// beta-Z', '// 2')]);
    fs.appendFileSync(path.join(h.root, 'app.js'), '// externe\n');
    assert.equal((await s.apply(e)).json.error, 'stale'); assert.equal((await s.apply(f)).json.error, 'stale');
  } finally { await h.done(); }
});

check('une approbation émise sur un ancien état n’est JAMAIS rattrapée par l’écriture d’une autre : modification externe, nouvelle proposition, application, puis l’ancienne = périmée', async () => {
  const h = await boot();
  try {
    const s = await h.session();
    const [old1] = await proposed(h, s, [edit('app.js', '// alpha-1', '// ancienne')]);          // état S0
    fs.appendFileSync(path.join(h.root, 'app.js'), '// travail de l’utilisateur\n');            // état S0' (modification externe)
    const [fresh] = await proposed(h, s, [edit('app.js', '// beta-2', '// nouvelle')]);          // état S0'
    assert.equal((await s.apply(fresh)).status, 200);
    const r = await s.apply(old1); assert.equal(r.status, 409); assert.equal(r.json.error, 'stale');
    assert.ok(!read(h.root, 'app.js').includes('// ancienne') && read(h.root, 'app.js').includes('// travail de l’utilisateur'));
  } finally { await h.done(); }
});
check('portail seul (sans serveur) : désactivé = dev_disabled pour proposer, appliquer et annuler, quel que soit le contenu', () => {
  const root = devRoot();
  try {
    const gate = D.createCodeGate({ root, enabled: false });
    assert.equal(gate.enabled, false);
    assert.equal(gate.issue('sid', { file: 'app.js', old: '// alpha-1', new: 'x' }).code, 'dev_disabled');
    const b = { id: 'a'.repeat(10), nonce: 'b'.repeat(20), hash: 'c'.repeat(64), confirm: true };
    assert.equal(gate.apply('sid', b).code, 'dev_disabled'); assert.equal(gate.undo('sid', b).code, 'dev_disabled');
    assert.equal(D.createCodeGate({ root }).enabled, false, 'désactivé si rien n’est précisé'); assert.equal(D.createCodeGate({ root, enabled: 'on' }).enabled, false, 'seul le booléen true active');
    assert.ok(!fs.existsSync(path.join(root, '.vie-backups')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// === 7. Validation par sous-processus ============================================================================================================================
check('P1 revue rouge : core.js et vie-actions.js (require()s par le SERVEUR, qui détient la clé) ne sont PAS modifiables ; aucun fichier modifiable n’est chargé par le serveur ; aucun redémarrage ni contrôle de chargement ne reste atteignable', async () => {
  const src = fs.readFileSync(path.join(__dirname, 'vie-server.cjs'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const required = [...src.matchAll(/require\('\.\/([^']+)'\)/g)].map(m => m[1]);
  assert.ok(required.includes('core.js') && required.includes('vie-actions.js'), 'le serveur charge bien core.js et vie-actions.js');
  for (const f of D.DEV_FILES) assert.ok(!required.includes(f), f + ' est modifiable ET chargé par le serveur : interdit');
  const dev = fs.readFileSync(path.join(__dirname, 'vie-dev.cjs'), 'utf8');
  assert.match(dev, /const SERVER_LOADED = \[\];/, 'aucun fichier modifiable n’est chargé par le serveur');
  const h = await boot();
  try {
    const s = await h.session(); const prot0 = shaOf(h.root, PROTECTED);
    for (const f of ['core.js', 'vie-actions.js']) {
      const r = await s.ask([edit(f, "module.exports = { name: '" + f + "' };", "require('node:fs'); module.exports = {};")]);
      assert.equal(r.status, 200); assert.deepEqual(r.json.proposals, [], f + ' : aucune proposition'); assert.equal(r.json.rejected.length, 1, f + ' : refusé');
    }
    assert.equal(shaOf(h.root, PROTECTED), prot0); assert.ok(!fs.existsSync(path.join(h.root, '.vie-backups')));
    // au niveau du portail seul : même refus, et l'approbation d'une proposition inexistante ne fait rien
    const gate = D.createCodeGate({ root: h.root, enabled: true });
    for (const f of ['core.js', 'vie-actions.js']) assert.equal(gate.issue('sid', { file: f, old: 'x', new: 'y' }).ok, false, f + ' refusé par le portail');
    const g2 = gate.issue('sid', { file: 'app.js', old: '// beta-2', new: '// b3' });
    assert.equal(gate.apply('sid', { id: g2.proposal.id, nonce: g2.proposal.nonce, hash: g2.proposal.hash, confirm: true }).restart, false);
  } finally { await h.done(); }
});
check('portail : écritures strictement limitées aux 4 fichiers web et à .vie-backups ; aucune lecture de .env / clé dans vie-dev.cjs ; le serveur reste sans child_process', () => {
  const dev = fs.readFileSync(path.join(__dirname, 'vie-dev.cjs'), 'utf8');
  assert.ok(!/\.env|ANTHROPIC|process\.env/.test(dev.replace(/^\s*\/\/.*$/gm, '')), 'vie-dev.cjs ne touche ni .env ni clé ni environnement');
  assert.equal((dev.match(/writeFileSync\(/g) || []).length, 2, 'deux écritures seulement : le fichier web (liste blanche contrôlée) et la sauvegarde');
  assert.match(dev, /const writeTarget = \(f, text\) => \{ if \(!okFile\(f\)\) throw/);
  assert.ok(!/child_process|spawn/.test(fs.readFileSync(path.join(__dirname, 'vie-server.cjs'), 'utf8')));
  assert.ok(!/restart[^\n]*VIE_DEV|VIE_DEV[^\n]*restart/i.test(dev.replace(/^\s*\/\/.*$/gm, '')), 'le relais de redémarrage ne force jamais VIE_DEV');
  const d = require('./vie-dev.cjs'); assert.equal(typeof d.applyEdit, 'undefined', 'plus aucune fonction d’écriture directe exportée');
});

(async () => {
  let failed = 0;
  for (const t of results) {
    try { await t.fn(); console.log('PASS  ' + t.name); } catch (e) { failed++; console.log('FAIL  ' + t.name + '\n      ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n      ')); }
  }
  console.log(`\n${results.length - failed}/${results.length} PASS${failed ? `, ${failed} FAIL` : ''}`);
  process.exit(failed ? 1 : 0);
})();
