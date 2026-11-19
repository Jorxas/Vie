// Aide de test : ouvre une session Vie par le MÊME chemin que le lanceur de production (ticket de lancement émis en processus -> POST /api/auth/exchange).
// Il n'existe aucune porte dérobée de test : le serveur n'a ni indicateur « test », ni cookie prédéfini, ni jeton fixe ; le ticket n'est jamais lisible par HTTP.
'use strict';
const http = require('node:http');

function post(port, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: urlPath, agent: false, headers: { ...headers, 'Content-Length': Buffer.byteLength(data) } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch (e) { /* pas du JSON */ } resolve({ status: res.statusCode, headers: res.headers, text, json }); });
    });
    r.on('error', reject); r.write(data); r.end();
  });
}
function get(port, urlPath, headers) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath, headers, agent: false }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch (e) { /* pas du JSON */ } resolve({ status: res.statusCode, headers: res.headers, text, json }); });
    }).on('error', reject);
  });
}
const sameOriginHeaders = port => ({ Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' });

// Échange d'un ticket (valide ou non) comme le ferait vie-boot.js. Renvoie la réponse HTTP brute.
const exchange = (port, ticket) => post(port, '/api/auth/exchange', { ...sameOriginHeaders(port), 'Content-Type': 'application/json' }, { ticket });

// Connexion complète : ticket émis par le serveur en processus, échangé, puis jeton CSRF lu sur /api/health authentifié.
async function login(vie) {
  const port = vie.state.port;
  const r = await exchange(port, vie.issueLaunchTicket());
  if (r.status !== 200) throw new Error('échange refusé : ' + r.status + ' ' + r.text);
  const cookie = String(r.headers['set-cookie'] || '').split(';')[0];
  const h = await get(port, '/api/health', { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie });
  if (!h.json || typeof h.json.token !== 'string') throw new Error('jeton absent après connexion');
  const s = { port, cookie, token: h.json.token, health: h.json };
  s.headers = (over = {}) => ({ ...sameOriginHeaders(port), 'Content-Type': 'application/json', Cookie: s.cookie, 'X-Vie-Token': s.token, ...over });
  return s;
}
module.exports = { login, exchange, post, get, sameOriginHeaders };
