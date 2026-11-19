// Tests hors ligne : import malveillant, stockage fail-closed, planification. Aucun réseau, aucune API.
const assert = require('node:assert/strict');
const C = require('./core.js');
const urspruenglicherStart=C.seed; C.seed=()=>{const s=urspruenglicherStart();s.settings.workShifts=[{day:0,start:'09:00',end:'12:00',confirmed:false},{day:1,start:'10:00',end:'13:00',confirmed:false},{day:2,start:'13:00',end:'15:00',confirmed:false}];return s;}; // Rein synthetische Eingaben dieser Tests


const KEY = 'vie-personal-v1';

// Stockage factice contrôlable : permet de simuler corruption, échec setItem et écriture silencieusement perdue.
function fakeStorage(initial = null, mode = 'ok') {
  const map = new Map(initial === null ? [] : [[KEY, initial]]);
  return {
    map,
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      if (mode === 'throw') throw Object.assign(Error('QuotaExceededError'), { name: 'QuotaExceededError' });
      if (mode === 'silent') return;
      map.set(k, String(v));
    },
    removeItem: k => map.delete(k),
  };
}

function rejectsCleanly(payload, label) {
  const text = JSON.stringify(payload);
  let caught = null;
  try { C.validateImported(JSON.parse(text)); } catch (err) { caught = err; }
  assert.ok(caught, `${label} : aurait dû être refusé`);
  assert.ok(!(caught instanceof TypeError), `${label} : TypeError non géré`);
  assert.ok(caught.message.length < 300, `${label} : message trop long`);
  return caught.message;
}

const base = () => JSON.parse(JSON.stringify(C.seed()));

// --- 1. Import : rejets propres -------------------------------------------------
{
  const t = base(); t.tasks = [null];
  rejectsCleanly(t, 'tasks:[null]');

  const w = base(); w.settings.workShifts = null;
  rejectsCleanly(w, 'workShifts:null');

  const s = base(); s.settings.sleepHours = '<img src=x onerror=alert(1)>';
  rejectsCleanly(s, 'sleepHours HTML');

  const s2 = base(); s2.settings.sleepHours = '8';
  rejectsCleanly(s2, 'sleepHours chaîne numérique');

  const c = base(); c.settings.courseBlocks = [{ title: 'X', day: 9, start: '07:00', end: '08:00' }];
  rejectsCleanly(c, 'jour de cours hors plage');

  const d = base(); d.tasks[0].date = '2026-02-30';
  rejectsCleanly(d, 'date impossible');

  const p = base(); p.projects = 'pas une liste';
  rejectsCleanly(p, 'projects de type texte');

  // JSON.parse crée une vraie clé propre « __proto__ » : elle doit être refusée avant toute copie.
  const protoRaw = JSON.stringify(base()).replace('"tasks":[{', '"tasks":[{"__proto__":{"x":1},');
  assert.ok(JSON.parse(protoRaw).tasks[0].hasOwnProperty('__proto__'), 'clé __proto__ bien présente après parse');
  assert.throws(() => C.validateImported(JSON.parse(protoRaw)), /clé interdite/);
  assert.equal({}.x, undefined, 'aucune pollution du prototype global');

  const xss = base(); xss.tasks[0].title = '<img src=x onerror=alert(1)>';
  const ok = C.validateImported(JSON.parse(JSON.stringify(xss)));
  assert.equal(ok.tasks[0].title, '<img src=x onerror=alert(1)>', 'le texte est accepté puis échappé côté UI');

  const nulls = ['courses', 'applications', 'habits', 'transactions', 'projects', 'ideas', 'goals', 'events', 'review'];
  for (const key of nulls) {
    const x = base(); x[key] = [null];
    rejectsCleanly(x, `${key}:[null]`);
  }
  const badVersion = base(); badVersion.version = 2;
  assert.throws(() => C.validateImported(badVersion), /version/i);
}

// --- 2. Roundtrip seed et backups valides ---------------------------------------
{
  const seed = C.seed();
  const back = C.validateImported(JSON.parse(JSON.stringify(seed)));
  assert.deepEqual(back.tasks.map(t => t.id), seed.tasks.map(t => t.id));
  assert.equal(back.projects.length, 10);
  assert.equal(back.settings.sleepHours, 8);
  const extra = base(); extra.inconnu = { dangereux: '<b>' };
  assert.doesNotThrow(() => C.validateImported(extra), 'clé de premier niveau inconnue tolérée et ignorée');
  assert.equal(Object.prototype.hasOwnProperty.call(C.validateImported(extra), 'inconnu'), false);
}

// --- 3. Stockage : corruption jamais écrasée à la première saisie ---------------
{
  const corrupt = '{"version":1,"tasks":[null';
  const st = fakeStorage(corrupt);
  const loaded = C.loadStored(st, KEY);
  assert.equal(loaded.locked, true, 'JSON cassé => verrouillé');
  assert.equal(loaded.raw, corrupt, 'texte brut conservé pour récupération');
  const attempt = C.saveStored(st, KEY, loaded.state, loaded.locked);
  assert.equal(attempt.ok, false, 'aucune écriture en mode récupération');
  assert.equal(st.map.get(KEY), corrupt, 'sauvegarde corrompue intacte après une saisie');

  const bad = fakeStorage(JSON.stringify({ ...C.seed(), tasks: [null] }));
  assert.equal(C.loadStored(bad, KEY).locked, true, 'schéma invalide => verrouillé');

  const unreadable = { getItem() { throw Error('SecurityError'); }, setItem() {} };
  assert.equal(C.loadStored(unreadable, KEY).locked, true, 'lecture refusée => verrouillé');
  assert.equal(C.loadStored(null, KEY).locked, true, 'pas de stockage => verrouillé');
}

// --- 4. Copie de secours avant réinitialisation explicite ----------------------
{
  const corrupt = '{"broken":';
  const st = fakeStorage(corrupt);
  const arc = C.archiveCorrupt(st, KEY, corrupt, 'test1');
  assert.equal(arc.ok, true);
  assert.equal(st.map.get(arc.key), corrupt, 'copie brute identique sous clé séparée');
  assert.equal(C.saveStored(st, KEY, C.seed(), false).ok, true, 'réinitialisation explicite possible après copie');
  assert.equal(C.loadStored(st, KEY).locked, false, 'après réinitialisation : déverrouillé');
  const noCopy = fakeStorage(corrupt, 'throw');
  assert.equal(C.archiveCorrupt(noCopy, KEY, corrupt, 's').ok, false, 'copie impossible => pas d’effacement');
}

// --- 5. setItem en échec : aucune fausse confirmation ---------------------------
{
  const good = JSON.stringify(C.seed());
  const thrown = fakeStorage(good, 'throw');
  const r1 = C.saveStored(thrown, KEY, C.seed(), false);
  assert.equal(r1.ok, false, 'setItem qui lance une exception => échec signalé');
  assert.ok(r1.reason.length > 0);
  assert.equal(thrown.map.get(KEY), good, 'valeur précédente conservée');

  const silent = fakeStorage(good, 'silent');
  const changed = C.seed(); changed.settings.displayName = 'Autre';
  assert.equal(C.saveStored(silent, KEY, changed, false).ok, false, 'écriture perdue détectée par relecture');

  const invalid = fakeStorage(good);
  const broken = C.seed(); broken.tasks.push(null);
  assert.equal(C.saveStored(invalid, KEY, broken, false).ok, false, 'état invalide jamais écrit');
  assert.equal(invalid.map.get(KEY), good);

  const okStore = fakeStorage(null);
  assert.equal(C.saveStored(okStore, KEY, C.seed(), false).ok, true, 'écriture réussie vérifiée');
}

// --- 6. Planification : durée 480, pas de troncature à 180 ----------------------
{
  const day = '2026-11-11'; // mercredi, semaine du 9 novembre 2026
  for (const dur of [480, 240, 15]) {
    const st = C.seed();
    st.tasks = [{ id: 'long', title: 'Tâche longue ' + dur, projectId: '', category: 'study', priority: 'normale', duration: dur, date: day, done: false, origin: 'manuel', notes: '' }];
    const plan = C.buildWeekPlan(st, '2026-11-10');
    const dayPlan = plan.days.find(d => d.date === day);
    const block = dayPlan.blocks.find(b => b.name === 'Tâche longue ' + dur);
    const unsched = plan.unscheduled.find(u => u.title === 'Tâche longue ' + dur);
    assert.ok(block || unsched, `durée ${dur} : ni planifiée ni signalée`);
    if (block) assert.equal(block.end - block.start, dur, `durée ${dur} tronquée à ${block.end - block.start}`);
    if (unsched) assert.ok(unsched.reason.length > 0, 'raison explicite');
    assert.equal(plan.days.flatMap(d => d.blocks).some(b => b.name === 'Tâche longue ' + dur && b.end - b.start === 180), false, 'jamais 180 min');
  }
  const st = C.seed();
  st.tasks = [{ id: 'hors', title: 'Trop long', projectId: '', category: 'study', priority: 'normale', duration: 500, date: day, done: false, origin: 'manuel', notes: '' }];
  const plan = C.buildWeekPlan(st, '2026-11-10');
  assert.ok(plan.unscheduled.some(u => u.title === 'Trop long' && /15–480/.test(u.reason)), 'durée 500 explicitement non planifiée');
  assert.equal(plan.days.flatMap(d => d.blocks).some(b => b.name === 'Trop long'), false);
}

// --- 7. Blocs fixes chevauchants : tous visibles, avec conflit ------------------
{
  const st = C.seed();
  st.settings.courseBlocks.push({ title: 'Cours jeudi', day: 3, start: '07:00', end: '08:00' });
  const plan = C.buildWeekPlan(st, '2026-11-10');
  const thu = plan.days[3].blocks;
  const sleep = thu.find(b => b.kind === 'sleep');
  const course = thu.find(b => b.name === 'Cours jeudi');
  assert.ok(sleep, 'sommeil du jeudi conservé malgré le cours');
  assert.equal(sleep.start, 0);
  assert.equal(sleep.end, 480, 'durée de sommeil inchangée');
  assert.ok(course, 'cours visible');
  assert.equal(course.conflict, true, 'cours marqué en conflit');
  assert.equal(sleep.conflict, true, 'sommeil marqué en conflit');
  assert.ok(plan.conflicts.some(x => x.includes('Jeudi') && x.includes('Cours jeudi')), 'conflit listé');

  // Une tâche ne peut jamais réserver un créneau déjà couvert par un bloc fixe.
  for (const day of plan.days) {
    const fixed = day.blocks.filter(b => b.fixed);
    for (const b of day.blocks.filter(x => !x.fixed)) {
      for (const f of fixed) {
        assert.equal(b.start < f.end && b.end > f.start, false, `${day.name} : ${b.name} recouvre ${f.name}`);
      }
    }
  }

  const clean = C.buildWeekPlan(C.seed(), '2026-11-10');
  assert.equal(clean.conflicts.length, 0, 'semaine standard sans conflit');
}

// --- 8. Roundtrip de planification après import ---------------------------------
{
  const a = C.buildWeekPlan(C.seed(), '2026-11-10');
  const b = C.buildWeekPlan(C.validateImported(JSON.parse(JSON.stringify(C.seed()))), '2026-11-10');
  const names = p => p.days.map(d => d.blocks.map(x => `${x.start}-${x.end}:${x.name}`).join('|'));
  assert.deepEqual(names(b), names(a), 'même plan après roundtrip');
}

// =====================================================================================
// Correctifs après l'audit indépendant Codex (P1 #1, #2, #3 et P2 sommeil)
// =====================================================================================
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const SRC = f => fs.readFileSync(path.join(__dirname, f), 'utf8');
const toMin = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const rawOf = state => JSON.stringify(C.validateImported(JSON.parse(JSON.stringify(state))));

// Stockage factice scriptable : files d'effets pour les prochains appels, puis valeur par défaut.
//   setPlan / setDefault : 'ok' | 'throw' (rien écrit) | 'silent' (ignoré) | 'write-then-throw' (écrit puis lève)
//   getPlan / getDefault : 'ok' | 'throw'
function scriptedStorage(initial = null) {
  const map = new Map(initial === null ? [] : [[KEY, initial]]);
  const st = {
    map, log: [], setPlan: [], getPlan: [], setDefault: 'ok', getDefault: 'ok',
    sets: () => st.log.filter(x => x.startsWith('set:')).length,
    getItem(k) {
      const b = st.getPlan.length ? st.getPlan.shift() : st.getDefault;
      st.log.push('get:' + b);
      if (b === 'throw') throw Object.assign(Error('SecurityError'), { name: 'SecurityError' });
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      const b = st.setPlan.length ? st.setPlan.shift() : st.setDefault;
      st.log.push('set:' + b);
      if (b === 'throw') throw Object.assign(Error('QuotaExceededError'), { name: 'QuotaExceededError' });
      if (b === 'silent') return;
      map.set(k, String(v));
      if (b === 'write-then-throw') throw Object.assign(Error('UnknownError'), { name: 'UnknownError' });
    },
    removeItem(k) { st.log.push('remove'); map.delete(k); },
  };
  return st;
}

// --- 9. P1 #1 : tout intervalle fixe est validé à l'import (jour, HH:MM, fin > début) -------------
{
  const INTERVAL = /Intervalle invalide/;
  const bad = (mutate, label, re) => { const x = base(); mutate(x); const msg = rejectsCleanly(x, label); if (re) assert.match(msg, re, label); return msg; };

  bad(x => { x.settings.workShifts = [{ day: 1, start: '09:00', end: '09:00', confirmed: true }]; }, 'travail : fin = début', INTERVAL);
  bad(x => { x.settings.workShifts = [{ day: 1, start: '17:00', end: '09:00', confirmed: true }]; }, 'travail : fin < début', INTERVAL);
  bad(x => { x.settings.workShifts = [{ day: 4, start: '22:00', end: '06:00', confirmed: false }]; }, 'travail de nuit 22:00–06:00', /scindé sur deux jours/);
  bad(x => { x.settings.courseBlocks = [{ title: 'Nuit', day: 2, start: '10:00', end: '10:00' }]; }, 'cours : fin = début', INTERVAL);
  bad(x => { x.settings.courseBlocks = [{ title: 'Inversé', day: 2, start: '14:00', end: '11:00' }]; }, 'cours : fin < début', INTERVAL);
  bad(x => { x.settings.courseBlocks = [{ day: 5, start: '23:00', end: '01:00' }]; }, 'cours de nuit sans titre', INTERVAL);
  const second = bad(x => { x.settings.workShifts = [{ day: 0, start: '05:00', end: '07:00', confirmed: true }, { day: 1, start: '18:00', end: '08:00' }]; }, 'deuxième horaire invalide', /workShifts\[1\]/);
  assert.ok(second.length < 300);

  const malformed = [
    ['heure 24:00', { day: 0, start: '24:00', end: '25:00' }],
    ['heure sans zéro', { day: 0, start: '9:00', end: '10:00' }],
    ['minutes 60', { day: 0, start: '07:60', end: '08:30' }],
    ['texte', { day: 0, start: 'abc', end: '10:00' }],
    ['nombre à la place de HH:MM', { day: 0, start: 900, end: 1000 }],
    ['fin manquante', { day: 0, start: '08:00' }],
    ['début manquant', { day: 0, end: '09:00' }],
    ['jour -1', { day: -1, start: '08:00', end: '09:00' }],
    ['jour 7', { day: 7, start: '08:00', end: '09:00' }],
    ['jour 1.5', { day: 1.5, start: '08:00', end: '09:00' }],
    ['jour chaîne', { day: '1', start: '08:00', end: '09:00' }],
    ['jour manquant', { start: '08:00', end: '09:00' }],
    ['élément null', null],
  ];
  for (const [label, item] of malformed) {
    bad(x => { x.settings.workShifts = [item]; }, 'travail / ' + label);
    bad(x => { x.settings.courseBlocks = [item]; }, 'cours / ' + label);
  }

  // Données V1 valides : conservées à l'identique, bornes comprises.
  const good = base();
  good.settings.workShifts = [{ day: 6, start: '00:00', end: '23:59', confirmed: true }, { day: 0, start: '05:00', end: '07:00', confirmed: false }, { day: 3, start: '08:00', end: '09:00' }];
  good.settings.courseBlocks = [{ title: 'Cours A', day: 3, start: '09:00', end: '11:00' }, { day: 4, start: '00:00', end: '00:01' }];
  const back = C.validateImported(JSON.parse(JSON.stringify(good)));
  assert.deepEqual(JSON.parse(JSON.stringify(back.settings.workShifts)), good.settings.workShifts, 'horaires valides conservés à l’identique');
  assert.deepEqual(JSON.parse(JSON.stringify(back.settings.courseBlocks)), good.settings.courseBlocks, 'cours valides conservés à l’identique');
  assert.deepEqual(JSON.parse(JSON.stringify(C.validateImported(JSON.parse(JSON.stringify(C.seed()))).settings.workShifts)), C.seed().settings.workShifts, 'horaires du seed inchangés');

  // Donnée héritée invalide déjà stockée : jamais perdue, jamais réécrite — mode récupération avec le texte brut.
  const legacy = base(); legacy.settings.workShifts = [{ day: 1, start: '22:00', end: '06:00', confirmed: true }];
  const legacyRaw = JSON.stringify(legacy);
  const lst = fakeStorage(legacyRaw);
  const ld = C.loadStored(lst, KEY);
  assert.equal(ld.locked, true, 'intervalle invalide stocké => récupération, pas d’effacement silencieux');
  assert.equal(ld.raw, legacyRaw, 'texte brut intact pour export');
  assert.match(ld.reason, INTERVAL);
  assert.equal(C.saveStored(lst, KEY, ld.state, ld.locked).ok, false);
  assert.equal(lst.map.get(KEY), legacyRaw, 'aucune écriture');

  // Défense en profondeur : si un état non validé atteint le planificateur, la plage est signalée, pas invisible.
  const raw = C.seed();
  raw.settings.workShifts = [{ day: 1, start: '22:00', end: '06:00', confirmed: true }];
  raw.settings.courseBlocks = [{ title: 'Cours nuit', day: 2, start: '23:00', end: '01:00' }];
  const plan = C.buildWeekPlan(raw, '2026-11-10');
  assert.ok(plan.conflicts.some(c => /Horaire de travail ignoré car invalide/.test(c)), 'horaire invalide signalé');
  assert.ok(plan.conflicts.some(c => /Cours ignoré car invalide/.test(c)), 'cours invalide signalé');
  assert.equal(plan.days.flatMap(d => d.blocks).some(b => b.kind === 'work'), false, 'aucun bloc de travail inventé');
}

// --- 10. P2 : sommeil calculé depuis la durée cible et le réveil suivant --------------------------
{
  const sleepPlan = (hours, shifts = [], courses = []) => {
    const st = C.seed(); st.settings.sleepHours = hours; st.settings.workShifts = shifts; st.settings.courseBlocks = courses;
    return C.buildWeekPlan(st, '2026-11-10');
  };
  const sleepOf = (plan, d) => plan.days[d].blocks.filter(b => b.kind === 'sleep').map(b => [b.start, b.end]);
  const everyDay = (plan, expected, label) => { for (let d = 0; d < 7; d++) assert.deepEqual(sleepOf(plan, d), expected, `${label} jour ${d}`); };

  everyDay(sleepPlan(7), [[toMin('01:00'), toMin('08:00')]], '7 h, réveil 08:00 => 01:00–08:00');
  everyDay(sleepPlan(7.5), [[toMin('00:30'), toMin('08:00')]], '7,5 h, réveil 08:00 => 00:30–08:00');
  everyDay(sleepPlan(8), [[0, 480]], '8 h, réveil 08:00 => 00:00–08:00');
  everyDay(sleepPlan(9), [[0, 480], [toMin('23:00'), 1440]], '9 h => 23:00–24:00 la veille + 00:00–08:00');

  // Réveil anticipé 04:30 (travail mardi 05:00), cible 8 h : soirée précédente 20:30–24:00 + 00:00–04:30.
  const tue = [{ day: 1, start: '05:00', end: '17:00', confirmed: true }];
  const p8 = sleepPlan(8, tue);
  assert.deepEqual(sleepOf(p8, 1), [[0, toMin('04:30')]], 'mardi : nuit finissant à 04:30');
  assert.deepEqual(sleepOf(p8, 0), [[0, 480], [toMin('20:30'), 1440]], 'lundi : début de nuit 20:30–24:00');
  assert.equal((1440 - toMin('20:30')) + toMin('04:30'), 480, 'nuit lundi→mardi = 3 h 30 + 4 h 30 = 8 h');
  // Même réveil, cible 7 h : 150 min la veille, 270 le matin.
  const p7 = sleepPlan(7, tue);
  assert.deepEqual(sleepOf(p7, 1), [[0, toMin('04:30')]]);
  assert.deepEqual(sleepOf(p7, 0), [[toMin('01:00'), 480], [toMin('21:30'), 1440]], 'lundi : 21:30–24:00 pour compléter 7 h');
  // Réveil à 00:00 (travail à 00:10 le jeudi) : toute la nuit est la veille au soir.
  assert.deepEqual(sleepOf(sleepPlan(8, [{ day: 3, start: '00:10', end: '06:00' }]), 2), [[0, 480], [toMin('16:00'), 1440]], 'mercredi soir : nuit complète 16:00–24:00 avant un réveil à 00:00');

  // Invariants sur une grille de cas : 7 nuits exactes, bornes 0..1440, aucune tâche sur un bloc fixe, minutes entières.
  const shiftsSets = [[], C.seed().settings.workShifts, tue, [{ day: 3, start: '00:10', end: '06:00' }], [{ day: 0, start: '03:00', end: '04:00' }, { day: 0, start: '05:00', end: '07:00' }], [{ day: 2, start: '10:00', end: '18:00' }]];
  for (const hours of [3, 4, 5, 6.5, 7, 7.3, 7.5, 8, 9, 10, 12, 'x']) {
    for (const shifts of shiftsSets) {
      const plan = sleepPlan(hours, shifts);
      const target = Number.isFinite(Number(hours)) ? Math.min(600, Math.max(240, Math.round(Number(hours) * 60))) : 480;
      const total = plan.days.flatMap((d, i) => sleepOf(plan, i)).reduce((a, [s, e]) => a + e - s, 0);
      assert.equal(total, 7 * target, `semaine type ${hours} h : 7 nuits de ${target} min`);
      for (const [d, day] of plan.days.entries()) {
        const wake = Math.min(480, ...shifts.filter(s => s.day === d).map(s => Math.max(0, toMin(s.start) - 30)));
        const morning = sleepOf(plan, d).find(([, e]) => e === wake);
        if (wake > 0) assert.ok(morning, `${hours} h jour ${d} : une nuit finit exactement au réveil ${wake}`);
        if (wake > 0) assert.equal(morning[0], Math.max(0, wake - target), `${hours} h jour ${d} : début = réveil − durée`);
        for (const b of day.blocks) {
          assert.ok(b.start >= 0 && b.end <= 1440 && b.end > b.start, `bornes 0..1440 : ${day.name} ${b.name} ${b.start}-${b.end}`);
          assert.ok(Number.isInteger(b.start) && Number.isInteger(b.end), 'minutes entières');
        }
        for (const b of day.blocks.filter(x => !x.fixed)) for (const f of day.blocks.filter(x => x.fixed)) assert.equal(b.start < f.end && b.end > f.start, false, `${day.name} : ${b.name} recouvre ${f.name}`);
      }
    }
  }

  // Les conflits restent visibles : le sommeil de 7 h n'est ni raccourci ni masqué par un cours à 02:00.
  const cp = sleepPlan(7, [], [{ title: 'Cours nocturne', day: 3, start: '02:00', end: '03:00' }]);
  assert.deepEqual(sleepOf(cp, 3), [[60, 480]], 'sommeil jeudi intact');
  const night = cp.days[3].blocks;
  assert.equal(night.find(b => b.kind === 'sleep').conflict, true);
  assert.equal(night.find(b => b.name === 'Cours nocturne').conflict, true);
  assert.ok(cp.conflicts.some(x => x.includes('Jeudi') && x.includes('Cours nocturne')));
  // Une tâche demandée à 09:00 ne glisse jamais dans la nuit.
  const tp = C.seed(); tp.settings.sleepHours = 7; tp.settings.workShifts = []; tp.tasks = [{ id: 't', title: 'Tâche', projectId: '', category: 'study', priority: 'normale', duration: 60, date: '2026-11-11', done: false, origin: 'manuel', notes: '' }];
  const tb = C.buildWeekPlan(tp, '2026-11-10').days[2].blocks.find(b => b.name === 'Tâche');
  assert.ok(tb && tb.start >= 480, 'tâche après le réveil');
}

// --- 11. P1 #3 (noyau) : transaction de stockage, restauration prouvée ou incertitude --------------
{
  const mk = () => { const a = C.seed(); a.settings.displayName = 'AVANT'; const b = C.seed(); b.settings.displayName = 'APRES'; return [rawOf(a), b]; };
  const [before, next] = mk();
  const nextRaw = JSON.stringify(next);

  // setItem réussit, la relecture lève UNE fois, puis le stockage répond : restauration prouvée.
  let st = scriptedStorage(before); st.getPlan = ['ok', 'throw'];
  let r = C.saveStored(st, KEY, next, false);
  assert.deepEqual([r.ok, r.uncertain, r.rolledBack], [false, false, true], 'relecture exceptionnelle puis restauration vérifiée');
  assert.equal(st.map.get(KEY), before, 'octets d’origine restaurés');
  assert.match(r.reason, /restauré et relu/);

  // setItem réussit, la relecture lève toujours : impossible de prouver quoi que ce soit.
  st = scriptedStorage(before); st.getPlan = ['ok']; st.getDefault = 'throw';
  r = C.saveStored(st, KEY, next, false);
  assert.deepEqual([r.ok, r.uncertain, r.rolledBack], [false, true, false], 'état incertain, aucune restauration affirmée');
  assert.doesNotMatch(r.reason, /restauré/);

  // Les nouveaux octets restent, la restauration échoue aussi : incertain (et la réalité est bien « nouveau »).
  st = scriptedStorage(before); st.setPlan = ['ok', 'throw']; st.getPlan = ['ok']; st.getDefault = 'throw';
  r = C.saveStored(st, KEY, next, false);
  assert.deepEqual([r.ok, r.uncertain, r.rolledBack], [false, true, false]);
  assert.equal(st.map.get(KEY), nextRaw, 'les nouveaux octets sont bien restés : ne jamais annoncer « ancien état »');

  // setItem écrit puis lève : la relecture voit les nouveaux octets, ils sont restaurés et prouvés.
  st = scriptedStorage(before); st.setPlan = ['write-then-throw'];
  r = C.saveStored(st, KEY, next, false);
  assert.deepEqual([r.ok, r.uncertain, r.rolledBack], [false, false, true]);
  assert.equal(st.map.get(KEY), before);

  // Relecture différente des deux versions (octets tronqués) : restauration prouvée.
  st = scriptedStorage(before);
  const origSet = st.setItem; let calls = 0; st.setItem = (k, v) => { calls += 1; origSet(k, calls === 1 ? v.slice(0, 20) : v); };
  r = C.saveStored(st, KEY, next, false);
  assert.deepEqual([r.ok, r.uncertain, r.rolledBack], [false, false, true], 'écriture tronquée => restaurée');
  assert.equal(st.map.get(KEY), before);

  // Lecture impossible AVANT écriture : rien n'est écrit, état certain.
  st = scriptedStorage(before); st.getPlan = ['throw'];
  r = C.saveStored(st, KEY, next, false);
  assert.deepEqual([r.ok, r.uncertain], [false, false]);
  assert.equal(st.sets(), 0, 'aucun setItem sans instantané');

  // Refus franc et écriture perdue : relecture prouve l'état inchangé.
  st = scriptedStorage(before); st.setDefault = 'throw';
  r = C.saveStored(st, KEY, next, false);
  assert.deepEqual([r.ok, r.uncertain, r.rolledBack], [false, false, false]);
  assert.match(r.reason, /inchangé/);
  st = scriptedStorage(before); st.setDefault = 'silent';
  r = C.saveStored(st, KEY, next, false);
  assert.deepEqual([r.ok, r.uncertain], [false, false]);
  assert.equal(st.map.get(KEY), before);

  // Première écriture (clé absente) puis relecture impossible : la clé est supprimée puis vérifiée absente.
  st = scriptedStorage(null); st.getPlan = ['ok', 'throw'];
  r = C.saveStored(st, KEY, next, false);
  assert.deepEqual([r.ok, r.uncertain, r.rolledBack], [false, false, true]);
  assert.equal(st.map.has(KEY), false, 'clé absente restaurée par removeItem');

  // Instantané identique à l'écriture : succès normal.
  st = scriptedStorage(nextRaw);
  assert.equal(C.saveStored(st, KEY, next, false).ok, true);

  // loadStored signale un stockage illisible (par opposition à un contenu illisible).
  assert.equal(C.loadStored({ getItem() { throw Error('x'); } }, KEY).unreadable, true);
  assert.equal(C.loadStored(fakeStorage('{cassé'), KEY).unreadable, undefined);
}

// --- 12. Harnais DOM minimal : exécute le VRAI core.js + app.js dans un contexte vm -----------------
function bootApp(storage, { confirmAnswer = true } = {}) {
  let answer = confirmAnswer;
  const els = {}, docHandlers = {}, toasts = [], downloads = [], blobs = [], confirms = [];
  const makeEl = sel => {
    const e = {
      sel, innerHTML: '', _t: '', dataset: {}, handlers: {}, open: false,
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(t, fn) { e.handlers[t] = fn; }, querySelector() { return null; }, focus() {}, click() {}, remove() {},
      showModal() { e.open = true; }, close() { e.open = false; if (e.handlers.close) e.handlers.close(); },
    };
    Object.defineProperty(e, 'textContent', { get: () => e._t, set: v => { e._t = String(v); if (sel === '#toast') toasts.push(e._t); } });
    return e;
  };
  const el = s => (els[s] ||= makeEl(s));
  const document = {
    querySelector: el, addEventListener: (t, fn) => { docHandlers[t] = fn; },
    createElement: () => { const a = { click() { downloads.push({ name: a.download, text: blobs[Number(String(a.href).slice(5))].text }); }, remove() {} }; return a; },
    body: { appendChild() {} },
  };
  class FormDataStub { constructor(form) { this._v = form.__values || {}; } entries() { return Object.entries(this._v)[Symbol.iterator](); } }
  class BlobStub { constructor(parts) { this.text = parts.join(''); } }
  const URLStub = { createObjectURL: b => { blobs.push(b); return 'blob:' + (blobs.length - 1); }, revokeObjectURL() {} };
  const win = { localStorage: storage, scrollTo() {} };
  const ctx = vm.createContext({ window: win, document, FormData: FormDataStub, Blob: BlobStub, URL: URLStub, confirm: q => { confirms.push(q); return answer; }, setTimeout: () => 0, clearTimeout() {}, console });
  vm.runInContext(SRC('core.js'), ctx, { filename: 'core.js' });
  vm.runInContext(SRC('app.js'), ctx, { filename: 'app.js' });
  const app = {
    toasts, downloads, confirms, el, storage, setConfirm: v => { answer = v; },
    lastToast: () => toasts[toasts.length - 1],
    view: () => el('#view').innerHTML,
    click: (action, data = {}) => { const b = { tagName: 'BUTTON', dataset: { action, ...data } }; docHandlers.click({ target: { closest: () => b } }); },
    change: (action, data = {}, checked = false, value = '') => { docHandlers.change({ target: { dataset: { action, ...data }, checked, value } }); },
    submit: values => { const f = el('#modal-form'); f.__values = values; f.handlers.submit({ submitter: { value: 'save' }, preventDefault() {}, currentTarget: f }); },
    importFile: text => el('#file-import').handlers.change({ target: { files: [{ size: Buffer.byteLength(text), text: async () => text }], value: 'x' } }),
    exported: () => { const n = downloads.length; app.click('export'); assert.equal(downloads.length, n + 1, 'export autorisé'); return JSON.parse(downloads[downloads.length - 1].text); },
  };
  return app;
}

(async () => {
  // --- 13. P1 #2 : callbacks de formulaires — échec d'écriture, puis nouvelle tentative réellement persistée ---
  const flows = [
    { name: 'editCourse', open: a => a.click('edit-course', { id: 'c0' }), values: { name: 'Software Engineering', progress: 'Révisé', timePerWeek: '120', next: 'Exercice 5' },
      verify: s => { const c = s.courses.find(x => x.id === 'c0'); return c.progress === 'Révisé' && c.next === 'Exercice 5' && c.timePerWeek === 120; }, shows: ['study', 'Exercice 5'] },
    { name: 'tâche modifiée', open: a => a.click('edit-task', { id: 'task-a' }), values: { title: 'Titre modifié', projectId: 'lernlabor', category: 'projects', priority: 'haute', duration: '60', date: '', notes: 'n' },
      verify: s => s.tasks.length === 3 && s.tasks.find(x => x.id === 'task-a').title === 'Titre modifié' },
    { name: 'tâche créée', open: a => a.click('add-task'), values: { title: 'Nouvelle tâche', projectId: '', category: 'study', priority: 'normale', duration: '30', date: '', notes: '' },
      verify: s => s.tasks.length === 4 && s.tasks.filter(x => x.title === 'Nouvelle tâche').length === 1 },
    { name: 'projet modifié', open: a => a.click('project-edit', { id: 'lernlabor' }), values: { name: 'Lernlabor X', domain: 'Produit', tier: 'focus', status: 'Ok', description: 'd', goal: 'g', next: 'Prochaine X', target: 't', evidence: 'e' },
      verify: s => { const p = s.projects.find(x => x.id === 'lernlabor'); return p.name === 'Lernlabor X' && p.next === 'Prochaine X' && p.steps.length === 3 && s.projects.length === 10; } },
    { name: 'projet créé', open: a => a.click('add-project'), values: { name: 'Projet Z', domain: 'Test', tier: 'incubator', status: 's', description: 'd', goal: 'g', next: 'n', target: 't', evidence: 'e' },
      verify: s => s.projects.length === 11 && s.projects.filter(x => x.name === 'Projet Z').length === 1 },
    { name: 'candidature créée', open: a => a.click('add-application'), values: { company: 'Acme', role: 'Dev', status: 'brouillon', sentAt: '', followup: '', url: '', notes: '' },
      verify: s => s.applications.length === 1 && s.applications[0].company === 'Acme' },
    { name: 'objectif modifié', open: a => a.click('edit-goal', { id: 'g1' }), values: { title: 'Objectif modifié', horizon: '12 mois', deadline: '2027-01-01', metric: 'm', status: 'En cours' },
      verify: s => s.goals.length === 4 && s.goals.find(x => x.id === 'g1').title === 'Objectif modifié' && s.goals.find(x => x.id === 'g1').deadline === '2027-01-01', shows: ['goals', 'Objectif modifié'] },
    { name: 'idée modifiée', open: a => a.click('edit-idea', { id: 'idea-1' }), values: { title: 'Idée modifiée', status: 'À explorer', notes: 'nn' },
      verify: s => s.ideas.length === 1 && s.ideas[0].title === 'Idée modifiée' && s.ideas[0].status === 'À explorer' },
    { name: 'réglages', open: a => a.click('edit-settings'), values: { sleepHours: '7.5', budgetLiving: '900', budgetProjects: '210', foodBudget: '190', foodIncludedInLiving: 'yes', targetMonthly: '1200', targetType: 'bénéfice' },
      verify: s => s.settings.sleepHours === 7.5 && s.settings.budgetLiving === 900 && s.settings.foodIncludedInLiving === true && s.settings.workShifts.length === 3 },
    { name: 'horaire de travail modifié', open: a => a.click('edit-shift', { index: '0' }), values: { day: '3', start: '06:00', end: '12:00', confirmed: 'true' },
      verify: s => { const w = s.settings.workShifts[0]; return w.day === 3 && w.start === '06:00' && w.end === '12:00' && w.confirmed === true && s.settings.workShifts.length === 3; } },
    { name: 'horaire de travail ajouté', open: a => a.click('add-shift'), values: { day: '4', start: '07:00', end: '15:00', confirmed: 'false' },
      verify: s => s.settings.workShifts.length === 4 && s.settings.workShifts[3].start === '07:00' },
    { name: 'cours ajouté', open: a => a.click('add-class'), values: { title: 'Cours X', day: '3', start: '09:00', end: '11:00' },
      verify: s => s.settings.courseBlocks.length === 1 && s.settings.courseBlocks[0].title === 'Cours X' },
    { name: 'dépense', open: a => a.click('add-expense'), values: { date: '2026-11-10', amount: '12.5', label: 'Test', category: 'vie' },
      verify: s => s.transactions.length === 1 && s.transactions[0].amount === 12.5 },
    { name: 'revue', open: a => a.click('add-review'), values: { wins: 'a', pressure: 'b', priorities: 'c' },
      verify: s => s.review.length === 1 && s.review[0].wins === 'a' },
    { name: 'jalon ajouté', open: a => a.click('project-step-add', { id: 'lernlabor' }), values: { name: 'Nouveau jalon' },
      verify: s => { const p = s.projects.find(x => x.id === 'lernlabor'); return p.steps.length === 4 && p.steps[3].name === 'Nouveau jalon'; } },
  ];
  for (const f of flows) {
    const st = scriptedStorage(rawOf(C.seed()));
    const app = bootApp(st);
    const before = st.map.get(KEY);
    f.open(app);
    assert.equal(app.el('#modal').open, true, `${f.name} : formulaire ouvert`);
    st.setDefault = 'throw';
    app.submit(f.values);
    assert.match(app.lastToast(), /^Enregistrement impossible/, `${f.name} : échec annoncé`);
    assert.equal(st.map.get(KEY), before, `${f.name} : stockage inchangé`);
    assert.equal(f.verify(JSON.parse(st.map.get(KEY))), false, `${f.name} : rien de persisté`);
    assert.equal(app.el('#modal').open, true, `${f.name} : formulaire conservé pour réessayer`);
    assert.equal(app.toasts.includes('Modifications enregistrées localement.'), false, `${f.name} : aucun faux succès`);
    st.setDefault = 'ok';
    app.submit(f.values);
    assert.equal(app.lastToast(), 'Modifications enregistrées localement.', `${f.name} : succès à la 2e tentative`);
    assert.equal(f.verify(JSON.parse(st.map.get(KEY))), true, `${f.name} : champ réellement persisté après nouvelle tentative`);
    assert.equal(app.toasts.filter(x => x === 'Modifications enregistrées localement.').length, 1, `${f.name} : succès annoncé une seule fois`);
    assert.equal(app.el('#modal').open, false, `${f.name} : formulaire fermé après succès`);
    if (f.shows) { app.click('navigate', { view: f.shows[0] }); assert.ok(app.view().includes(f.shows[1]), `${f.name} : valeur affichée après succès`); }
  }

  // Modification d'une candidature créée, puis suppression : mêmes garanties.
  {
    const st = scriptedStorage(rawOf(C.seed())); const app = bootApp(st);
    app.click('add-application'); app.submit({ company: 'Acme', role: 'Dev', status: 'brouillon', sentAt: '', followup: '', url: '', notes: '' });
    const id = JSON.parse(st.map.get(KEY)).applications[0].id;
    app.click('edit-application', { id });
    const upd = { company: 'Acme 2', role: 'Dev', status: 'envoyée', sentAt: '2026-11-10', followup: '', url: '', notes: 'x' };
    st.setDefault = 'throw'; app.submit(upd);
    assert.equal(JSON.parse(st.map.get(KEY)).applications[0].company, 'Acme');
    st.setDefault = 'ok'; app.submit(upd);
    const saved = JSON.parse(st.map.get(KEY)).applications;
    assert.deepEqual([saved.length, saved[0].company, saved[0].status, saved[0].id], [1, 'Acme 2', 'envoyée', id], 'candidature modifiée et persistée à la 2e tentative');
    // suppression en échec : le formulaire reste ouvert, la ligne existe encore ; puis suppression réussie.
    app.click('edit-application', { id });
    st.setDefault = 'throw'; app.click('delete-application', { id });
    assert.equal(JSON.parse(st.map.get(KEY)).applications.length, 1);
    assert.equal(app.el('#modal').open, true, 'suppression échouée : formulaire non fermé');
    st.setDefault = 'ok'; app.click('delete-application', { id });
    assert.equal(JSON.parse(st.map.get(KEY)).applications.length, 0);
    assert.equal(app.el('#modal').open, false);
  }

  // Cases à cocher / sélecteurs : échec puis nouvelle tentative.
  {
    const checks = [
      { name: 'tâche cochée', run: a => a.change('task-check', { id: 'task-a' }, true), verify: s => s.tasks.find(x => x.id === 'task-a').done === true },
      { name: 'habitude cochée', run: a => a.change('habit-check', { id: 'gym', date: '2026-11-10' }, true), verify: s => s.habitChecks['gym:2026-11-10'] === true },
      { name: 'jalon coché', run: a => a.change('project-step-check', { id: 'lernlabor', index: '0' }, true), verify: s => s.projects.find(x => x.id === 'lernlabor').steps[0].done === true },
      { name: 'niveau de projet', run: a => a.change('project-tier', { id: 'lernlabor' }, false, 'incubator'), verify: s => s.projects.find(x => x.id === 'lernlabor').tier === 'incubator' },
      { name: 'jalon retiré', run: a => { a.click('project-step-delete', { id: 'lernlabor', index: '0' }); }, verify: s => s.projects.find(x => x.id === 'lernlabor').steps.length === 2 },
      { name: 'horaire supprimé', run: a => { a.click('delete-shift', { index: '0' }); }, verify: s => s.settings.workShifts.length === 2 },
    ];
    for (const c of checks) {
      const st = scriptedStorage(rawOf(C.seed())); const app = bootApp(st); const before = st.map.get(KEY);
      st.setDefault = 'throw'; c.run(app);
      assert.match(app.lastToast(), /^Enregistrement impossible/, `${c.name} : échec annoncé`);
      assert.equal(st.map.get(KEY), before, `${c.name} : stockage inchangé`);
      st.setDefault = 'ok'; c.run(app);
      assert.equal(c.verify(JSON.parse(st.map.get(KEY))), true, `${c.name} : persisté à la 2e tentative`);
    }
  }

  // Validation en échec avant écriture : aucun setItem, message explicite.
  {
    const st = scriptedStorage(rawOf(C.seed())); const app = bootApp(st);
    app.click('edit-shift', { index: '0' }); app.submit({ day: '1', start: '22:00', end: '06:00', confirmed: 'true' });
    assert.equal(app.lastToast(), 'La fin doit être après le début.');
    assert.equal(st.sets(), 0, 'horaire de nuit refusé dans l’interface, rien écrit');
    app.el('#modal').close();
    app.click('add-class'); app.submit({ title: 'X', day: '1', start: '12:00', end: '12:00' });
    assert.equal(app.lastToast(), 'Heure de fin incorrecte.');
    assert.equal(st.sets(), 0);
  }

  // --- 14. P1 #3 (application) : import, écriture réussie puis relecture impossible --------------------
  const S0 = C.seed(); S0.settings.displayName = 'AVANT';
  const S1 = C.seed(); S1.settings.displayName = 'IMPORTE';
  const raw0 = rawOf(S0), file1 = JSON.stringify(S1), raw1 = rawOf(S1);

  // 14a. relecture lève une fois, restauration prouvée : pas de bandeau, état d'avant, jamais « Données importées ».
  {
    const st = scriptedStorage(raw0); const app = bootApp(st);
    st.getPlan = ['ok', 'throw'];
    await app.importFile(file1);
    assert.match(app.lastToast(), /Enregistrement impossible.*restauré et relu/);
    assert.equal(st.map.get(KEY), raw0, 'octets d’origine rétablis');
    assert.equal(app.toasts.includes('Données importées.'), false, 'aucun faux succès');
    assert.equal(app.view().includes('uncertain-banner'), false);
    assert.equal(app.exported().settings.displayName, 'AVANT', 'état en mémoire inchangé');
  }

  // 14b. relecture lève toujours : mode incertain, écritures bloquées, export possible, relecture explicite.
  {
    const st = scriptedStorage(raw0); const app = bootApp(st);
    st.getPlan = ['ok']; st.getDefault = 'throw';
    await app.importFile(file1);
    assert.match(app.lastToast(), /Enregistrement incertain/);
    assert.doesNotMatch(app.lastToast(), /restauré|Données importées/, 'aucune restauration ni succès affirmés');
    assert.ok(app.view().includes('uncertain-banner') && app.view().includes('role="alert"'), 'bandeau d’alerte affiché');
    assert.equal(app.exported().settings.displayName, 'AVANT', 'import non appliqué en mémoire');
    const setsAfterFailure = st.sets();
    // Écritures ordinaires bloquées, aucune tentative de setItem.
    app.change('task-check', { id: 'task-a' }, true);
    assert.match(app.lastToast(), /incertain/);
    app.click('edit-course', { id: 'c0' }); app.submit({ name: 'Software Engineering', progress: 'Z', timePerWeek: '10', next: 'n' });
    assert.match(app.lastToast(), /incertain/);
    app.el('#modal').close();
    await app.importFile(file1);
    assert.match(app.lastToast(), /Import bloqué/);
    app.click('reset');
    assert.match(app.lastToast(), /Réinitialisation bloquée/);
    assert.equal(st.sets(), setsAfterFailure, 'aucun setItem tant que l’état est incertain');
    assert.equal(app.toasts.includes('Modifications enregistrées localement.'), false);
    assert.equal(app.exported().tasks.find(x => x.id === 'task-a').done, false, 'la case n’est pas restée cochée en mémoire');
    // Bandeau durable : toujours présent après navigation.
    app.click('navigate', { view: 'week' });
    assert.ok(app.view().includes('uncertain-banner'), 'bandeau persistant');
    // Stockage toujours illisible : la relecture ne débloque rien.
    app.click('uncertain-recheck');
    assert.match(app.lastToast(), /reste illisible/);
    assert.ok(app.view().includes('uncertain-banner'));
    // Stockage de nouveau lisible : relecture seule (aucune écriture), identique à l'affichage => déblocage sans confirmation.
    st.getDefault = 'ok';
    const confirmsBefore = app.confirms.length;
    app.click('uncertain-recheck');
    assert.equal(app.view().includes('uncertain-banner'), false, 'incertitude levée par une lecture réussie');
    assert.equal(app.confirms.length, confirmsBefore, 'contenu identique : pas de confirmation');
    assert.equal(st.sets(), setsAfterFailure, 'la relecture n’écrit rien');
    app.change('task-check', { id: 'task-a' }, true);
    assert.equal(JSON.parse(st.map.get(KEY)).tasks.find(x => x.id === 'task-a').done, true, 'écriture ordinaire de nouveau possible et persistée');
  }

  // 14c. nouveaux octets réellement restés (restauration impossible) : l'affichage ne ment pas, la relecture adopte la réalité.
  {
    const st = scriptedStorage(raw0); const app = bootApp(st);
    st.setPlan = ['ok', 'throw']; st.getPlan = ['ok']; st.getDefault = 'throw';
    await app.importFile(file1);
    assert.match(app.lastToast(), /Enregistrement incertain/);
    assert.doesNotMatch(app.lastToast(), /restauré|Données importées/);
    assert.equal(st.map.get(KEY), raw1, 'réalité : les octets importés sont bien stockés');
    assert.equal(app.exported().settings.displayName, 'AVANT', 'affichage = dernière sauvegarde confirmée (pas de fausse adoption)');
    // Une page rechargée relit la réalité du stockage.
    const reloadSt = scriptedStorage(st.map.get(KEY)); const reloaded = bootApp(reloadSt);
    assert.equal(reloaded.exported().settings.displayName, 'IMPORTE', 'rechargement = ce que le navigateur contient');
    assert.equal(reloaded.view().includes('uncertain-banner'), false);
    // Relecture refusée par l'utilisateur : rien ne change.
    st.getDefault = 'ok';
    const declined = bootApp(scriptedStorage(raw0));
    declined.storage.getPlan = ['ok']; declined.storage.getDefault = 'throw'; declined.storage.setPlan = ['ok', 'throw'];
    await declined.importFile(file1);
    declined.storage.getDefault = 'ok';
    declined.setConfirm(false);
    declined.click('uncertain-recheck');
    assert.ok(declined.view().includes('uncertain-banner'), 'confirmation refusée : toujours incertain');
    assert.equal(declined.exported().settings.displayName, 'AVANT');
    // Relecture acceptée : l'affichage adopte le contenu réel du stockage, écritures de nouveau permises.
    app.click('uncertain-recheck');
    assert.equal(app.confirms.length >= 1, true, 'confirmation demandée car le contenu diffère');
    assert.equal(app.view().includes('uncertain-banner'), false);
    assert.equal(app.exported().settings.displayName, 'IMPORTE', 'affichage = contenu réel du stockage');
  }

  // 14d. setItem écrit puis lève : restauration prouvée.
  {
    const st = scriptedStorage(raw0); const app = bootApp(st);
    st.setPlan = ['write-then-throw'];
    await app.importFile(file1);
    assert.match(app.lastToast(), /Enregistrement impossible.*restauré et relu/);
    assert.equal(st.map.get(KEY), raw0);
    assert.equal(app.exported().settings.displayName, 'AVANT');
  }

  // 14e. lecture impossible avant écriture : rien n'est écrit.
  {
    const st = scriptedStorage(raw0); const app = bootApp(st);
    st.getPlan = ['throw'];
    await app.importFile(file1);
    assert.match(app.lastToast(), /illisible avant écriture/);
    assert.equal(st.sets(), 0);
    assert.equal(app.view().includes('uncertain-banner'), false, 'état certain : rien écrit');
  }

  // 14f. réinitialisation : même transaction ; incertain => bandeau, état affiché inchangé.
  {
    const st = scriptedStorage(raw0); const app = bootApp(st);
    st.getPlan = ['ok']; st.getDefault = 'throw';
    app.click('reset');
    assert.match(app.lastToast(), /Réinitialisation impossible/);
    assert.ok(app.view().includes('uncertain-banner'));
    assert.equal(app.exported().settings.displayName, 'AVANT');
  }

  // --- 15. Export puis import du seed (aller-retour réel dans l'application) + rejets propres ------------
  {
    const st = scriptedStorage(raw0); const app = bootApp(st);
    const exported = JSON.stringify(app.exported(), null, 2);
    await app.importFile(exported);
    assert.equal(app.lastToast(), 'Données importées.');
    assert.equal(st.map.get(KEY), raw0, 'import du fichier exporté = mêmes données persistées');
    const seedApp = bootApp(scriptedStorage(null));
    const seedFile = JSON.stringify(seedApp.exported());
    await seedApp.importFile(seedFile);
    assert.equal(seedApp.lastToast(), 'Données importées.');
    assert.equal(rawOf(JSON.parse(seedApp.storage.map.get(KEY))), seedApp.storage.map.get(KEY));
    assert.deepEqual(JSON.parse(seedApp.storage.map.get(KEY)).projects.map(p => p.id), C.seed().projects.map(p => p.id), 'seed conservé');

    const before = st.map.get(KEY), sets = st.sets(), confirms = app.confirms.length;
    await app.importFile('{pas du json');
    assert.equal(app.lastToast(), 'Import refusé : fichier JSON illisible.');
    const nuit = base(); nuit.settings.workShifts = [{ day: 1, start: '22:00', end: '06:00', confirmed: true }];
    await app.importFile(JSON.stringify(nuit));
    assert.match(app.lastToast(), /^Import refusé : Intervalle invalide/);
    const cnuit = base(); cnuit.settings.courseBlocks = [{ title: 'Nuit', day: 1, start: '12:00', end: '12:00' }];
    await app.importFile(JSON.stringify(cnuit));
    assert.match(app.lastToast(), /^Import refusé : Intervalle invalide/);
    assert.equal(st.map.get(KEY), before, 'imports refusés : stockage intact');
    assert.equal(st.sets(), sets, 'aucune écriture');
    assert.equal(app.confirms.length, confirms, 'aucune demande de confirmation pour un fichier invalide');
  }

  console.log('Hardening tests PASS — import malveillant, intervalles, stockage fail-closed + transaction (relecture impossible, restauration prouvée, mode incertain), callbacks après échec d’écriture, durée 480, sommeil 7 h / 7,5 h / réveil anticipé, roundtrip');
})().catch(err => { console.error(err); process.exit(1); });
