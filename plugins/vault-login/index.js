/**
 * Vault-Login plugin for camofox-browser.
 *
 * Integrates auth-vault credentials with Camofox Browser.
 * All endpoints operate exclusively on Handle names (vault_xxxxx)
 * from the auth-vault REST API.
 *
 * Architecture:
 *   - Metadata (handle, label, origin, identifier) → auth-vault REST API (port 5600)
 *   - Passwords → auth-vault REST API (port 5600)
 *
 * Endpoints:
 *   GET  /vault-login/handles        → list all vault handles with metadata
 *   GET  /vault-login/handles/:handle → credentials for a specific handle
 *   POST /vault-login/login/:handle  → create a tab with the handle's login URL
 *
 * Auth: none (tailnet-only, no requireAuth)
 */

// ── Known service login URLs (fallback) ───
const SERVICE_LOGIN_URLS = {
  'google':       'https://accounts.google.com/',
  'arena.ai':     'https://arena.ai/login',
  'github':       'https://github.com/login',
  'gitlab':       'https://gitlab.com/users/sign_in',
  'groq.com':     'https://console.groq.com/login',
  'openrouter.ai':'https://openrouter.ai/auth',
  'neon.tech':    'https://console.neon.tech/sign-in',
  'ai-empire':    'https://ai-agent-idle-rpg-alpha.vercel.app/login',
  'captchaplugin.com': 'https://captchaplugin.com/login',
  'mistral':      'https://console.mistral.ai/login',
  'huggingface':  'https://huggingface.co/login',
  'composio':     'https://composio.dev/login',
  'opencode':     'https://opencode.ai/login',
  'camofox':      'http://localhost:9377/login',
  'hub.docker.com': 'https://hub.docker.com/login',
  'cloud.cerebras.ai': 'https://cloud.cerebras.ai/login',
  'copilot.microsoft.com': 'https://copilot.microsoft.com/login',
  'iflow':        'https://iflow.ai/login',
  'mariusz':      'https://mariusz.ai/login',
  'notebooklm.google.com': 'https://notebooklm.google.com/login',
  'q-ecosystem':  'https://skills.local/login',
  'ssh':          'ssh://localhost/login',
  'supabase/q-training': 'https://supabase.io/login',
  'CEREBRAS':     'https://cloud.cerebras.ai/login',
  'GROQ':         'https://console.groq.com/login',
  'Mistral':      'https://console.mistral.ai/login',
  'OPENROUTER':   'https://openrouter.ai/auth',
  'deepgram':     'https://deepgram.com/login',
  'vercel':       'https://vercel.com/login',
  'tailscale':    'https://tailscale.com/login',
  'CODESANDBOX':  'https://codesandbox.io/login',
  'NVIDIA':       'https://integrate.api.nvidia.com/login',
  'vault':        'https://vault.local/login',
};

const AUTH_VAULT_REST = 'http://127.0.0.1:5600';

// ── Auth-vault helpers ───────────────────

/** Get handles from auth-vault (SSOT — only source) */
async function getAuthVaultHandles() {
  try {
    const resp = await fetch(`${AUTH_VAULT_REST}/api/credentials`);
    if (!resp.ok) return [];
    const data = await resp.json();
    const entries = data.entries || data.credentials || [];
    return entries.map(e => ({
      handle: e.id,
      source: 'auth-vault',
      kind: 'login',
      label: e.label || '',
      identifier: e.identifier || '',
      origin: e.service || '',
    }));
  } catch { return []; }
}

/** Get password for a handle — auth-vault only (SSOT) */
async function getPasswordByHandle(handle, label) {
  try {
    const resp = await fetch(`${AUTH_VAULT_REST}/api/credentials?service=${encodeURIComponent(label)}`);
    if (!resp.ok) return null;
    const data = await resp.json();
    const entries = data.entries || data.credentials || [];
    const match = entries.find(e => e.label === label || e.id === handle);
    if (match?.credentials?.password) return match.credentials.password;
    // Try full credential fetch
    if (match?.id) {
      const full = await fetch(`${AUTH_VAULT_REST}/api/credentials/${match.id}?includePassword=true`);
      if (full.ok) {
        const fullData = await full.json();
        return fullData.credentials?.password || null;
      }
    }
    return null;
  } catch { return null; }
}

/** Resolve login URL from origin or label */
function resolveLoginUrl(origin, label) {
  if (!origin && !label) return null;
  // Try origin first
  if (origin) {
    const domain = origin.replace(/^https?:\/\//, '').replace(/\/.*/, '');
    if (SERVICE_LOGIN_URLS[domain]) return SERVICE_LOGIN_URLS[domain];
    if (SERVICE_LOGIN_URLS[label]) return SERVICE_LOGIN_URLS[label];
  }
  // Try label
  if (label && SERVICE_LOGIN_URLS[label]) return SERVICE_LOGIN_URLS[label];
  return null;
}

// ── Fill login form from vault credential ──
async function fillLoginForm(tabId, userId, cred) {
  const port = globalThis.__camofox_port || 9377;
  const filled = [];

  try {
    const snapResp = await fetch(`http://127.0.0.1:${port}/tabs/${tabId}/snapshot?userId=${userId}`);
    if (!snapResp.ok) return { filled: false, error: 'snapshot_failed' };
    const snapText = await snapResp.text();

    const userRef = findFieldRef(snapText, ['email', 'login', 'username', 'user', 'e-mail']);
    if (userRef && cred.username) {
      await fetch(`http://127.0.0.1:${port}/tabs/${tabId}/type`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, ref: userRef, text: cred.username }),
      });
      filled.push('username');
    }

    const passRef = findFieldRef(snapText, ['password', 'passwd', 'hasło', 'parol']);
    if (passRef && cred.password) {
      await fetch(`http://127.0.0.1:${port}/tabs/${tabId}/type`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, ref: passRef, text: cred.password }),
      });
      filled.push('password');
    }

    if (filled.length === 2) {
      const submitRef = findFieldRef(snapText, ['sign in', 'log in', 'login', 'submit', 'zaloguj', 'dalej']);
      if (submitRef) {
        await fetch(`http://127.0.0.1:${port}/tabs/${tabId}/click`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, ref: submitRef }),
        });
        filled.push('submit');
      }
    }
  } catch (err) {
    return { filled: false, error: err.message };
  }

  return { filled: filled.length > 0, fields: filled };
}

function findFieldRef(snapshot, keywords) {
  const lines = snapshot.split('\n');
  for (const line of lines) {
    const trimmed = line.trim().toLowerCase();
    for (const kw of keywords) {
      if (trimmed.includes(kw)) {
        const m = trimmed.match(/\[(e\d+)\]/);
        if (m) return m[1];
      }
    }
  }
  return null;
}

// ── Auth middleware ──
function noAuth(req, res, next) { next(); }

// ── Plugin registration ──

export async function register(app, ctx, pluginConfig = {}) {
  const { events, config, log, sessions, safeError } = ctx;

  log('info', 'vault-login plugin: enabled (auth-vault SSOT only)');

  // ── GET /vault-login/handles ─────────────

  app.get('/vault-login/handles', noAuth, async (req, res) => {
    try {
      const handles = await getAuthVaultHandles();
      const result = handles.map(h => ({
        handle: h.handle,
        label: h.label,
        kind: h.kind,
        identifier: h.identifier,
        origin: h.origin,
        loginUrl: resolveLoginUrl(h.origin, h.label),
      }));
      res.json({ count: result.length, handles: result, source: 'auth-vault' });
    } catch (err) {
      log('error', 'vault-login/handles failed', { error: err.message });
      res.status(500).json({ error: safeError(err) });
    }
  });

  // ── GET /vault-login/handles/:handle ─────

  app.get('/vault-login/handles/:handle', noAuth, async (req, res) => {
    try {
      const { handle } = req.params;
      const handles = await getAuthVaultHandles();
      const h = handles.find(x => x.handle === handle);
      if (!h) {
        return res.status(404).json({ error: `Handle not found: ${handle}`, availableHandles: handles.map(x => x.handle) });
      }
      const password = await getPasswordByHandle(handle, h.label);
      res.json({
        handle: h.handle,
        label: h.label,
        kind: h.kind,
        identifier: h.identifier,
        origin: h.origin,
        loginUrl: resolveLoginUrl(h.origin, h.label),
        hasPassword: !!password,
        source: 'auth-vault',
      });
    } catch (err) {
      log('error', 'vault-login/handles/:handle failed', { error: err.message });
      res.status(500).json({ error: safeError(err) });
    }
  });

  // ── POST /vault-login/login/:handle ──────

  app.post('/vault-login/login/:handle', noAuth, async (req, res) => {
    const { handle } = req.params;
    const userId = req.body?.userId || 'q';
    const sessionKey = req.body?.sessionKey || 'vault-login';

    try {
      // Look up handle in auth-vault (SSOT)
      const handles = await getAuthVaultHandles();
      const h = handles.find(x => x.handle === handle);
      if (!h) {
        return res.status(404).json({ error: `Handle not found: ${handle}`, availableHandles: handles.map(x => x.handle) });
      }

      // Get password from auth-vault (SSOT)
      const password = await getPasswordByHandle(handle, h.label);

      // Resolve login URL
      const loginUrl = resolveLoginUrl(h.origin, h.label);
      if (!loginUrl) {
        return res.status(400).json({
          error: `Cannot resolve login URL for handle ${handle}`,
          origin: h.origin,
          label: h.label,
          knownServices: Object.keys(SERVICE_LOGIN_URLS),
        });
      }

      // Create tab in Camofox
      const camofoxPort = config.port || 9377;
      const tabResp = await fetch(`http://127.0.0.1:${camofoxPort}/tabs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { 'Authorization': `Bearer ${config.apiKey}` } : {}) },
        body: JSON.stringify({ userId, sessionKey, url: loginUrl }),
      });

      if (!tabResp.ok) {
        const errBody = await tabResp.text();
        return res.status(tabResp.status).json({ error: 'Failed to create Camofox tab', status: tabResp.status, body: errBody });
      }

      const tabResult = await tabResp.json();
      const tabId = tabResult.tabId || tabResult.id;

      // Auto-fill if password available
      let fillResult = null;
      if (password) {
        fillResult = await fillLoginForm(tabId, userId, { username: h.identifier, password });
      }

      const result = {
        ok: true,
        handle,
        label: h.label,
        loginUrl,
        tabId,
        url: tabResult.url,
        hasPassword: !!password,
        filled: fillResult?.filled || false,
        fields: fillResult?.fields || [],
      };

      log('info', 'vault-login tab created', { handle, tabId, userId });
      events.emit('vault:login', { userId, handle, tabId });

      res.json(result);
    } catch (err) {
      log('error', 'vault-login/login failed', { handle, error: err.message });
      res.status(500).json({ error: safeError(err) });
    }
  });

  // ── POST /vault-login/auto-fill/:tabId ───

  app.post('/vault-login/auto-fill/:tabId', noAuth, async (req, res) => {
    const { tabId } = req.params;
    const userId = req.body?.userId || 'q';

    try {
      const snapResp = await fetch(`http://127.0.0.1:${config.port || 9377}/tabs/${tabId}/snapshot?userId=${userId}`);
      if (!snapResp.ok) { return res.status(400).json({ error: 'Cannot get tab snapshot', tabId }); }
      const snapText = await snapResp.text();
      const urlMatch = snapText.match(/https?:\/\/[^\s"']+/);
      const currentUrl = urlMatch ? urlMatch[0] : '';

      const qDomain = detectQDomain(currentUrl);
      if (!qDomain) { return res.json({ ok: false, reason: 'not_q_domain', url: currentUrl }); }

      // Look up handle by domain
      const handles = await getAuthVaultHandles();
      const h = handles.find(x => x.origin?.includes(qDomain) || x.label?.toLowerCase().includes(qDomain));
      if (!h) {
        return res.json({ ok: false, reason: 'no_handle_for_domain', domain: qDomain, url: currentUrl });
      }

      const password = await getPasswordByHandle(h.handle, h.label);
      if (!password) {
        return res.json({ ok: false, reason: 'no_password', handle: h.handle, domain: qDomain });
      }

      const fillResult = await fillLoginForm(tabId, userId, { username: h.identifier, password });

      res.json({ ok: true, handle: h.handle, domain: qDomain, url: currentUrl, filled: fillResult.filled, fields: fillResult.fields });
    } catch (err) {
      log('error', 'vault-login/auto-fill failed', { tabId, error: err.message });
      res.status(500).json({ error: safeError(err) });
    }
  });

  // ── POST /vault-login/save/:handle ────────

  app.post('/vault-login/save/:handle', noAuth, async (req, res) => {
    const { handle } = req.params;
    const { label, value, kind, origin, identifier } = req.body || {};

    if (!label || !value) {
      return res.status(400).json({ error: 'label and value required' });
    }

    try {
      const response = await fetch(`${AUTH_VAULT_REST}/api/credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: handle, label, value, kind: kind || 'login', origin, identifier }),
      });

      if (!response.ok) {
        return res.status(502).json({ error: 'vault proxy unreachable', status: response.status });
      }

      const data = await response.json();
      log('info', 'vault-login save', { handle, label });
      events.emit('vault:save', { userId: req.body?.userId || 'q', handle, label });

      res.json({ ok: true, handle, label, ...data });
    } catch (err) {
      log('error', 'vault-login/save failed', { handle, error: err.message });
      res.status(500).json({ error: safeError(err) });
    }
  });

  // ── POST /vault-login/save-session/:handle ─

  app.post('/vault-login/save-session/:handle', noAuth, async (req, res) => {
    const { handle } = req.params;
    const { cookie, token, label } = req.body || {};

    if (!cookie && !token) { return res.status(400).json({ error: 'cookie or token required' }); }

    try {
      const sessionLabel = label || `session-${Date.now()}`;
      const response = await fetch(`${AUTH_VAULT_REST}/api/credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: handle, label: sessionLabel, value: cookie || token, kind: 'session' }),
      });

      if (!response.ok) { return res.status(502).json({ error: 'vault proxy unreachable', status: response.status }); }

      const data = await response.json();
      log('info', 'vault-login save-session', { handle, label: sessionLabel });
      events.emit('vault:session-save', { handle, label: sessionLabel });

      res.json({ ok: true, handle, label: sessionLabel, ...data });
    } catch (err) {
      log('error', 'vault-login/save-session failed', { handle, error: err.message });
      res.status(500).json({ error: safeError(err) });
    }
  });

  log('info', 'vault-login plugin: registered 5 endpoints (auth-vault SSOT only)');
}

const Q_DOMAIN_PATTERNS = [
  { pattern: /neon\.tech/, service: 'neon.tech' },
  { pattern: /console\.neon\.tech/, service: 'neon.tech' },
  { pattern: /arena\.ai/, service: 'arena.ai' },
  { pattern: /openrouter\.ai/, service: 'openrouter.ai' },
  { pattern: /groq\.com/, service: 'groq.com' },
  { pattern: /console\.groq\.com/, service: 'groq.com' },
  { pattern: /mistral\.ai/, service: 'mistral' },
  { pattern: /console\.mistral\.ai/, service: 'mistral' },
  { pattern: /huggingface\.co/, service: 'huggingface' },
  { pattern: /huggingface\.net/, service: 'huggingface' },
  { pattern: /github\.com/, service: 'github' },
  { pattern: /gitlab\.com/, service: 'gitlab' },
  { pattern: /google\.com/, service: 'google' },
  { pattern: /accounts\.google\.com/, service: 'google' },
  { pattern: /gemini\.google\.com/, service: 'google' },
  { pattern: /botai\.ttk\.@gmail\.com/, service: 'google' },
  { pattern: /composio\.dev/, service: 'composio' },
  { pattern: /opencode\.ai/, service: 'opencode' },
  { pattern: /deepgram\.com/, service: 'deepgram' },
  { pattern: /cerebras\.ai/, service: 'cerebras' },
  { pattern: /cloud\.cerebras\.ai/, service: 'cerebras' },
  { pattern: /vercel\.com/, service: 'vercel' },
  { pattern: /tailscale\.com/, service: 'tailscale' },
  { pattern: /codesandbox\.io/, service: 'codesandbox' },
  { pattern: /integrate\.api\.nvidia\.com/, service: 'nvidia' },
  { pattern: /copilot\.microsoft\.com/, service: 'copilot' },
  { pattern: /hub\.docker\.com/, service: 'docker' },
];

function detectQDomain(url) {
  if (!url) return null;
  for (const { pattern, service } of Q_DOMAIN_PATTERNS) { if (pattern.test(url)) return service; }
  return null;
}

export { detectQDomain, fillLoginForm, findFieldRef };