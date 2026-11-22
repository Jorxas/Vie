/* Öffentliche Demo der echten Vie-Oberfläche: erfundene Beispieldaten, nur im Arbeitsspeicher.
   Läuft zwischen core.js und app.js. Es gibt keinen Server: Speichern, Assistent und Agent sind nicht verbunden. */
(function () {
  'use strict';
  var C = window.VieCore;
  var s = C.seed();
  var mon = C.monday(new Date());
  var tag = function (n) { return C.iso(C.addDays(mon, n)); };
  s.settings.displayName = 'Alex';
  s.settings.workShifts = [];
  s.settings.budgetLiving = 650;
  s.settings.budgetProjects = 80;
  s.tasks = [
    { id: 'd1', title: 'Rapport de statistiques : relire la partie 2', projectId: '', category: 'study', priority: 'haute', duration: 90, date: tag(0), done: true, origin: 'manuel', notes: '' },
    { id: 'd2', title: 'Lernlabor : tester le parcours d’inscription', projectId: 'lernlabor', category: 'projects', priority: 'haute', duration: 60, date: tag(1), done: false, origin: 'manuel', notes: 'Trois cas : nouveau compte, mot de passe oublié, e-mail déjà utilisé.' },
    { id: 'd3', title: 'Exercices de Python sans assistance', projectId: '', category: 'study', priority: 'haute', duration: 45, date: tag(2), done: false, origin: 'manuel', notes: '' },
    { id: 'd4', title: 'Préparer la candidature Werkstudent (exemple)', projectId: '', category: 'career', priority: 'haute', duration: 60, date: tag(3), done: false, origin: 'manuel', notes: '' },
    { id: 'd5', title: 'Ausstellung : choisir les six affiches', projectId: 'marketing', category: 'projects', priority: 'normale', duration: 40, date: tag(4), done: false, origin: 'manuel', notes: '' },
    { id: 'd6', title: 'Courses et ménage', projectId: '', category: 'life', priority: 'normale', duration: 50, date: tag(5), done: false, origin: 'manuel', notes: '' }
  ];
  s.applications = [
    { id: 'a1', company: 'Nordlicht Software GmbH', role: 'Werkstudent Webentwicklung', status: 'entretien', sentAt: tag(-6), followup: tag(2), url: '', notes: 'Entretien en visio jeudi.' },
    { id: 'a2', company: 'Morgenrot Digital', role: 'Praktikum Datenanalyse', status: 'envoyée', sentAt: tag(-2), followup: tag(5), url: '', notes: '' },
    { id: 'a3', company: 'Hafenwerk Systeme', role: 'Werkstudent IT-Support', status: 'brouillon', sentAt: '', followup: '', url: '', notes: '' }
  ];
  s.transactions = [
    { id: 't1', date: tag(0), label: 'Abonnement transport (exemple)', amount: 29.9, type: 'expense', category: 'vie' },
    { id: 't2', date: tag(1), label: 'Nom de domaine du projet', amount: 12, type: 'expense', category: 'projets' }
  ];
  s.habitChecks = {};
  s.habitChecks['gym:' + tag(0)] = true;
  s.habitChecks['code:' + tag(0)] = true;
  try { s = C.validateImported(s); } catch (e) { s = C.seed(); }

  /* Speicher nur im Arbeitsspeicher: Neuladen setzt die Demo zurück, nichts bleibt im Browser des Besuchers. */
  var daten = {};
  daten['vie-personal-v1'] = JSON.stringify(s);
  var speicher = {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(daten, k) ? daten[k] : null; },
    setItem: function (k, v) { daten[k] = String(v); },
    removeItem: function (k) { delete daten[k]; },
    clear: function () { daten = {}; },
    key: function (i) { return Object.keys(daten)[i] || null; },
    get length() { return Object.keys(daten).length; }
  };
  Object.defineProperty(window, 'localStorage', { configurable: true, get: function () { return speicher; } });

  /* Hinweis oben auf der Seite, damit klar ist, dass es Beispieldaten sind. */
  document.addEventListener('DOMContentLoaded', function () {
    var h = document.createElement('div');
    h.setAttribute('data-demo-hinweis', '');
    h.setAttribute('role', 'note');
    h.style.cssText = 'position:fixed;left:50%;bottom:12px;transform:translateX(-50%);z-index:50;max-width:92vw;padding:8px 14px;border-radius:999px;background:#1c2142;color:#fff;font:12px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25)';
    h.textContent = 'Demo mit erfundenen Daten. Änderungen gelten nur bis zum Neuladen; Assistent und Agent sind nicht verbunden.';
    document.body.appendChild(h);
  });
})();
