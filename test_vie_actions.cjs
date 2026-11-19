// Tests hors ligne de la logique d'actions de Vie contre le VRAI core.js + app.js (contexte vm, DOM minimal, stockage factice).
// Aucune donnée personnelle, aucun réseau, aucune API.   node test_vie_actions.cjs
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const C = require('./core.js');
const A = require('./vie-actions.js');

const KEY = 'vie-personal-v1';
const SRC = f => fs.readFileSync(path.join(__dirname, f), 'utf8');
const TODAY = '2026-11-12';

function fakeStorage(initial = null, mode = 'ok') {
  const map = new Map(initial === null ? [] : [[KEY, initial]]);
  const st = { map, mode, getItem: k => { if (st.mode === 'brick' && k === KEY) throw Error('SecurityError'); return map.has(k) ? map.get(k) : null; }, setItem: (k, v) => { if (st.mode === 'throw') throw Object.assign(Error('Quota'), { name: 'QuotaExceededError' }); if (st.mode === 'silent') return; map.set(k, String(v)); if (st.mode === 'brick-after') st.mode = 'brick'; }, removeItem: k => map.delete(k) };
  return st;
}
function boot(storage) {
  const els = {}, handlers = {}, toasts = [];
  const mk = sel => { const e = { sel, innerHTML: '', _t: '', dataset: {}, handlers: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener(t, f) { e.handlers[t] = f; }, querySelector: () => null, focus() {}, click() {}, remove() {}, showModal() {}, close() {} }; Object.defineProperty(e, 'textContent', { get: () => e._t, set: v => { e._t = String(v); if (sel === '#toast') toasts.push(e._t); } }); return e; };
  const el = s => (els[s] ||= mk(s));
  const downloads = [];
  const document = { querySelector: el, addEventListener: (t, f) => { handlers[t] = f; }, createElement: () => { const a = { click() { downloads.push(a.download); }, remove() {} }; return a; }, body: { appendChild() {} } };
  const win = { localStorage: storage, scrollTo() {} };
  const ctx = vm.createContext({ window: win, document, FormData: class {}, Blob: class { constructor(p) { this.t = p.join(''); } }, URL: { createObjectURL: () => 'blob:0', revokeObjectURL() {} }, confirm: () => true, setTimeout: () => 0, clearTimeout() {}, console });
  for (const f of ['core.js', 'app.js', 'vie-actions.js']) vm.runInContext(SRC(f), ctx, { filename: f });
  return { H: win.VieHost, VA: win.VieActions, win, toasts, downloads, el, view: () => el('#view').innerHTML };
}
const withData = () => {
  const s = C.seed();
  s.transactions.push({ id: 'tx-netflix', date: '2026-11-10', label: 'Netflix', amount: 12.5, type: 'expense', category: 'vie' }, { id: 'tx-penny', date: '2026-11-11', label: 'PENNY', amount: 30, type: 'expense', category: 'alimentation' });
  s.applications.push({ id: 'app-1', company: 'Acme', role: 'Dev', status: 'brouillon', sentAt: '', followup: '', url: '', notes: '' });
  return s;
};
const mkStore = (s = withData(), mode) => fakeStorage(JSON.stringify(s), mode);
const stored = st => JSON.parse(st.map.get(KEY));
const P = (name, input) => A.normalizeToolCall(name, input);
const upd = (entity, id, changes) => P('propose_update', { entity, id, changes: Object.entries(changes).map(([field, value]) => ({ field, value })) });
// applique comme le fait le panneau : prévisualisation (base) puis mutation atomique via le pont
function applyAll(app, proposals) {
  const state = app.H.getState();
  const cards = proposals.map(p => ({ p, prep: A.prepare(state, p, TODAY) }));
  for (const c of cards) if (!c.prep.ok) return { ok: false, error: c.prep.error, stage: 'prepare' };
  const ops = [];
  const res = app.H.mutate(d => { const batch = A.beginBatch ? A.beginBatch(d) : undefined; for (const c of cards) { const r = A.apply(d, c.p, c.prep.base, batch); if (!r.ok) return r; ops.push(r.op); } return { ok: true }; });
  return { ...res, ops };
}
const tests = [];
const check = (name, fn) => tests.push({ name, fn });

check('mise à jour d’un montant par identifiant exact : persistée, affichage recalculé, autres lignes intactes', () => {
  const st = mkStore(); const app = boot(st);
  const p = upd('transactions', 'tx-netflix', { amount: 15 });
  const prep = A.prepare(app.H.getState(), p, TODAY);
  assert.equal(prep.ok, true);
  assert.deepEqual(prep.rows, [{ label: 'Montant', old: A.money(12.5), next: A.money(15) }]);
  assert.equal(prep.targetId, 'tx-netflix'); assert.match(prep.target, /Netflix/);
  assert.match(prep.consequence, /Dépenses saisies du mois 2026-11/);
  // la prévisualisation ne touche à rien
  assert.equal(stored(st).transactions.find(t => t.id === 'tx-netflix').amount, 12.5);
  const r = applyAll(app, [p]);
  assert.equal(r.ok, true);
  const s2 = stored(st);
  assert.equal(s2.transactions.find(t => t.id === 'tx-netflix').amount, 15);
  assert.equal(s2.transactions.find(t => t.id === 'tx-penny').amount, 30);
  assert.equal(s2.transactions.length, 2);
  assert.equal(app.H.getState().transactions.find(t => t.id === 'tx-netflix').amount, 15);
  C.validateImported(s2);
});
check('identifiant inexistant / ambigu / approximatif : refusé, rien n’est modifié (jamais de correspondance floue)', () => {
  const st = mkStore(); const app = boot(st); const before = st.map.get(KEY);
  for (const id of ['tx-netfli', 'TX-NETFLIX', 'Netflix', 'tx-netflix ', '*', 'tx-penny2']) {
    let p; try { p = upd('transactions', id, { amount: 1 }); } catch (e) { continue; }
    const r = applyAll(app, [p]); assert.equal(r.ok, false, id);
  }
  assert.equal(st.map.get(KEY), before);
  assert.equal(A.prepare(app.H.getState(), upd('transactions', 'nope', { amount: 1 }), TODAY).ok, false);
  assert.equal(A.prepare(app.H.getState(), upd('settings', 'autre', { sleepHours: 8 }), TODAY).ok, false);
});
check('échec d’écriture (quota) : aucune fausse réussite, état d’origine conservé, stockage inchangé', () => {
  const st = mkStore(); const app = boot(st); const before = st.map.get(KEY);
  st.mode = 'throw';
  const r = applyAll(app, [upd('transactions', 'tx-netflix', { amount: 99 })]);
  assert.equal(r.ok, false);
  assert.equal(st.map.get(KEY), before);
  assert.equal(app.H.getState().transactions.find(t => t.id === 'tx-netflix').amount, 12.5, 'l’affichage n’a pas adopté la valeur non enregistrée');
  assert.match(app.toasts[app.toasts.length - 1], /Enregistrement impossible/);
  st.mode = 'ok';
  assert.equal(applyAll(app, [upd('transactions', 'tx-netflix', { amount: 99 })]).ok, true, 'nouvelle tentative réussie une fois le stockage rétabli');
  assert.equal(stored(st).transactions.find(t => t.id === 'tx-netflix').amount, 99);
});
check('écriture silencieusement perdue : détectée par relecture, pas de succès', () => {
  const st = mkStore(); const app = boot(st); const before = st.map.get(KEY);
  st.mode = 'silent';
  assert.equal(applyAll(app, [upd('transactions', 'tx-netflix', { amount: 77 })]).ok, false);
  assert.equal(st.map.get(KEY), before);
  assert.equal(app.H.getState().transactions[0].amount === 77 || app.H.getState().transactions.some(t => t.amount === 77), false);
});
check('mode récupération (sauvegarde illisible) : aucune écriture depuis le chat, texte brut intact', () => {
  const corrupt = '{"version":1,"tasks":[null';
  const st = fakeStorage(corrupt); const app = boot(st);
  assert.equal(app.H.status().locked, true);
  const r = app.H.mutate(d => { d.settings.budgetLiving = 1; return { ok: true }; });
  assert.equal(r.ok, false); assert.match(r.error, /récupération/);
  assert.equal(st.map.get(KEY), corrupt);
});
check('mode incertain V1 préservé : relecture impossible après écriture -> plus d’écriture depuis le chat', () => {
  const st = mkStore(); const app = boot(st);
  st.mode = 'brick-after'; // le prochain setItem réussit, puis getItem lève
  const r1 = applyAll(app, [upd('transactions', 'tx-netflix', { amount: 20 })]);
  assert.equal(r1.ok, false);
  assert.equal(app.H.status().uncertain, true);
  const n = [...st.map.values()].length;
  const r2 = app.H.mutate(d => { d.transactions[0].amount = 1; return { ok: true }; });
  assert.equal(r2.ok, false); assert.match(r2.error, /incertain/);
  assert.equal([...st.map.values()].length, n);
});
check('deux mises à jour concurrentes du même montant : la seconde est refusée (conflit), la première reste', () => {
  const st = mkStore(); const app = boot(st);
  const state = app.H.getState();
  const pA = upd('transactions', 'tx-netflix', { amount: 15 }), pB = upd('transactions', 'tx-netflix', { amount: 18 });
  const prepA = A.prepare(state, pA, TODAY), prepB = A.prepare(state, pB, TODAY); // les deux affichées avec l’ancienne valeur 12,5
  const run = (p, prep) => app.H.mutate(d => A.apply(d, p, prep.base));
  assert.equal(run(pA, prepA).ok, true);
  const rb = run(pB, prepB);
  assert.equal(rb.ok, false); assert.equal(rb.conflict, true);
  assert.equal(stored(st).transactions.find(t => t.id === 'tx-netflix').amount, 15);
  // champs différents du même enregistrement : pas de conflit
  const pL = upd('transactions', 'tx-netflix', { label: 'Netflix Premium' });
  assert.equal(run(pL, A.prepare(app.H.getState(), pL, TODAY)).ok, true);
});
check('élément supprimé entre l’affichage et la confirmation : refusé (état périmé)', () => {
  const st = mkStore(); const app = boot(st);
  const pU = upd('transactions', 'tx-penny', { amount: 40 }); const prep = A.prepare(app.H.getState(), pU, TODAY);
  const pD = P('propose_delete', { entity: 'transactions', id: 'tx-penny' });
  assert.equal(applyAll(app, [pD]).ok, true);
  const r = app.H.mutate(d => A.apply(d, pU, prep.base));
  assert.equal(r.ok, false); assert.match(r.error, /introuvable/i);
  assert.equal(stored(st).transactions.some(t => t.id === 'tx-penny'), false);
});
check('suppression : état de référence obligatoire, refusée si l’élément a changé entre-temps', () => {
  const st = mkStore(); const app = boot(st);
  const pD = P('propose_delete', { entity: 'transactions', id: 'tx-netflix' }); const prep = A.prepare(app.H.getState(), pD, TODAY);
  assert.equal(prep.destructive, true); assert.equal(prep.sensitive, true);
  assert.equal(app.H.mutate(d => A.apply(d, pD, null)).ok, false, 'sans base : refusé');
  assert.equal(applyAll(app, [upd('transactions', 'tx-netflix', { amount: 13 })]).ok, true);
  const r = app.H.mutate(d => A.apply(d, pD, prep.base)); assert.equal(r.ok, false); assert.equal(r.conflict, true);
  assert.equal(stored(st).transactions.some(t => t.id === 'tx-netflix'), true);
});
check('lot atomique : si une modification échoue, aucune du lot n’est enregistrée', () => {
  const st = mkStore(); const app = boot(st); const before = st.map.get(KEY);
  const ok = upd('transactions', 'tx-netflix', { amount: 15 });
  const bad = upd('transactions', 'tx-penny', { amount: 31 });
  const state = app.H.getState();
  const cards = [ok, bad].map(p => ({ p, prep: A.prepare(state, p, TODAY) }));
  // la seconde devient périmée (modifiée à la main) avant confirmation du lot
  assert.equal(app.H.mutate(d => { d.transactions.find(t => t.id === 'tx-penny').amount = 33; }).ok, true);
  const afterManual = st.map.get(KEY);
  const r = app.H.mutate(d => { for (const c of cards) { const x = A.apply(d, c.p, c.prep.base); if (!x.ok) return x; } return { ok: true }; });
  assert.equal(r.ok, false); assert.equal(r.conflict, true);
  assert.equal(st.map.get(KEY), afterManual, 'aucune modification du lot (même la première) n’a été écrite');
  assert.notEqual(afterManual, before);
});
check('données valides imposées : bornes, types, références, règles V1 (focus ≤ 2, date d’envoi, créneau)', () => {
  const st = mkStore(); const app = boot(st); const state = app.H.getState();
  const refused = (p, re) => { const r = A.prepare(state, p, TODAY); assert.equal(r.ok, false, JSON.stringify(p)); if (re) assert.match(r.error, re); };
  assert.throws(() => upd('transactions', 'tx-netflix', { amount: 0 }), /valeur entre/);
  assert.throws(() => upd('transactions', 'tx-netflix', { amount: 1e9 }), /valeur entre/);
  assert.throws(() => upd('tasks', 'task-a', { duration: 10 }), /valeur entre/);
  assert.throws(() => upd('settings', 'settings', { sleepHours: 7.25 }), /par pas/);
  assert.throws(() => upd('settings', 'settings', { sleepHours: 11 }), /valeur entre/);
  assert.throws(() => upd('applications', 'app-1', { url: 'ftp://x' }), /lien http/);
  assert.throws(() => upd('transactions', 'tx-netflix', { category: 'crypto' }), /valeur attendue/);
  refused(upd('tasks', 'task-a', { projectId: 'projet-fantome' }), /n’existe pas/);
  refused(upd('applications', 'app-1', { status: 'envoyée' }), /date d’envoi/);
  // focus : le seed a lernlabor + marketing en focus -> un 3e est refusé
  refused(upd('projects', 'mainclip', { tier: 'focus' }), /deux projets sont déjà en focus/);
  refused(P('propose_create', { entity: 'courseBlocks', values: [{ field: 'day', value: 3 }, { field: 'start', value: '11:00' }, { field: 'end', value: '10:00' }] }), /fin doit être après/);
  assert.equal(A.prepare(state, upd('applications', 'app-1', { status: 'envoyée', sentAt: '2026-11-12' }), TODAY).ok, true);
  assert.equal(A.prepare(state, upd('projects', 'lernlabor', { tier: 'supervision' }), TODAY).ok, true);
  assert.equal(A.prepare(state, upd('tasks', 'task-a', { projectId: 'lernlabor' }), TODAY).ok, false, 'valeur identique : « aucun changement »');
});
check('création : identifiant attribué par l’application, valeurs par défaut V1, refus si champ obligatoire absent', () => {
  const st = mkStore(); const app = boot(st);
  const p = P('propose_create', { entity: 'transactions', values: [{ field: 'date', value: '2026-11-12' }, { field: 'label', value: 'Café' }, { field: 'amount', value: 3.2 }] });
  assert.equal(applyAll(app, [p]).ok, true);
  const t = stored(st).transactions.find(x => x.label === 'Café');
  assert.ok(/^v[a-z0-9]+$/.test(t.id)); assert.equal(t.type, 'expense'); assert.equal(t.category, 'vie'); assert.equal(t.amount, 3.2);
  assert.throws(() => P('propose_create', { entity: 'transactions', values: [{ field: 'label', value: 'x' }] }), /obligatoire/);
  assert.throws(() => P('propose_create', { entity: 'tasks', id: 'force', values: [{ field: 'title', value: 'x' }] }), /inconnu|attribué/);
  const proj = P('propose_create', { entity: 'projects', values: [{ field: 'name', value: 'Nouveau chantier' }] });
  assert.equal(applyAll(app, [proj]).ok, true);
  const np = stored(st).projects.find(x => x.name === 'Nouveau chantier'); assert.equal(np.tier, 'incubator'); assert.equal(np.short, 'NO'); assert.deepEqual(np.steps, []);
});
check('modifier un réglage budgétaire : ancien/nouveau/conséquence exacts, persisté', () => {
  const st = mkStore(); const app = boot(st);
  const p = upd('settings', 'settings', { budgetLiving: 850 });
  const prep = A.prepare(app.H.getState(), p, TODAY);
  assert.equal(prep.sensitive, true); assert.equal(prep.sens, 'settings');
  assert.deepEqual(prep.rows, [{ label: 'Dépenses de vie / mois', old: A.money(800), next: A.money(850) }]);
  assert.match(prep.consequence, /Enveloppe totale/);
  assert.equal(applyAll(app, [p]).ok, true);
  assert.equal(stored(st).settings.budgetLiving, 850); assert.equal(stored(st).settings.workShifts.length, 3);
});
check('recalcul de semaine : ajouter un cours puis planifier -> le planificateur existant recalcule, rien d’inventé', () => {
  const st = mkStore(); const app = boot(st);
  const before = C.buildWeekPlan(app.H.getState(), '2026-11-12');
  assert.equal(before.days[3].blocks.some(b => b.name === 'Software Engineering'), false);
  const p = P('propose_create', { entity: 'courseBlocks', values: [{ field: 'title', value: 'Software Engineering' }, { field: 'day', value: 3 }, { field: 'start', value: '09:00' }, { field: 'end', value: '11:00' }] });
  const prep = A.prepare(app.H.getState(), p, TODAY);
  assert.equal(prep.sens, 'planning'); assert.match(prep.consequence, /Conflits dans la semaine en cours/);
  assert.equal(applyAll(app, [p]).ok, true);
  const after = C.buildWeekPlan(app.H.getState(), '2026-11-12');
  assert.equal(after.days[3].blocks.some(b => b.name === 'Software Engineering' && b.start === 540 && b.end === 660), true, 'bloc de cours placé');
  assert.equal(after.days[3].blocks.some(b => /Salle de sport/.test(b.name) && b.start < 660 && b.end > 540), false, 'les suggestions évitent le cours');
  // week replan : l’action « replan » ne modifie aucune donnée
  const rp = A.normalizeProposal({ kind: 'replan', weekStart: '2026-11-16' });
  const snapshot = st.map.get(KEY);
  assert.equal(app.H.showWeek(rp.weekStart), true);
  assert.equal(st.map.get(KEY), snapshot, 'replan = affichage, aucune écriture');
  assert.match(app.view(), /Ta semaine/); assert.match(app.view(), /16 nov\.|16/);
  // déplacer une tâche = proposition de modification de date, confirmée séparément
  const mv = upd('tasks', 'task-a', { date: '2026-11-13' });
  assert.equal(applyAll(app, [mv]).ok, true);
  const plan = C.buildWeekPlan(app.H.getState(), '2026-11-13');
  assert.equal(plan.days[4].blocks.some(b => b.name.startsWith('Vérifier le parcours bêta Lernlabor')) || plan.unscheduled.some(u => u.title.startsWith('Vérifier')), true);
});
check('navigation : rubriques valides seulement, aucune écriture', () => {
  const st = mkStore(); const app = boot(st); const snap = st.map.get(KEY);
  assert.equal(app.H.navigate('finance'), true); assert.match(app.view(), /Mon budget/);
  assert.equal(app.H.navigate('career'), true); assert.match(app.view(), /Mes candidatures/);
  assert.equal(app.H.navigate('admin'), false); assert.equal(app.H.navigate('__proto__'), false); assert.equal(app.H.navigate(''), false);
  assert.equal(app.H.status().view, 'career');
  assert.equal(st.map.get(KEY), snap);
});
check('case d’habitude : id « habitude:date » validé, annulable', () => {
  const st = mkStore(); const app = boot(st);
  const p = upd('habitChecks', 'gym:2026-11-12', { done: true });
  assert.equal(applyAll(app, [p]).ok, true); assert.equal(stored(st).habitChecks['gym:2026-11-12'], true);
  assert.equal(A.prepare(app.H.getState(), upd('habitChecks', 'inconnue:2026-11-12', { done: true }), TODAY).ok, false);
  assert.equal(A.prepare(app.H.getState(), upd('habitChecks', 'gym:2026-02-30', { done: true }), TODAY).ok, false);
});
check('annulation : mise à jour, création, suppression ; refus si l’état a changé depuis (conflit)', () => {
  const st = mkStore(); const app = boot(st);
  const undo = ops => app.H.mutate(d => { for (const op of ops.slice().reverse()) { const r = A.undoOp(d, op); if (!r.ok) return r; } return { ok: true }; });
  // update
  let r = applyAll(app, [upd('transactions', 'tx-netflix', { amount: 15, label: 'Netflix HD' })]); assert.equal(r.ok, true);
  assert.equal(undo(r.ops).ok, true);
  let t = stored(st).transactions.find(x => x.id === 'tx-netflix'); assert.equal(t.amount, 12.5); assert.equal(t.label, 'Netflix');
  // update puis modification manuelle : annulation refusée
  r = applyAll(app, [upd('transactions', 'tx-netflix', { amount: 16 })]);
  assert.equal(app.H.mutate(d => { d.transactions.find(x => x.id === 'tx-netflix').amount = 17; }).ok, true);
  const bad = undo(r.ops); assert.equal(bad.ok, false); assert.equal(bad.conflict, true);
  assert.equal(stored(st).transactions.find(x => x.id === 'tx-netflix').amount, 17);
  // delete -> reinsertion à la même position
  const idx = stored(st).transactions.findIndex(x => x.id === 'tx-penny');
  r = applyAll(app, [P('propose_delete', { entity: 'transactions', id: 'tx-penny' })]); assert.equal(r.ok, true);
  assert.equal(stored(st).transactions.some(x => x.id === 'tx-penny'), false);
  assert.equal(undo(r.ops).ok, true);
  assert.equal(stored(st).transactions.findIndex(x => x.id === 'tx-penny'), idx);
  assert.equal(stored(st).transactions[idx].amount, 30);
  // create -> suppression de l’élément créé ; refusé s’il a été modifié
  r = applyAll(app, [P('propose_create', { entity: 'ideas', values: [{ field: 'title', value: 'Idée test' }] })]); assert.equal(r.ok, true);
  assert.equal(undo(r.ops).ok, true); assert.equal(stored(st).ideas.some(x => x.title === 'Idée test'), false);
  // créneau de cours (index) : création + annulation
  r = applyAll(app, [P('propose_create', { entity: 'courseBlocks', values: [{ field: 'day', value: 1 }, { field: 'start', value: '14:00' }, { field: 'end', value: '16:00' }] })]);
  assert.equal(stored(st).settings.courseBlocks.length, 1); assert.equal(undo(r.ops).ok, true); assert.equal(stored(st).settings.courseBlocks.length, 0);
});
check('créneaux indexés (cours / travail) : modification et suppression avec contrôle de l’état exact', () => {
  const st = mkStore(); const app = boot(st);
  let r = applyAll(app, [upd('workShifts', 'ws-1', { end: '16:00', confirmed: true })]); assert.equal(r.ok, true);
  assert.equal(stored(st).settings.workShifts[1].end, '16:00'); assert.equal(stored(st).settings.workShifts[1].confirmed, true);
  assert.equal(A.prepare(app.H.getState(), upd('workShifts', 'ws-9', { end: '16:00' }), TODAY).ok, false);
  assert.equal(A.prepare(app.H.getState(), upd('workShifts', 'ws-1', { end: '04:00' }), TODAY).ok, false, 'fin avant début refusée');
  const del = P('propose_delete', { entity: 'workShifts', id: 'ws-0' }); const prep = A.prepare(app.H.getState(), del, TODAY);
  assert.equal(prep.destructive, true);
  assert.equal(applyAll(app, [del]).ok, true); assert.equal(stored(st).settings.workShifts.length, 2);
  // le même identifiant vise maintenant un autre créneau : l’ancien aperçu est périmé
  assert.equal(app.H.mutate(d => A.apply(d, del, prep.base)).ok, false);
  assert.equal(stored(st).settings.workShifts.length, 2);
});
check('aucune mutation hors brouillon : apply sur copie, état source intact ; prepare/snapshot purs', () => {
  const st = mkStore(); const app = boot(st); const s = app.H.getState(); const frozen = JSON.stringify(s);
  A.prepare(s, upd('transactions', 'tx-netflix', { amount: 15 }), TODAY); A.buildSnapshot(s, { message: 'tout', view: 'today', today: TODAY });
  assert.equal(JSON.stringify(s), frozen);
  const draft = C.structuredCopy(s); const p = upd('transactions', 'tx-netflix', { amount: 15 });
  assert.equal(A.apply(draft, p, { amount: 12.5 }).ok, true);
  assert.equal(JSON.stringify(s), frozen);
  assert.notEqual(JSON.stringify(draft), frozen);
  assert.equal(A.apply(C.structuredCopy(s), p, { amount: 11 }).conflict, true);
});
check('l’état renvoyé par le pont est une copie : le modifier ne change pas l’application', () => {
  const st = mkStore(); const app = boot(st);
  const s = app.H.getState(); s.transactions[0].amount = 1; s.settings.budgetLiving = 1;
  assert.equal(app.H.getState().transactions[0].amount === 1, false); assert.equal(app.H.getState().settings.budgetLiving, 800);
  assert.throws(() => { app.win.VieHost.mutate = () => 1; }, TypeError, 'pont figé (mode strict)');
});
check('import V1 inchangé : fichier invalide refusé même après des actions de Vie (pas de contournement)', () => {
  const st = mkStore(); const app = boot(st);
  assert.equal(applyAll(app, [upd('transactions', 'tx-netflix', { amount: 15 })]).ok, true);
  const bad = JSON.parse(st.map.get(KEY)); bad.transactions[0].amount = -4;
  assert.throws(() => C.validateImported(bad), /Nombre invalide/);
  const r = app.H.mutate(d => { d.transactions[0].amount = -4; return { ok: true }; });
  assert.equal(r.ok, false, 'même un appelant direct du pont ne peut pas écrire une donnée invalide (saveStored valide)');
  assert.equal(stored(st).transactions[0].amount > 0, true);
});
check('contexte : tout est borné et ne contient ni notes, ni liens, ni prénom ; sections ciblées', () => {
  const s = withData(); s.settings.displayName = 'Jordan'; s.tasks[0].notes = 'NOTE-PERSO-XYZ'; s.applications[0].url = 'https://x.example/?t=1'; s.applications[0].notes = 'secret';
  for (let i = 0; i < 200; i++) s.transactions.push({ id: 'z' + i, date: '2026-10-01', label: 'L'.repeat(500), amount: 1, type: 'expense', category: 'vie' });
  const snap = A.buildSnapshot(s, { message: 'bilan de tout', view: 'today', today: TODAY });
  const txt = JSON.stringify(snap);
  for (const f of ['Jordan', 'NOTE-PERSO-XYZ', 'x.example', 'secret']) assert.ok(!txt.includes(f), f);
  assert.ok(snap.transactions.length <= 60); assert.ok(snap.transactions.every(t => t.label.length <= 160));
  assert.ok(txt.length < 60000, 'taille ' + txt.length);
  assert.doesNotThrow(() => A.validateSnapshot(JSON.parse(txt)));
  const narrow = A.buildSnapshot(s, { message: 'comment va ma candidature chez Acme ?', view: 'today', today: TODAY });
  assert.deepEqual(narrow.sections, ['applications']);
});

// =================================================================================================================================
// Régressions de la stabilisation sécurité/vie privée (audit indépendant Codex) : chaque test ci-dessous ÉCHOUE sur le code d'avant correctif.
// =================================================================================================================================
const CANARY = 'CANARY-NOTES-7f3a91c2';
const privateState = () => {
  const s = withData();
  s.ideas = [{ id: 'idea-c', title: 'Idée visible', notes: CANARY + '-idee', status: 'En réflexion' }];
  s.tasks[0].notes = CANARY + '-tache'; s.applications[0].notes = CANARY + '-candidature'; s.applications[0].url = 'https://perso.example/' + CANARY;
  s.projects[0].description = CANARY + '-description'; s.projects[0].evidence = CANARY + '-preuve'; s.projects[0].target = CANARY + '-cible';
  s.settings.displayName = CANARY + '-prenom'; s.review = [{ id: 'r1', date: '2026-11-09', wins: CANARY + '-revue', pressure: '', priorities: '' }];
  return s;
};
check('vie privée : un marqueur synthétique dans notes (idées, tâches, candidatures), descriptions, liens, prénom et revue n’apparaît dans aucun contexte, y compris « mes idées »', () => {
  const s = privateState();
  for (const message of ['mes idées', 'quelles sont mes idées ?', 'bilan de tout', 'idées tâches candidatures projets budget', 'bonjour']) {
    for (const view of ['today', 'ideas', 'career']) {
      const snap = A.buildSnapshot(s, { message, view, today: TODAY });
      assert.ok(!JSON.stringify(snap).includes(CANARY), `canari dans le contexte (${message} / ${view})`);
      assert.doesNotThrow(() => A.validateSnapshot(JSON.parse(JSON.stringify(snap))));
    }
  }
  const ideas = A.buildSnapshot(s, { message: 'mes idées', view: 'today', today: TODAY });
  assert.deepEqual(ideas.ideas, [{ id: 'idea-c', title: 'Idée visible', status: 'En réflexion' }], 'titre et statut seulement');
});
check('vie privée : le validateur refuse ideas[].notes et toute clé privée à n’importe quelle profondeur (le serveur ne peut pas être contourné par un client forgé)', () => {
  const mk = f => { const x = A.buildSnapshot(withData(), { message: 'bilan de tout', view: 'today', today: TODAY }); f(x); return x; };
  assert.ok(mk(() => {}).ideas.length >= 1);
  const fakeKey = 'sk-' + 'ant-' + 'FAKEFAKE1234567';
  const bads = {
    'ideas[].notes': x => { x.ideas[0].notes = CANARY; },
    'tasks[].notes': x => { x.tasks[0].notes = CANARY; },
    'overview.notes': x => { x.overview.notes = CANARY; },
    'overview.secret': x => { x.overview.secretField = 1; },
    'overview.tasks.private': x => { x.overview.tasks.prive = 'x'; },
    'overview texte': x => { x.overview.projets = '5'; },
    'overview négatif': x => { x.overview.cours = -1; },
    'overview énorme': x => { x.overview.idees = 1e9; },
    'derived clé libre': x => { x.derived.freeform = CANARY; },
    'derived.monthExpenses clé libre': x => { x.derived.monthExpenses.commentaire = 'x'; },
    'derived.byCategory clé libre': x => { x.derived.monthExpenses.byCategory[CANARY] = 5; },
    'derived.plan clé libre': x => { x.derived.plan.notes = 'x'; },
    'derived.plan.aReplanifier[].notes': x => { x.derived.plan.aReplanifier = [{ date: '2026-11-10', title: 't', reason: 'r', notes: CANARY }]; },
    'derived.plan.conflits trop long': x => { x.derived.plan.conflits = ['a', 'b', 'c', 'd', 'e', 'f', 'g']; },
    'derived.plan.weekStart libre': x => { x.derived.plan.weekStart = 'demain'; },
    'derived.month libre': x => { x.derived.monthExpenses.month = 'novembre'; },
    'derived profond': x => { x.derived.plan.aReplanifier = [{ date: 'x', title: { a: { b: { c: { d: { e: 1 } } } } }, reason: 'r' }]; },
    'settings.displayName': x => { x.settings.displayName = CANARY; },
    'settings.commuteMinutes': x => { x.settings.commuteMinutes = 30; },
    'settings.targetType non texte': x => { x.settings.targetType = { a: 1 }; },
    'motif de clé API dans un titre': x => { x.tasks[0].title = fakeKey; },
    'clé privée dans une ligne': x => { x.projects[0].description = 'x'; },
    'champ de niveau supérieur': x => { x.notes = CANARY; },
  };
  for (const [name, f] of Object.entries(bads)) assert.throws(() => A.validateSnapshot(mk(f)), A.ActionError, name);
  // un objet à la place d’une chaîne dans habitChecks est refusé
  assert.throws(() => A.validateSnapshot(mk(x => { x.habitChecks = [{ notes: 'x' }]; })), A.ActionError);
});
check('vie privée : catégories libres ramenées à la liste fermée (jamais de clé libre dans le résumé du mois)', () => {
  const s = withData(); s.transactions.push({ id: 'tx-z', date: '2026-11-05', label: 'Truc', amount: 5, type: 'expense', category: CANARY + '-categorie' });
  const snap = A.buildSnapshot(s, { message: 'mes dépenses', view: 'finance', today: TODAY });
  assert.ok(!JSON.stringify(snap).includes(CANARY));
  assert.equal(snap.derived.monthExpenses.byCategory.autre, 5);
  assert.equal(snap.transactions.find(t => t.id === 'tx-z').category, 'autre');
  assert.doesNotThrow(() => A.validateSnapshot(snap));
});

// --- Identifiants en double --------------------------------------------------------------------------------------------------
check('identifiants en double : import de deux dépenses de même id (10 et 20) refusé proprement, rien n’est remplacé ni modifié', async () => {
  const st = mkStore(); const app = boot(st); const before = st.map.get(KEY); const viewBefore = app.view(); const txBefore = JSON.stringify(app.H.getState().transactions);
  const bad = withData(); bad.transactions = [{ id: 'dup', date: '2026-11-10', label: 'A', amount: 10, type: 'expense', category: 'vie' }, { id: 'dup', date: '2026-11-11', label: 'B', amount: 20, type: 'expense', category: 'vie' }];
  const text = JSON.stringify(bad);
  await app.el('#file-import').handlers.change({ target: { files: [{ size: Buffer.byteLength(text), text: async () => text }], value: 'x' } });
  assert.match(app.toasts[app.toasts.length - 1], /Import refusé.*en double/);
  assert.equal(st.map.get(KEY), before, 'stockage inchangé'); assert.equal(app.view(), viewBefore, 'affichage inchangé');
  assert.equal(JSON.stringify(app.H.getState().transactions), txBefore, 'état inchangé');
  // un import valide fonctionne toujours (compatibilité des sauvegardes V1)
  const ok = JSON.stringify(withData());
  await app.el('#file-import').handlers.change({ target: { files: [{ size: Buffer.byteLength(ok), text: async () => ok }], value: 'x' } });
  assert.match(app.toasts[app.toasts.length - 1], /importées/);
});
check('identifiants en double déjà présents dans l’état : locate refuse l’ambiguïté, prepare/apply/undo refusent sans modifier AUCUNE des deux lignes', () => {
  const s = withData(); s.transactions.push({ ...s.transactions[0], amount: 99 }); // deux lignes « tx-netflix » : 12.5 et 99
  const ent = A.ENT.transactions;
  assert.throws(() => A.locate(s, ent, 'tx-netflix'), /ambigu/);
  assert.equal(A.locate(s, ent, 'tx-penny').rec.amount, 30, 'un identifiant unique reste utilisable');
  const p = upd('transactions', 'tx-netflix', { amount: 15 });
  const prep = A.prepare(s, p, TODAY); assert.equal(prep.ok, false); assert.match(prep.error, /ambigu/);
  const draft = C.structuredCopy(s), snap = JSON.stringify(draft);
  let r = A.apply(draft, p, { amount: 12.5 }); assert.equal(r.ok, false); assert.match(r.error, /ambigu/); assert.equal(JSON.stringify(draft), snap, 'brouillon intact (update)');
  r = A.apply(draft, P('propose_delete', { entity: 'transactions', id: 'tx-netflix' }), { __rec: JSON.stringify(s.transactions[0]) }); assert.equal(r.ok, false); assert.equal(JSON.stringify(draft), snap, 'brouillon intact (delete)');
  r = A.undoOp(draft, { kind: 'update', entity: 'transactions', id: 'tx-netflix', before: { amount: 12.5 }, after: { amount: 15 } }); assert.equal(r.ok, false); assert.equal(JSON.stringify(draft), snap, 'brouillon intact (undo)');
  r = A.undoOp(draft, { kind: 'create', entity: 'transactions', id: 'tx-netflix', afterRecord: s.transactions[0] }); assert.equal(r.ok, false); assert.equal(JSON.stringify(draft), snap);
  const h = withData(); h.habits.push({ ...h.habits[0] });
  assert.throws(() => A.locate(h, A.ENT.habitChecks, h.habits[0].id + ':2026-11-10'), /ambigu/);
});

// --- Dérive de cible des créneaux indexés (cb-N / ws-N) ---------------------------------------------------------------------------
const twoBlocks = () => { const s = withData(); s.settings.courseBlocks = [{ title: 'Algo', day: 1, start: '08:00', end: '10:00' }, { title: 'Réseaux', day: 2, start: '09:00', end: '10:00' }]; return s; };
const twoShifts = () => { const s = withData(); s.settings.workShifts = [{ day: 0, start: '06:00', end: '10:00', confirmed: false }, { day: 1, start: '07:00', end: '10:00', confirmed: true }]; return s; };
const removeFirst = (app, coll) => assert.equal(app.H.mutate(d => { d.settings[coll].splice(0, 1); return { ok: true }; }).ok, true);
for (const [label, make, ent, coll, rest] of [['cours', twoBlocks, 'courseBlocks', 'courseBlocks', { title: 'Réseaux', day: 2, start: '09:00', end: '10:00' }], ['horaires de travail', twoShifts, 'workShifts', 'workShifts', { day: 1, start: '07:00', end: '10:00', confirmed: true }]]) {
  const prefix = ent === 'courseBlocks' ? 'cb' : 'ws';
  check(`dérive de cible (${label}) : aperçu de ${prefix}-0 (fin 10:00 → 11:00), le premier élément est supprimé, le suivant prend sa place avec la même fin -> confirmation refusée, l’autre élément INCHANGÉ`, () => {
    const st = mkStore(make()); const app = boot(st);
    const p = upd(ent, `${prefix}-0`, { end: '11:00' });
    const prep = A.prepare(app.H.getState(), p, TODAY); assert.equal(prep.ok, true); assert.equal(prep.base.end, '10:00');
    removeFirst(app, coll);
    const r = app.H.mutate(d => A.apply(d, p, prep.base));
    assert.equal(r.ok, false, 'la modification ne doit pas viser l’autre élément'); assert.equal(r.conflict, true);
    assert.deepEqual(stored(st).settings[coll], [rest], 'l’élément qui a glissé en position 0 est intact');
  });
}
check('dérive de cible : suppression approuvée sur cb-0 alors que le premier élément a disparu et que l’élément suivant lui est identique -> refusée, le jumeau survit', () => {
  const twin = { title: 'TD', day: 3, start: '14:00', end: '16:00' };
  const s = withData(); s.settings.courseBlocks = [{ ...twin }, { ...twin }];
  const st = mkStore(s); const app = boot(st);
  const del = P('propose_delete', { entity: 'courseBlocks', id: 'cb-0' }); const prep = A.prepare(app.H.getState(), del, TODAY); assert.equal(prep.ok, true);
  removeFirst(app, 'courseBlocks');
  assert.equal(app.H.mutate(d => A.apply(d, del, prep.base)).ok, false);
  assert.equal(stored(st).settings.courseBlocks.length, 1, 'le jumeau n’est pas supprimé à la place');
});
check('dérive de cible : proposition créée sans empreinte de liste (ancienne base) refusée pour un créneau indexé', () => {
  const st = mkStore(twoBlocks()); const app = boot(st);
  const p = upd('courseBlocks', 'cb-0', { end: '11:00' });
  const r = app.H.mutate(d => A.apply(d, p, { end: '10:00' }));
  assert.equal(r.ok, false); assert.equal(stored(st).settings.courseBlocks[0].end, '10:00');
});
check('annulation d’un créneau indexé refusée si la liste a changé, même si l’élément qui a glissé est identique à l’état laissé par Vie', () => {
  const s = withData(); s.settings.courseBlocks = [{ title: 'Algo', day: 1, start: '08:00', end: '10:00' }, { title: 'Algo', day: 1, start: '08:00', end: '11:00' }];
  const st = mkStore(s); const app = boot(st);
  const r = applyAll(app, [upd('courseBlocks', 'cb-0', { end: '11:00' })]); assert.equal(r.ok, true); // cb-0 devient identique à cb-1
  removeFirst(app, 'courseBlocks');
  const u = app.H.mutate(d => A.undoOp(d, r.ops[0]));
  assert.equal(u.ok, false); assert.equal(u.conflict, true);
  assert.deepEqual(stored(st).settings.courseBlocks, [{ title: 'Algo', day: 1, start: '08:00', end: '11:00' }], 'l’élément restant n’est pas « annulé » à tort');
  // sans empreinte (opération enregistrée par une ancienne version) : refus, jamais d’annulation à l’aveugle
  const legacy = { ...r.ops[0] }; delete legacy.collAfter;
  assert.equal(app.H.mutate(d => A.undoOp(d, legacy)).ok, false);
});
check('annulation de suppression / création de créneaux : exige la même liste exacte qu’après l’opération', () => {
  const st = mkStore(twoBlocks()); const app = boot(st);
  const del = applyAll(app, [P('propose_delete', { entity: 'courseBlocks', id: 'cb-0' })]); assert.equal(del.ok, true);
  assert.equal(app.H.mutate(d => { d.settings.courseBlocks.push({ title: 'Autre', day: 4, start: '10:00', end: '11:00' }); return { ok: true }; }).ok, true);
  assert.equal(app.H.mutate(d => A.undoOp(d, del.ops[0])).ok, false, 'liste modifiée depuis la suppression');
  assert.equal(stored(st).settings.courseBlocks.length, 2);
  const st2 = mkStore(twoBlocks()); const app2 = boot(st2);
  const del2 = applyAll(app2, [P('propose_delete', { entity: 'courseBlocks', id: 'cb-0' })]);
  assert.equal(app2.H.mutate(d => A.undoOp(d, del2.ops[0])).ok, true, 'liste intacte : annulation possible');
  assert.deepEqual(stored(st2).settings.courseBlocks, twoBlocks().settings.courseBlocks);
});
check('lot sur une même liste indexée : suppression + deux modifications visent les bons éléments, l’annulation du lot restitue la liste exacte, un lot périmé est refusé en bloc', () => {
  const s = withData(); s.settings.courseBlocks = [{ title: 'A', day: 0, start: '08:00', end: '09:00' }, { title: 'B', day: 1, start: '08:00', end: '09:00' }, { title: 'C', day: 2, start: '08:00', end: '09:00' }];
  const st = mkStore(s); const app = boot(st);
  const r = applyAll(app, [P('propose_delete', { entity: 'courseBlocks', id: 'cb-0' }), upd('courseBlocks', 'cb-2', { end: '12:00' }), upd('courseBlocks', 'cb-1', { title: 'B2' })]);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(stored(st).settings.courseBlocks, [{ title: 'B2', day: 1, start: '08:00', end: '09:00' }, { title: 'C', day: 2, start: '08:00', end: '12:00' }]);
  const u = app.H.mutate(d => { for (const op of r.ops.slice().reverse()) { const x = A.undoOp(d, op); if (!x.ok) return x; } return { ok: true }; });
  assert.equal(u.ok, true, u.error); assert.deepEqual(stored(st).settings.courseBlocks, s.settings.courseBlocks);
  // lot préparé, puis la liste change avant confirmation : tout est refusé, rien n’est appliqué
  const props = [upd('courseBlocks', 'cb-1', { end: '10:00' }), upd('courseBlocks', 'cb-2', { end: '10:00' })];
  const preps = props.map(p => A.prepare(app.H.getState(), p, TODAY));
  removeFirst(app, 'courseBlocks'); const mid = JSON.stringify(stored(st).settings.courseBlocks);
  const bad = app.H.mutate(d => { const batch = A.beginBatch(d); for (let i = 0; i < props.length; i++) { const x = A.apply(d, props[i], preps[i].base, batch); if (!x.ok) return x; } return { ok: true }; });
  assert.equal(bad.ok, false); assert.equal(JSON.stringify(stored(st).settings.courseBlocks), mid);
});
check('réponse tardive : une proposition sur cb-N / ws-N est refusée si la liste a changé depuis l’envoi de la demande ; les autres propositions ne sont pas concernées', () => {
  const s = twoBlocks(); const fp0 = A.fingerprints(s);
  const p = upd('courseBlocks', 'cb-0', { end: '11:00' }), d = P('propose_delete', { entity: 'courseBlocks', id: 'cb-1' });
  assert.equal(A.staleIndexed(fp0, s, p), null); assert.equal(A.staleIndexed(fp0, s, d), null);
  const s2 = C.structuredCopy(s); s2.settings.courseBlocks.splice(0, 1);
  assert.match(A.staleIndexed(fp0, s2, p), /a changé pendant que Vie répondait/); assert.match(A.staleIndexed(fp0, s2, d), /a changé pendant que Vie répondait/);
  assert.match(A.staleIndexed(undefined, s, p), /Impossible de vérifier/);
  const s3 = twoShifts(), fpw = A.fingerprints(s3), s4 = C.structuredCopy(s3); s4.settings.workShifts[0].start = '05:00';
  assert.match(A.staleIndexed(fpw, s4, upd('workShifts', 'ws-1', { end: '11:00' })), /workShifts|travail/);
  assert.equal(A.staleIndexed(fp0, s2, upd('transactions', 'tx-netflix', { amount: 1 })), null, 'liste par identifiant : non concernée');
  assert.equal(A.staleIndexed(fp0, s2, P('propose_create', { entity: 'courseBlocks', values: [{ field: 'day', value: 1 }, { field: 'start', value: '08:00' }, { field: 'end', value: '09:00' }] })), null, 'création : aucune position visée');
  assert.equal(A.fingerprints(s)['courseBlocks'], A.fingerprints(C.structuredCopy(s))['courseBlocks'], 'empreinte stable (clés triées, structure exacte)');
});

// --- Identifiants positionnels : une seule écriture canonique ------------------------------------------------------------------------
check('identifiants positionnels : « cb-007 », « cb-07 », « cb-00 » ne désignent rien (une cible = un seul nom), « cb-7 » reste valide ; aucune modification', () => {
  const s = withData(); s.settings.courseBlocks = Array.from({ length: 9 }, (_, i) => ({ title: 'C' + i, day: i % 7, start: '08:00', end: '09:00' }));
  const ent = A.ENT.courseBlocks;
  assert.equal(A.locate(s, ent, 'cb-7').index, 7); assert.equal(A.locate(s, ent, 'cb-0').index, 0);
  for (const bad of ['cb-007', 'cb-07', 'cb-00', 'cb-0007', 'cb-1000', 'cb--1', 'cb-7 ', 'cb-7.0', 'CB-7', 'ws-7']) assert.equal(A.locate(s, ent, bad), null, bad);
  const snap = JSON.stringify(s);
  for (const id of ['cb-07', 'cb-007']) {
    const prep = A.prepare(s, upd('courseBlocks', id, { end: '10:00' }), TODAY); assert.equal(prep.ok, false, id); assert.match(prep.error, /introuvable/);
    const draft = C.structuredCopy(s); const r = A.apply(draft, upd('courseBlocks', id, { end: '10:00' }), { end: '09:00', __coll: A.fingerprints(s).courseBlocks }); assert.equal(r.ok, false); assert.equal(JSON.stringify(draft), snap, 'brouillon intact');
  }
  // deux écritures du même indice dans un lot ne peuvent plus viser deux fois le même élément sous deux noms
  const ok = A.prepare(s, upd('courseBlocks', 'cb-7', { end: '10:00' }), TODAY); assert.equal(ok.ok, true);
});

// --- Avis de partage : l'interface n'annonce que ce que le code envoie, et envoie tout ce qu'elle annonce -----------------------------
const richState = () => {
  const s = withData();
  s.ideas = [{ id: 'i1', title: 'Idée', notes: 'NOTE-PRIVEE-ZZ', status: 'En réflexion' }]; s.tasks[0].notes = 'NOTE-PRIVEE-ZZ'; s.settings.displayName = 'PRENOM-ZZ';
  s.tasks.push({ id: 'big', title: 'Gros bloc', projectId: '', category: 'projects', priority: 'haute', duration: 480, date: '2026-11-12', done: false, origin: 'x', notes: '' });
  s.settings.courseBlocks = [{ title: 'Algo', day: 0, start: '06:00', end: '08:00' }]; // chevauche l'horaire de travail du lundi -> conflit
  s.habitChecks['gym:2026-11-09'] = true;
  return s;
};
const leafPaths = (v, prefix = '', out = new Set()) => {
  if (Array.isArray(v)) { if (v.some(x => x !== null && typeof x === 'object' && !Array.isArray(x))) v.forEach(x => leafPaths(x, prefix, out)); else out.add(prefix); }
  else if (v !== null && typeof v === 'object' && !prefix.endsWith('byCategory')) for (const k of Object.keys(v)) leafPaths(v[k], prefix ? prefix + '.' + k : k, out);
  else out.add(prefix);
  return out;
};
check('avis de partage : chaque champ réellement présent dans le contexte (tout partagé) a un libellé dans l’avis, et chaque libellé correspond à un champ réel', () => {
  const L = A.SHARE_LABELS, st = richState();
  const snap = A.buildSnapshot(st, { message: 'fais le bilan de tout', view: 'today', today: TODAY });
  A.validateSnapshot(snap);
  assert.deepEqual(snap.sections.slice().sort(), A.SECTION_NAMES.slice().sort(), 'toutes les rubriques sont envoyées dans ce scénario');
  const top = new Set(['today', 'view', 'sections', 'overview', 'derived', 'settings', 'habitChecks', ...Object.keys(A.SNAP_FIELDS)]);
  for (const k of Object.keys(snap)) assert.ok(top.has(k), 'clé de premier niveau inattendue : ' + k);
  // lignes de listes : champs réellement produits  ⊆  champs annoncés
  const usedRows = new Set();
  for (const k of Object.keys(A.SNAP_FIELDS)) {
    assert.deepEqual(Object.keys(L.rows[k][1]).sort(), Object.keys(A.SNAP_FIELDS[k]).sort(), `libellés = champs autorisés pour ${k}`);
    for (const row of snap[k] || []) for (const f of Object.keys(row)) { assert.ok(f in L.rows[k][1], `champ envoyé sans libellé : ${k}.${f}`); usedRows.add(k + '.' + f); }
  }
  // schéma fermé : overview / derived / settings
  const emitted = { overview: leafPaths(snap.overview), derived: leafPaths(snap.derived), settings: leafPaths(snap.settings) };
  for (const [part, set] of Object.entries(emitted)) for (const p of set) assert.ok(p in L[part], `champ envoyé sans libellé : ${part}.${p}`);
  assert.deepEqual([...emitted.overview].sort(), Object.keys(L.overview).sort(), 'compteurs annoncés = compteurs envoyés');
  assert.deepEqual([...emitted.derived].sort(), Object.keys(L.derived).sort(), 'calculs annoncés = calculs envoyés (le scénario produit un conflit et une tâche à replanifier)');
  assert.deepEqual([...emitted.settings].sort(), Object.keys(L.settings).sort(), 'réglages annoncés = réglages envoyés');
  assert.ok(Array.isArray(snap.habitChecks) && snap.habitChecks.length > 0 && L.habitChecks.length > 10, 'cases cochées annoncées');
  // le schéma serveur ne laisse rien passer de plus : mêmes feuilles que les libellés
  const schemaLeaves = (sc, prefix, out = []) => { if (sc.t === 'o') for (const [k, v] of Object.entries(sc.shape)) schemaLeaves(v, prefix ? prefix + '.' + k : k, out); else if (sc.t === 'a' && sc.item.t === 'o') schemaLeaves(sc.item, prefix, out); else out.push(prefix); return out; };
  for (const part of ['overview', 'derived', 'settings']) assert.deepEqual(schemaLeaves(A.SCHEMA[part], '').sort(), Object.keys(L[part]).sort(), `schéma fermé = libellés (${part})`);
});
check('avis de partage : le texte généré cite chaque libellé, la limite de chaque liste, ce qui n’est jamais envoyé ; aucun champ privé n’est annoncé comme envoyé', () => {
  const n = A.shareNotice(), L = A.SHARE_LABELS, text = n.items.map(i => i.title + ' : ' + i.text).join('\n');
  for (const [k, [title, fields]] of Object.entries(L.rows)) { assert.ok(text.toLowerCase().includes(title.toLowerCase()), 'rubrique : ' + title); for (const lab of Object.values(fields)) assert.ok(text.includes(lab), `${k} : ${lab}`); assert.ok(text.includes(`(${A.SNAP_CAP[k]} au plus)`), 'limite : ' + k); }
  for (const part of ['overview', 'derived', 'settings']) for (const lab of Object.values(L[part])) assert.ok(text.includes(lab), `${part} : ${lab}`);
  assert.ok(text.includes(L.habitChecks));
  const never = n.never.join('\n'); for (const w of ['notes', 'descriptions', 'liens', 'prénom', 'revues', 'clé API']) assert.ok(never.includes(w), 'jamais envoyé : ' + w);
  // aucun champ privé (notes, liens, description, prénom) dans les libellés de ce qui est envoyé
  for (const [k, [, fields]] of Object.entries(L.rows)) for (const f of Object.keys(fields)) assert.ok(!/^(notes?|url|description|displayName|evidence|target|steps)$/i.test(f), `${k}.${f} ne doit pas être annoncé comme envoyé`);
  assert.ok(!/notes/i.test(text), 'le mot « notes » n’apparaît que dans la liste des champs jamais envoyés');
});

check('partage coupé : outils = navigation, recalcul, création + propose_update FERMÉ sur les réglages (jamais de suppression, jamais un autre élément) ; partage actif : jeu complet', () => {
  const off = A.toolDefs(false), on = A.toolDefs(true);
  assert.deepEqual(off.map(t => t.name), ['navigate_section', 'replan_week', 'propose_create', 'propose_update']);
  assert.ok(!off.some(t => t.name === 'propose_delete'));
  const u = off.find(t => t.name === 'propose_update').input_schema;
  assert.deepEqual(u.properties.entity.enum, ['settings']); assert.deepEqual(u.properties.id.enum, ['settings']); assert.equal(u.additionalProperties, false);
  assert.deepEqual(on.map(t => t.name), ['navigate_section', 'replan_week', 'propose_create', 'propose_update', 'propose_delete']);
  assert.ok(on.find(t => t.name === 'propose_update').input_schema.properties.entity.enum.length > 1);
  // les champs de réglage décrits sans partage sont exactement ceux de la liste blanche (pas de fiche, pas de notes)
  const d = off.find(t => t.name === 'propose_update').description; assert.match(d, /budgetProjects/); assert.ok(!/notes|transactions|tasks/i.test(d.split('Champs autorisés')[1] || ''));
});
check('réglage proposé sans partage : traité comme une donnée financière (confirmation explicite), avant/après lus localement, RIEN écrit avant confirmation ; économies / mois borné', () => {
  const st = mkStore(); const app = boot(st);
  const before = JSON.stringify(stored(st).settings);
  const p = upd('settings', 'settings', { budgetProjects: 300, savingsMonthly: 120 });
  const prep = A.prepare(app.H.getState(), p, TODAY);
  assert.equal(prep.ok, true); assert.equal(prep.sensitive, true); assert.equal(prep.sens, 'settings');
  assert.equal(prep.rows.length, 2); assert.ok(prep.rows.every(r => r.old !== undefined && r.next !== undefined));
  assert.equal(JSON.stringify(stored(st).settings), before, 'la prévisualisation n’écrit rien');
  assert.throws(() => upd('settings', 'settings', { savingsMonthly: -1 }), /valeur entre/);
  assert.throws(() => upd('settings', 'settings', { savingsMonthly: 2e6 }), /valeur entre/);
  assert.equal(applyAll(app, [p]).ok, true); assert.equal(stored(st).settings.savingsMonthly, 120); assert.equal(stored(st).settings.budgetProjects, 300);
});

(async () => {
  let failed = 0;
  for (const t of tests) { try { await t.fn(); console.log('PASS  ' + t.name); } catch (e) { failed++; console.log('FAIL  ' + t.name + '\n      ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n      ')); } }
  console.log(`\n${tests.length - failed}/${tests.length} PASS${failed ? `, ${failed} FAIL` : ''}`);
  process.exit(failed ? 1 : 0);
})();
