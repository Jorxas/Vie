// Politique Unicode du code proposé (mode structure) : serveur (vie-dev.cjs) ET panneau (vie-assistant.js) refusent TOUT caractère invisible / ambigu, sans « nettoyage » silencieux.
// Hors ligne, sans réseau, sans fichier secret : fonctions pures + extraction du bloc de politique du panneau dans un contexte vm isolé.
//   node test_vie_unicode.cjs
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const D = require('./vie-dev.cjs');

const results = [];
const check = (name, fn) => results.push({ name, fn });
const cp = n => String.fromCodePoint(n);
const hex = n => 'U+' + n.toString(16).toUpperCase().padStart(4, '0');

// --- le panneau : le bloc délimité par les marqueurs est exécuté tel quel, sans DOM ---
const ui = fs.readFileSync(path.join(__dirname, 'vie-assistant.js'), 'utf8');
const a = ui.indexOf('/*UNICODE-POLICY-BEGIN*/'), b = ui.indexOf('/*UNICODE-POLICY-END*/');
assert.ok(a >= 0 && b > a, 'bloc de politique du panneau introuvable');
const U = vm.runInNewContext(ui.slice(a, b) + '\n({ hiddenFirst, hasHidden, hidCp, cpLab, HID_RANGES })', {});

// Les deux politiques (serveur / panneau) donnent le même verdict sur un texte.
const both = t => { const s = D.findHidden(t), p = U.hiddenFirst(t); assert.equal(s === null, p === null, `verdict différent serveur/panneau pour ${JSON.stringify(t)}`); if (s) assert.equal(s.cp, p.cp); return s; };

// Oracle INDÉPENDANT de l'implémentation : n'est visible que ce qui est lettre, marque, chiffre, ponctuation ou symbole, hors Default_Ignorable, hors non-caractères,
// hors braille vide U+2800, U+FFFC (objet : emplacement invisible) et U+FFFD (caractère de remplacement : signe d'un texte déjà abîmé) ; plus l'espace ASCII, la tabulation et LF.
const VISIBLE_RE = /^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u, DI_RE = /^\p{Default_Ignorable_Code_Point}$/u;
const oracleVisible = n => {
  if (n === 9 || n === 10 || n === 32) return true;
  if (n === 0x2800 || n === 0xFFFD || n === 0xFFFC || (n & 0xFFFE) === 0xFFFE || (n >= 0xFDD0 && n <= 0xFDEF)) return false;
  if (n >= 0xD800 && n <= 0xDFFF) return false;
  const ch = cp(n);
  return VISIBLE_RE.test(ch) && !DI_RE.test(ch);
};

check('exhaustif : les 1 114 112 points de code, serveur == panneau == oracle (visible ou refusé)', () => {
  const bad = [];
  for (let n = 0; n <= 0x10FFFF; n++) {
    const t = cp(n), s = D.findHidden(t), p = U.hiddenFirst(t), v = oracleVisible(n);
    if (n === 13) { if (!s || !p) bad.push('CR seul accepté'); continue; }
    if ((s === null) !== v || (p === null) !== v) bad.push(`${hex(n)} serveur=${s === null ? 'ok' : 'refusé'} panneau=${p === null ? 'ok' : 'refusé'} oracle=${v ? 'ok' : 'refusé'}`);
    if (bad.length > 20) break;
  }
  assert.deepEqual(bad, []);
});
check('exhaustif : tout Default_Ignorable_Code_Point, toute catégorie Cf / Cc (sauf TAB LF) / Zs (sauf espace) / Zl / Zp / Co / Cs est refusé, jamais accepté par l’un ou l’autre', () => {
  let n = 0;
  for (let c = 0; c <= 0x10FFFF; c++) {
    const ch = cp(c);
    const should = DI_RE.test(ch) || /^[\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cs}]$/u.test(ch) || (/^[\p{Cc}\p{Zs}]$/u.test(ch) && c !== 9 && c !== 10 && c !== 32);
    if (should) { n++; assert.notEqual(D.findHidden(ch), null, hex(c) + ' accepté par le serveur'); assert.notEqual(U.hiddenFirst(ch), null, hex(c) + ' accepté par le panneau'); }
  }
  assert.ok(n > 4000, 'couverture : ' + n);
});
check('les plages explicites seules (indépendantes de la version d’Unicode du moteur) couvrent déjà tous les Default_Ignorable_Code_Point', () => {
  const inRanges = c => D.HIDDEN_RANGES.some(([x, y]) => c >= x && c <= y), inUi = c => U.HID_RANGES.some(r => c >= r[0] && c <= r[1]);
  for (let c = 0; c <= 0x10FFFF; c++) if (DI_RE.test(cp(c))) { assert.ok(inRanges(c), 'serveur : plage manquante ' + hex(c)); assert.ok(inUi(c), 'panneau : plage manquante ' + hex(c)); }
});

const NEG = {
  'U+180F sélecteur de variante mongol (signalé par l’audit)': '᠏', 'U+FE0F sélecteur emoji (signalé par l’audit)': '️',
  'U+180B': '᠋', 'U+180C': '᠌', 'U+180D': '᠍', 'U+180E séparateur de voyelle mongol': '᠎',
  'VS-1 U+FE00': '︀', 'VS-15 U+FE0E': '︎', 'VS-17 U+E0100': cp(0xE0100), 'VS-256 U+E01EF': cp(0xE01EF),
  'balise U+E0041': cp(0xE0041), 'annulation de balise U+E007F': cp(0xE007F),
  'largeur nulle U+200B': '​', 'ZWNJ U+200C': '‌', 'ZWJ U+200D': '‍', 'WORD JOINER U+2060': '⁠', 'U+2061-2064': '⁣', 'BOM U+FEFF': '﻿',
  'trait d’union conditionnel U+00AD': '­', 'CGJ U+034F': '͏', 'filler hangul U+3164': 'ㅤ', 'filler U+FFA0': 'ﾠ', 'U+115F': 'ᅟ', 'U+1160': 'ᅠ', 'khmer U+17B4': '឴', 'khmer U+17B5': '឵',
  'bidi LRM U+200E': '‎', 'bidi RLM U+200F': '‏', 'ALM U+061C': '؜', 'LRE U+202A': '‪', 'RLE U+202B': '‫', 'PDF U+202C': '‬', 'LRO U+202D': '‭', 'RLO U+202E': '‮', 'LRI U+2066': '⁦', 'RLI U+2067': '⁧', 'FSI U+2068': '⁨', 'PDI U+2069': '⁩',
  'séparateur de ligne U+2028': ' ', 'séparateur de paragraphe U+2029': ' ', 'NEL U+0085': '\u0085',
  'espace insécable U+00A0': ' ', 'espace ogham U+1680': ' ', 'demi-cadratin U+2002': ' ', 'fine U+2009': ' ', 'U+200A': ' ', 'fine insécable étroite U+202F': ' ', 'moyenne U+205F': ' ', 'idéographique U+3000': '　', 'braille vide U+2800': '⠀',
  'contrôle NUL': '\u0000', 'ESC': '\u001B', 'BEL': '\u0007', 'DEL': '\u007F', 'FF': '\u000C', 'VT': '\u000B', 'C1 U+009F': '\u009F', 'CR seul': '\r', 'CR en fin de texte': 'a\r',
  'substitut isolé haut': '\uD800', 'substitut isolé bas': '\uDC00', 'usage privé U+E000': '', 'non-caractère U+FFFF': '￿', 'non-caractère U+FDD0': '﷐', 'non attribué U+0378': '͸', 'U+FFFD': '�', 'objet U+FFFC': '￼',
  'format Arabe U+0600': '؀', 'sténographie U+1BCA0': cp(0x1BCA0), 'musique U+1D173': cp(0x1D173), 'plan 15 usage privé': cp(0xF0000),
};
check('négatifs : chaque caractère invisible / ambigu est refusé seul, entre deux lettres, dans un identifiant JS, en tête et en queue (serveur ET panneau), avec code Unicode dans le message', () => {
  for (const [name, ch] of Object.entries(NEG)) {
    for (const t of [ch, 'a' + ch + 'b', 'const total' + ch + ' = 1;', ch + 'x', 'x' + ch, '// ok\r\n' + ch + '\r\n']) {
      const h = both(t); assert.ok(h, `${name} accepté dans ${JSON.stringify(t)}`);
    }
    const c = ch.codePointAt(0), h = D.findHidden('xx' + ch);
    if (ch !== '\r' && !/^a/.test(ch)) { assert.equal(h.index, 2, name); const m = D.checkEdit('/nonexistent', { file: 'app.js', old: 'x', new: 'xx' + ch }); assert.equal(m.ok, false); assert.ok(m.error.includes(U.cpLab(c)) && m.error.includes('position 2') && m.error.includes('nouveau texte'), name + ' : message ' + m.error); }
  }
});
check('négatif central de l’audit : deux identifiants qui s’affichent pareil (a / a+U+180F, b / b+U+FE0F) ne passent plus ; la valeur d’origine du défaut est refusée par les deux', () => {
  for (const [vis, ghost] of [['const total = 1;', 'const total᠏ = 1;'], ['let ok = true;', 'let ok️ = true;'], ['x.valeur', 'x.valeur️'], ['"a"', '"️a"']]) {
    assert.equal(both(vis), null); assert.notEqual(both(ghost), null, JSON.stringify(ghost));
  }
});
check('emoji : « normaux » sans sélecteur / ZWJ passent intacts ; sélecteur emoji FE0F, séquences ZWJ et keycaps sont REFUSÉS explicitement (jamais nettoyés)', () => {
  const OK = ['🙂', '😀', '👍🏽', '🇫🇷', '🎉 Fête !', '✔', '⚠', '→ ← ↑', '©', '€ £ ¥'];
  for (const t of OK) assert.equal(both(t), null, t);
  const REFUSED = ['⚠️', '❤️', '✔️', '1️⃣', '👨‍👩‍👧', '🏳️‍🌈', '☺️', 'x️'];
  for (const t of REFUSED) { const h = both(t); assert.ok(h, t); assert.ok(h.cp === 0xFE0F || h.cp === 0x200D); }
});
check('positifs : texte visible FR / DE / typographique / CJK / code ordinaire accepté tel quel (sans transformation), CRLF légitime, tabulation, LF, espace', () => {
  const OK = [
    'const message = "Ça marche à merveille, où êtes-vous ? Naïve œuvre.";', 'Größe, Straße, Übung, Ärger, ÖL, ẞ, ß, ü, ö, ä', 'Écoute l’« histoire » — 12 € / 3,5 %…', 'çà œ Œ æ ÿ Ÿ ñ',
    'function f(a, b) {\r\n\treturn a + b; // ok\r\n}\r\n', 'a\nb\n\n\tc  d', '日本語のテキスト, 中文, 한국어', 'Привет, мир', '/* — – ‑ ‘ ’ “ ” … */', '𝒳 𝔘', '', ' ',
    'é', 'é', // e + accent combinant (visible) et é précomposé
  ];
  for (const t of OK) assert.equal(both(t), null, JSON.stringify(t));
  // pas de nettoyage : une proposition acceptée garde exactement ses caractères (vérifié bout en bout dans test_vie_code.cjs)
  for (const t of OK) assert.equal(D.findHidden(t), null);
});
check('CR : accepté UNIQUEMENT dans CR+LF ; \\n\\r, CR doublé, CR en fin ou avant un autre caractère = refusé', () => {
  assert.equal(both('a\r\nb'), null); assert.equal(both('\r\n'), null); assert.equal(both('a\r\n\r\nb'), null);
  for (const t of ['a\rb', 'a\r', '\r', '\n\rb', 'a\r\r\nb', 'a\r \nb']) assert.notEqual(both(t), null, JSON.stringify(t));
});
check('findHidden : position en unités UTF-16 exacte après un emoji hors plan 0, nature du caractère annoncée', () => {
  const h = D.findHidden('🙂᠏'); assert.deepEqual([h.cp, h.index, h.kind], [0x180F, 2, 'sélecteur de variante']);
  assert.equal(D.findHidden('a‮b').kind, 'marque bidirectionnelle'); assert.equal(D.findHidden('a b').kind, 'espace spécial'); assert.equal(D.findHidden('a​b').kind, 'caractère invisible ou ambigu');
  assert.equal(D.findHidden('a\u0001b').kind, 'caractère de contrôle'); assert.equal(D.findHidden(cp(0xE0041)).kind, 'caractère de balise');
});
check('raison (affichée dans la carte) : même politique ; texte de raison avec fins de ligne normales accepté', () => {
  const edit = reason => D.checkEdit('/nonexistent', { file: 'app.js', old: 'x', new: 'y', reason });
  assert.notEqual(edit('ok‮cache').error, undefined); assert.match(edit('ok‮cache').error, /raison/);
  assert.match(edit('a᠏b').error, /U\+180F/); assert.match(edit(42).error, /raison invalide/);
  assert.doesNotMatch(String(edit('Ajoute un champ.\r\nPuis un autre.').error), /raison/);
});
check('les deux politiques partagent les mêmes plages explicites (aucune dérive entre vie-dev.cjs et vie-assistant.js)', () => {
  assert.equal(JSON.stringify(U.HID_RANGES), JSON.stringify(D.HIDDEN_RANGES));
});

(async () => {
  let pass = 0;
  for (const c of results) {
    try { await c.fn(); pass++; console.log('PASS ', c.name); }
    catch (e) { console.log('FAIL ', c.name, '\n      ', String(e && e.stack || e).split('\n').slice(0, 6).join('\n       ')); }
  }
  console.log(`\n${pass}/${results.length} tests`);
  process.exit(pass === results.length ? 0 : 1);
})();
