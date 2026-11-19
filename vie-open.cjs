// Ouvre le navigateur par défaut sur l'adresse RÉELLE du serveur Vie. Chargé UNIQUEMENT par vie-server.cjs (`--open` ou Entrée dans la console), après le démarrage effectif du serveur.
// Module séparé pour que vie-server.cjs lui-même n'exécute jamais de processus (propriété vérifiée par test_vie_server.cjs). Non servi au navigateur (hors liste blanche).
// L'adresse est validée (http, 127.0.0.1, port numérique, fragment facultatif `#vie-boot=<ticket de 43 caractères>`) et passée comme argument unique, sans shell : pas d'injection possible.
// Le ticket de lancement est un fragment : le navigateur ne l'envoie jamais en HTTP (ni requête, ni Referer). Sa durée de vie (90 s, usage unique) limite l'exposition de la ligne de commande
// du navigateur aux seuls processus du même compte, pendant quelques secondes.
'use strict';
function openBrowser(url, spawnImpl = require('node:child_process').spawn, platform = process.platform) {
  if (typeof url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d{4,5}\/(#vie-boot=[A-Za-z0-9_-]{43})?$/.test(url)) throw new Error('adresse non autorisée');
  const [cmd, args] = platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawnImpl(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
  if (child && child.on) child.on('error', () => { /* navigateur introuvable : l'adresse reste affichée dans la console */ });
  if (child && child.unref) child.unref();
  return child;
}
module.exports = { openBrowser };
