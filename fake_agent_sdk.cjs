// FAUX SDK Claude Agent pour les tests : aucun réseau, aucun processus, aucun appel Anthropic. Il imite le contrat utilisé par vie-agent.cjs
// (query / tool / createSdkMcpServer, hook PreToolUse, canUseTool, messages system/assistant/user/result) pour qu'un « scénario » joue le rôle du modèle.
// Ce n'est PAS le vrai SDK : les tests qui l'utilisent ne prouvent pas le comportement réel du moteur (voir « intégration vraie non testée » dans la documentation).
'use strict';
const chain = () => new Proxy(function () {}, { get: (t, k) => (k === 'then' ? undefined : chain()), apply: () => chain() });
const zodStub = new Proxy({}, { get: () => () => chain() });

// script(api) joue le modèle. api.use(nom, entrée) enchaîne : hook PreToolUse -> canUseTool -> (si autorisé) exécution -> tool_result. api.say(texte) émet du texte.
// shell : (commande) => { out, error } exécute la commande « pour de faux » (journalisée dans calls.shell) ; l'exécuteur n'est JAMAIS appelé sans autorisation.
function createFakeSdk({ script, shell, model, cost = 0.012, subtype = 'success', noResult = false, driftModel = null, ignoreAbort = false } = {}) {
  const calls = { procs: [], queries: [], shell: [], handlerCalls: [], optionsSeen: null, hookDenials: [], canUse: [] };
  const sdk = {
    tool: (name, description, shape, handler) => ({ name, description, shape, handler }),
    createSdkMcpServer: o => ({ type: 'sdk', name: o.name, tools: o.tools }),
    query({ prompt, options }) {
      calls.queries.push({ prompt, options });
      calls.optionsSeen = options;
      const server = options.mcpServers.vie;
      // Comme le vrai SDK : le « moteur » est un processus lancé via spawnClaudeCodeProcess (ici un vrai processus Node inoffensif qui dort). S'il est tué, la requête échoue.
      let proc = null; let procGone = null; let procExited = false;
      if (typeof options.spawnClaudeCodeProcess === 'function') {
        proc = options.spawnClaudeCodeProcess({ command: process.execPath, args: ['-e', 'setInterval(function(){},1000)'], cwd: options.cwd, env: { PATH: process.env.PATH || '', SystemRoot: process.env.SystemRoot || '' }, signal: options.abortController.signal });
        calls.procs.push(proc);
        procGone = new Promise((_, rej) => { proc.once('exit', () => { procExited = true; if (wake) { wake(); wake = null; } rej(Object.assign(new Error('Claude Code process terminated'), { name: 'ProcessExit' })); }); });
        procGone.catch(() => {});
      }
      const out = [];
      const queue = []; let wake = null; let done = false;
      const push = m => { queue.push(m); if (wake) { wake(); wake = null; } };
      let n = 0;
      const api = {
        prompt, options,
        say: text => push({ type: 'assistant', message: { model: driftModel || options.model, content: [{ type: 'text', text }] } }),
        async use(name, input) {
          const id = 'tu_' + (++n);
          push({ type: 'assistant', message: { model: options.model, content: [{ type: 'tool_use', id, name, input }] } });
          const hook = options.hooks && options.hooks.PreToolUse && options.hooks.PreToolUse[0].hooks[0];
          const h = hook ? await hook({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: input, tool_use_id: id }, id, { signal: options.abortController.signal }) : {};
          if (h && h.hookSpecificOutput && h.hookSpecificOutput.permissionDecision === 'deny') {
            calls.hookDenials.push({ name, reason: h.hookSpecificOutput.permissionDecisionReason });
            push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: 'denied by hook' }] } });
            return { allowed: false, by: 'hook', message: h.hookSpecificOutput.permissionDecisionReason };
          }
          const d = await options.canUseTool(name, input, { signal: options.abortController.signal, toolUseID: id, requestId: 'r' + n });
          calls.canUse.push({ name, behavior: d.behavior });
          if (d.behavior !== 'allow') {
            push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: d.message || 'denied' }] } });
            return { allowed: false, by: 'canUseTool', message: d.message, interrupt: !!d.interrupt };
          }
          const finalInput = d.updatedInput || input;
          let text = '', isError = false;
          if (name === 'PowerShell' || name === 'Bash') {
            calls.shell.push(finalInput.command);
            const r = shell ? await (procGone ? Promise.race([shell(finalInput.command), procGone]) : shell(finalInput.command)) : { out: 'ok' };
            text = r.out || ''; isError = !!r.error;
          } else {
            const t = server.tools.find(x => 'mcp__vie__' + x.name === name);
            calls.handlerCalls.push(name);
            const r = await t.handler(finalInput, {});
            text = r.content.map(c => c.text).join('\n'); isError = !!r.isError;
          }
          push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: text }] } });
          return { allowed: true, text, isError };
        },
        // Appel direct d'un gestionnaire d'outil SANS passer par canUseTool : simule un moteur défaillant ou un modèle qui contourne les permissions.
        async rawHandler(shortName, input) {
          const t = server.tools.find(x => x.name === shortName);
          const r = await t.handler(input, {});
          return { text: r.content.map(c => c.text).join('\n'), isError: !!r.isError };
        },
      };
      (async () => {
        try {
          push({ type: 'system', subtype: 'init', model: options.model });
          const final = script ? await script(api) : 'Terminé.';
          if (!noResult) push({ type: 'result', subtype, is_error: subtype !== 'success', result: typeof final === 'string' ? final : '', total_cost_usd: cost, num_turns: 3 });
        } catch (e) { queue.push({ __throw: e }); } finally { done = true; if (proc && !procExited) { try { proc.kill('SIGKILL'); } catch (e) { /* déjà parti */ } } if (wake) wake(); }
      })();
      const abort = options.abortController.signal;
      return {
        close() { if (proc && !procExited) { try { proc.kill('SIGKILL'); } catch (e) { /* déjà parti */ } } },
        async *[Symbol.asyncIterator]() {
          while (true) {
            if (procExited && !done) { const e = new Error('Claude Code process terminated'); e.name = 'ProcessExit'; throw e; }
            if (abort.aborted && !ignoreAbort) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
            if (queue.length) { const m = queue.shift(); if (m.__throw) throw m.__throw; yield m; continue; }
            if (done) return;
            await new Promise(r => { wake = r; if (!ignoreAbort) abort.addEventListener('abort', r, { once: true }); });
          }
        },
      };
    },
  };
  return { sdk, calls, sdkLoader: async () => ({ sdk, z: zodStub }) };
}
module.exports = { createFakeSdk };
