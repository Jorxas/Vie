// Approbations du mode Agent : une carte = UNE demande d'outil = UNE décision de l'utilisateur.
// Une approbation ne vaut que pour l'empreinte exacte (outil + paramètres canonicalisés + exécution + session), expire vite, n'est jamais réutilisable
// et ne peut être donnée que par une requête authentifiée de l'interface (nonce propre à la demande). Le modèle n'a aucun moyen d'approuver.
// Aucune règle « toujours autoriser » n'existe : rien n'est mémorisé d'une carte à l'autre.
'use strict';
const crypto = require('node:crypto');

function createApprovals(opts = {}) {
  const now = opts.now || Date.now;
  const setT = opts.setTimeout || setTimeout;
  const clearT = opts.clearTimeout || clearTimeout;
  const ttlMs = opts.ttlMs || 120000;
  const maxPending = opts.maxPending || 3;
  const items = new Map();
  const same = (a, b) => typeof a === 'string' && typeof b === 'string' && (ba => (bb => ba.length === bb.length && crypto.timingSafeEqual(ba, bb))(Buffer.from(b)))(Buffer.from(a));

  function finish(it, state) {
    if (it.state !== 'pending') return false;
    it.state = state; clearT(it.timer);
    it.resolve(state);
    const purge = setT(() => items.delete(it.id), 60000); // purge tardive : l'entrée reste lisible un instant pour les réponses « déjà tranchée »
    if (purge && purge.unref) purge.unref();
    return true;
  }
  // Crée une demande en attente. Renvoie { id, nonce, expiresAt, promise } ; la promesse se résout par 'approved' | 'denied' | 'expired' | 'cancelled'.
  function request({ runId, sid, plan }) {
    const pending = [...items.values()].filter(x => x.state === 'pending' && x.runId === runId).length;
    if (pending >= maxPending) return null;
    const id = 'ap_' + crypto.randomBytes(9).toString('base64url');
    const nonce = crypto.randomBytes(18).toString('base64url');
    let resolve; const promise = new Promise(r => { resolve = r; });
    const it = { id, nonce, runId, sid, hash: plan.hash, tool: plan.tool, network: !!plan.network, state: 'pending', createdAt: now(), expiresAt: now() + ttlMs, resolve, promise, timer: null };
    it.timer = setT(() => finish(it, 'expired'), ttlMs);
    if (it.timer && it.timer.unref) it.timer.unref();
    items.set(id, it);
    return it;
  }
  // Décision de l'utilisateur. Chaque refus est explicite (code) : jamais d'approbation « par défaut ».
  function decide({ runId, sid, id, nonce, hash, allow, ackNetwork }) {
    const it = typeof id === 'string' ? items.get(id) : null;
    if (!it) return { ok: false, code: 'unknown_approval', message: 'Demande inconnue ou déjà purgée.' };
    if (it.runId !== runId || it.sid !== sid || !same(it.nonce, nonce)) return { ok: false, code: 'bad_approval_binding', message: 'Cette décision n’appartient pas à cette demande.' };
    if (it.state !== 'pending') return { ok: false, code: 'already_decided', message: `Demande déjà ${it.state === 'approved' ? 'approuvée' : it.state === 'denied' ? 'refusée' : it.state === 'expired' ? 'expirée' : 'annulée'} : une approbation n’est valable qu’une fois.` };
    if (now() >= it.expiresAt) { finish(it, 'expired'); return { ok: false, code: 'expired', message: 'Demande expirée : l’agent devra en présenter une nouvelle.' }; }
    if (allow !== true && allow !== false) return { ok: false, code: 'bad_request', message: 'Décision (allow) booléenne obligatoire.' };
    if (allow === true) {
      if (!same(it.hash, hash)) return { ok: false, code: 'hash_mismatch', message: 'L’empreinte ne correspond pas à ce qui a été présenté : rien n’est approuvé.' };
      if (it.network && ackNetwork !== true) return { ok: false, code: 'network_ack_required', message: 'Cette action touche le réseau : coche explicitement la confirmation « réseau ».' };
    }
    finish(it, allow ? 'approved' : 'denied');
    return { ok: true, state: it.state };
  }
  function cancelRun(runId, state = 'cancelled') { let n = 0; for (const it of items.values()) if (it.runId === runId && finish(it, state)) n++; return n; }
  const get = id => items.get(id) || null;
  return { request, decide, cancelRun, get, ttlMs, pendingCount: () => [...items.values()].filter(x => x.state === 'pending').length };
}

module.exports = { createApprovals };
