/**
 * re-tools plugin for Camofox Browser.
 *
 * Narzędzia do reverse engineeringu stron przez JEDNĄ przeglądarkę Camofox —
 * bez dokładania drugiego launchera (jak robi to camoufox-reverse-mcp, który
 * startuje własny Camoufox i gubi nasze sesje/cookies).
 *
 * Co tu jest:
 *   /tabs/:tabId/re/net        — przechwytywanie ruchu sieciowego (XHR/fetch)
 *   /tabs/:tabId/re/hook       — wstrzyknięcie haka JS + zapis wywołań
 *   /tabs/:tabId/re/hooks      — odczyt zebranych wywołań
 *
 * Dlaczego to w pluginie a nie jako osobne MCP: korzysta z `tabState.page`,
 * czyli z tej samej przeglądarki, cookies i sesji co pozostałe narzędzia Q.
 *
 * Uwaga o iframe: evaluate() widzi tylko górną ramkę. Hak wstrzykiwany jest
 * do top frame — dlatego dla dialogów w iframe klikaj po `ref` ze snapshotu.
 */

const MAX_CAPTURE = 2000;      // żeby nie zjeść RAM przy stronie z thousandami requestów
const MAX_BODY_SNIPPET = 4000; // skrót body odpowiedzi
const MAX_HOOK_CALLS = 500;

/** Wyciąga `page` z sesji tak samo jak evaluate-chunked. */
function findPage(session, tabId) {
  if (!session || !session.tabGroups) return null;
  for (const [, group] of session.tabGroups) {
    if (group.has(tabId)) return group.get(tabId).page || null;
  }
  return null;
}

/** Stan przechwytywania żyje poza handlerem — per tabId. */
const netCaptures = new Map();
const hookBuffers = new Map();

/**
 * Podpina nasłuchy request/response na `page` i zapamiętuje metadane.
 * Zapętla przez guardę, bo evaluate-chunked i inni pluginy mogą wstrzyknąć
 * handler wielokrotnie przy kolejnych navigacjach.
 */
async function attachNetCapture(page, tabId) {
  const state = netCaptures.get(tabId);
  if (state && state.attached && state.page === page && !page.isClosed()) return state;

  const cap = state || { attached: false, requests: [], page: null, startedAt: null };
  cap.attached = true;
  cap.page = page;
  cap.startedAt = new Date().toISOString();

  const trim = () => { if (cap.requests.length > MAX_CAPTURE) cap.requests.splice(0, cap.requests.length - MAX_CAPTURE); };

  page.on('request', (req) => {
    try {
      const u = new URL(req.url());
      cap.requests.push({
        kind: 'request',
        method: req.method(),
        type: req.resourceType(),
        url: u.origin + u.pathname,
        host: u.host,
        resourceType: req.resourceType(),
        postData: (req.postData() || '').slice(0, MAX_BODY_SNIPPET) || null,
        headers: pick(req.headers()),
        at: new Date().toISOString(),
      });
      trim();
    } catch { /* URL bywa nieparsowalny (data:, blob:) */ }
  });

  page.on('response', async (res) => {
    try {
      const u = new URL(res.url());
      const rec = cap.requests.find(
        (r) => r.url === u.origin + u.pathname && r.status === undefined);
      const entry = rec || {
        kind: 'response', url: u.origin + u.pathname,
        method: null, resourceType: null, headers: {}, postData: null,
      };
      entry.status = res.status();
      entry.statusText = res.statusText();
      entry.responseHeaders = pick(res.headers());
      // body tylko dla xhr/fetch — nie ciągniemy obrazów
      const rt = (entry.resourceType || res.request().resourceType());
      if (['xhr', 'fetch', 'document'].includes(rt)) {
        try {
          const body = await res.text();
          entry.bodySnippet = body.slice(0, MAX_BODY_SNIPPET);
          entry.bodyLength = body.length;
        } catch { entry.bodySnippet = null; /* redirect / CORS blokuje odczyt */ }
      }
      entry.at = new Date().toISOString();
      if (!rec) { cap.requests.push(entry); trim(); }
    } catch { /* response bez odpowiadającego request */ }
  });

  netCaptures.set(tabId, cap);
  return cap;
}

function pick(headers) {
  const keep = ['content-type', 'authorization', 'cookie', 'x-requested-with',
                 'origin', 'referer', 'accept', 'user-agent', 'x-api-key'];
  const out = {};
  for (const k of keep) {
    const v = headers[k] ?? headers[k.toLowerCase()];
    if (v) out[k] = String(v).slice(0, 300);
  }
  return out;
}

export async function register(app, ctx, pluginConfig = {}) {
  const { log, config, sessions, normalizeUserId, withUserLimit, safeError } = ctx;
  const middleware = pluginConfig.auth === true ? ctx.auth() : (_req, _res, next) => next();

  log('info', 're-tools plugin enabled (network capture + JS hooks)');

  // ---------------------------------------------------------------- network
  app.post('/tabs/:tabId/re/net/start', middleware, async (req, res) => {
    const { tabId } = req.params;
    const userId = normalizeUserId(req.body?.userId || req.query.userId);
    const session = sessions.get(userId);
    const page = findPage(session, tabId);
    if (!page) return res.status(404).json({ error: `Tab not found: ${tabId}` });

    try {
      const cap = await withUserLimit(userId, () => attachNetCapture(page, tabId));
      res.json({ ok: true, tabId, attached: cap.attached, captured: cap.requests.length });
    } catch (e) {
      log('warn', 're/net/start failed', { tabId, error: safeError(e).message });
      res.status(500).json({ error: safeError(e).message });
    }
  });

  app.get('/tabs/:tabId/re/net', middleware, async (req, res) => {
    const { tabId } = req.params;
    const cap = netCaptures.get(tabId);
    if (!cap) return res.json({ ok: true, tabId, started: false, captured: 0, requests: [] });

    let requests = cap.requests;
    const filterType = req.query.type;
    const filterUrl = req.query.urlContains;
    if (filterType) requests = requests.filter((r) => r.resourceType === filterType);
    if (filterUrl) {
      const needle = String(filterUrl).toLowerCase();
      requests = requests.filter((r) => (r.url || '').toLowerCase().includes(needle));
    }
    res.json({
      ok: true, tabId, started: true, startedAt: cap.startedAt,
      captured: cap.requests.length, returned: requests.length, requests,
    });
  });

  app.post('/tabs/:tabId/re/net/stop', middleware, async (req, res) => {
    const { tabId } = req.params;
    const cap = netCaptures.get(tabId);
    netCaptures.delete(tabId);
    res.json({ ok: true, tabId, stopped: true, had: cap ? cap.requests.length : 0 });
  });

  // ------------------------------------------------------------------- hooks
  app.post('/tabs/:tabId/re/hook', middleware, async (req, res) => {
    const { tabId } = req.params;
    const userId = normalizeUserId(req.body?.userId || req.query.userId);
    const { target, expression, label } = req.body || {};
    if (!expression) return res.status(400).json({ error: 'expression required' });

    const session = sessions.get(userId);
    const page = findPage(session, tabId);
    if (!page) return res.status(404).json({ error: `Tab not found: ${tabId}` });

    const key = tabId;
    if (!hookBuffers.has(key)) hookBuffers.set(key, { calls: [], installed: [], callsTruncated: false });

    // Hak żyje w page-context, więc wywołania zbieramy przez globalny bufor.
    // Używamy Function(), nie eval() — expression przychodzi z zaufanego agenta.
    const source = `
      (() => {
        if (!window.__q_re_hooks) {
          window.__q_re_hooks = { calls: [], installed: [] };
        }
        const _rec = (label, args) => {
          try {
            if (window.__q_re_hooks.calls.length > ${MAX_HOOK_CALLS}) { window.__q_re_hooks.truncated = true; return; }
            window.__q_re_hooks.calls.push({
              label, at: Date.now(),
              args: args.map(a => { try { return typeof a === 'function' ? '[fn]' : JSON.parse(JSON.stringify(a)); }
                                   catch { return String(a).slice(0, 300); } }).slice(0, 10)
            });
          } catch (_) {}
        };
        try { ${expression}; window.__q_re_hooks.installed.push(${JSON.stringify(label || target || 'hook')});
              return 'installed: ' + window.__q_re_hooks.installed.length; }
        catch (e) { return 'ERR: ' + e.message; }
      })()`;

    try {
      // Function('return (src)')() od razu wywołuje zwróconą funkcję —
      // nie wolno dokładać drugiego (), stąd 'Function(...) is not a function'.
      const result = await withUserLimit(userId, () =>
        page.evaluate((src) => Function('"use strict"; return (' + src + ');')(), source));
      log('info', 're/hook injected', { tabId, target: target || null, result });
      res.json({ ok: true, tabId, target: target || null, label: label || null, result });
    } catch (e) {
      log('warn', 're/hook failed', { tabId, error: safeError(e).message });
      res.status(500).json({ error: safeError(e).message });
    }
  });

  app.get('/tabs/:tabId/re/hooks', middleware, async (req, res) => {
    const { tabId } = req.params;
    const userId = normalizeUserId(req.query.userId);
    const session = sessions.get(userId);
    const page = findPage(session, tabId);
    if (!page) return res.status(404).json({ error: `Tab not found: ${tabId}` });

    try {
      const buf = await withUserLimit(userId, () =>
        page.evaluate(() => {
          const h = window.__q_re_hooks || { calls: [], installed: [], truncated: false };
          return { calls: h.calls, installed: h.installed, truncated: !!h.truncated };
        }));
      res.json({ ok: true, tabId, ...buf });
    } catch (e) {
      res.status(500).json({ error: safeError(e).message });
    }
  });

  app.post('/tabs/:tabId/re/hooks/clear', middleware, async (req, res) => {
    const { tabId } = req.params;
    const userId = normalizeUserId(req.body?.userId || req.query.userId);
    const session = sessions.get(userId);
    const page = findPage(session, tabId);
    if (!page) return res.status(404).json({ error: `Tab not found: ${tabId}` });
    try {
      const n = await withUserLimit(userId, () =>
        page.evaluate(() => {
          const n = (window.__q_re_hooks?.calls || []).length;
          if (window.__q_re_hooks) { window.__q_re_hooks.calls = []; window.__q_re_hooks.truncated = false; }
          return n;
        }));
      res.json({ ok: true, tabId, cleared: n });
    } catch (e) {
      res.status(500).json({ error: safeError(e).message });
    }
  });

  // ---------------------------------------------------------------- ast/deobf
  // Kod tutaj jest portem z camoufox-jsreverser-mcp (wukaka) — te same
  // transformy Babel, ale działające na tekście, a nie na działającej
  // przeglądarce. Dzięki temu da się deobfuskować JS pobrany przez /re/net.
  app.post('/tabs/:tabId/re/ast', middleware, async (req, res) => {
    const { tabId } = req.params;
    const { code, transforms, url } = req.body || {};
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'code (string) required' });
    }
    const { tabState } = ctx;
    if (tabState && url) {
      // opcjonalne: zapamiętaj skąd pochodzi skrypt (przydatne w raporcie)
      void tabState;
    }

    try {
      const { TRANSFORMS, CRYPTO_RULES } = await import('./ast/index.js');
      const names = Array.isArray(transforms) && transforms.length
        ? transforms
        : Object.keys(TRANSFORMS);
      const applied = [];
      let current = code;
      for (const name of names) {
        const t = TRANSFORMS[name];
        if (!t) continue;
        const out = await t(current);
        if (out && typeof out.code === 'string' && out.changed) {
          current = out.code;
          applied.push(name);
        }
      }
      const cryptoHits = CRYPTO_RULES
        .filter((r) => { try { return r.detect(code); } catch { return false; } })
        .map((r) => r.name);
      res.json({
        ok: true, tabId, applied,
        changed: applied.length > 0,
        crypto: cryptoHits,
        code: current,
        length: { before: code.length, after: current.length },
      });
    } catch (e) {
      log('warn', 're/ast failed', { tabId, error: safeError(e).message });
      res.status(500).json({ error: safeError(e).message });
    }
  });

  app.get('/tabs/:tabId/re/ast/transforms', middleware, (_req, res) => {
    import('./ast/index.js')
      .then(({ TRANSFORMS, CRYPTO_RULES }) => res.json({
        ok: true,
        transforms: Object.keys(TRANSFORMS),
        crypto: CRYPTO_RULES.map((r) => r.name),
      }))
      .catch((e) => res.status(500).json({ error: e.message }));
  });

  // hookBuffers trzymamy tylko dla jawnych zapisów po stronie serwera
  void hookBuffers;
}