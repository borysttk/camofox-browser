/**
 * Vault Auto-Login pipeline — pełny flow od creds przez login po weryfikację.
 *
 * Pipeline:
 *   1. Pobierz credsy z auth-vault (z hasłem)
 *   2. Utwórz taba w Camofoxie
 *   3. Navigate do strony logowania
 *   4. Detect email/password fields via snapshot
 *   5. Type credentials, click submit
 *   6. Jeśli 2FA → pobierz TOTP z auth-vault, wypełnij
 *   7. Verify: snapshot po -> sprawdź czy pole email zniknęło
 */

// ── Known service login URLs ──
const SERVICE_LOGIN_URLS = {
  google:           'https://accounts.google.com/AccountChooser?continue=https://aistudio.google.com/',
  'arena.ai':       'https://arena.ai/login',
  github:           'https://github.com/login',
  gitlab:           'https://gitlab.com/users/sign_in',
  'groq.com':       'https://console.groq.com/login',
  'openrouter.ai':  'https://openrouter.ai/auth',
  'neon.tech':      'https://console.neon.tech/sign-in',
  'ai-empire':      'https://ai-agent-idle-rpg-alpha.vercel.app/login',
  'captchaplugin.com': 'https://captchaplugin.com/login',
  jimmypc:          'http://jimmypc.tailb6168e.ts.net:5000/login',
};

// ── Email keywords ──
const EMAIL_KEYWORDS = ['email', 'phone', 'login', 'username', 'account', 'e-mail', 'user'];
const PASSWORD_KEYWORDS = ['password', 'passwd', 'hasło', 'parol', 'enter your password'];
const SUBMIT_KEYWORDS = ['next', 'sign in', 'log in', 'continue', 'submit', 'dalej', 'zaloguj'];

// ── Detect form fields from snapshot ──
function isField(type, label) {
  const lower = (label || '').toLowerCase();
  return type && (type.includes('textbox') || type.includes('input') || type.includes('email'));
}
function isButton(type, label) {
  const lower = (label || '').toLowerCase();
  return type && (type.includes('button') || type.includes('link') || type.includes('submit'));
}

export function detectFormFields(snapshot) {
  const result = { email: null, password: null, submit: null };
  if (!snapshot) return result;

  const lines = snapshot.split('\n');

  for (const line of lines) {
    const trimmed = line.trim().toLowerCase();
    if (!trimmed || trimmed.startsWith('/')) continue;

    // Format 1: [button e4] Next  (old snapshot format)
    // Format 2: - textbox "Email or phone" [e1]  (Camofox accessibility tree)
    let type = null, ref = null, label = null;

    // Try Format 2 first: - type "label" [ref]
    const f2 = trimmed.match(/^-\s+(\w+)\s+"([^"]+)"\s+\[(e\d+)\]/);
    if (f2) {
      type = f2[1]; label = f2[2]; ref = f2[3];
    } else {
      // Try Format 1: [type ref] label
      const f1 = trimmed.match(/\[(\w+)\s+(e\d+)\]\s+(.+)/);
      if (f1) {
        type = f1[1]; ref = f1[2]; label = f1[3];
      } else {
        // Try Format 3: eN: type "label"
        const f3 = trimmed.match(/\[(e\d+)\]\s*:\s*(\w+)\s+"([^"]+)"/);
        if (f3) { ref = f3[1]; type = f3[2]; label = f3[3]; }
      }
    }

    if (!type || !ref) continue;

    const lowerLabel = (label || '').toLowerCase();
    const lowerType = (type || '').toLowerCase();

    // Detect email field
    if (!result.email && isField(type, label)) {
      const match = EMAIL_KEYWORDS.some(kw => lowerLabel.includes(kw));
      if (match) result.email = { ref, type, label };
    }

    // Detect password field
    if (!result.password && isField(type, label)) {
      const match = PASSWORD_KEYWORDS.some(kw => lowerLabel.includes(kw));
      // Also detect masked fields
      if (match || lowerType.includes('password')) result.password = { ref, type, label };
    }

    // Detect submit
    if (!result.submit && isButton(type, label)) {
      const match = SUBMIT_KEYWORDS.some(kw => lowerLabel.includes(kw));
      if (match) result.submit = { ref, type, label };
    }
  }

  return result;
}

export function detectOtpField(snapshot) {
  // Detect 2FA/TOTP input field
  const otpKeywords = ['verification code', 'code', 'totp', '2fa', 'two-factor', 'otp', 'authenticator', '6-digit', 'enter the code'];
  const lines = snapshot.split('\n');
  for (const line of lines) {
    const trimmed = line.trim().toLowerCase();
    if (!trimmed) continue;
    const f2 = trimmed.match(/^-\s+(\w+)\s+"([^"]+)"\s+\[(e\d+)\]/);
    if (f2) {
      const label = f2[2].toLowerCase();
      if (otpKeywords.some(kw => label.includes(kw))) return { ref: f2[3], label: f2[2] };
    }
  }
  return null;
}

// ── Main auto-login function ──
export async function autoLogin(service, authVaultUrl, config, log, events, sessions, camofoxPort) {
  const results = { ok: false, error: null, tabId: null, logged: false, reason: null };

  // 1. Resolve login URL
  let loginUrl = SERVICE_LOGIN_URLS[service];
  if (!loginUrl) {
    try {
      const tmpl = await fetch(`${authVaultUrl}/api/services/${encodeURIComponent(service)}`);
      if (tmpl.ok) {
        const data = await tmpl.json();
        loginUrl = data.loginUrl || data.url || null;
      }
    } catch (err) {
      log('warn', 'auto-login: service template lookup failed', { service, error: err.message });
    }
  }
  if (!loginUrl) {
    results.error = `Unknown service: ${service}. No login URL configured.`;
    return results;
  }

  // 2. Fetch credentials
  let credId = null, username = null, password = null;
  let totpSecret = null;
  try {
    const credResp = await fetch(`${authVaultUrl}/api/credentials?service=${encodeURIComponent(service)}`);
    if (!credResp.ok) {
      results.error = `auth-vault unreachable (${credResp.status})`;
      return results;
    }
    const credData = await credResp.json();
    if (!credData.entries || credData.entries.length === 0) {
      results.error = `No credentials found for service: ${service}`;
      return results;
    }
    credId = credData.entries[0].id;

    // Fetch with password
    const fullResp = await fetch(`${authVaultUrl}/api/credentials/${credId}?includePassword=true`);
    if (!fullResp.ok) {
      results.error = `Cannot fetch credential details (${fullResp.status})`;
      return results;
    }
    const fullData = await fullResp.json();
    const creds = fullData.credentials || fullData;
    username = creds.username || creds.email || creds.user || '';
    password = creds.password || creds.passwd || '';

    // Try TOTP secret
    try {
      const totpResp = await fetch(`${authVaultUrl}/api/credentials/${credId}/totp`);
      if (totpResp.ok) {
        const totpData = await totpResp.json();
        totpSecret = totpData.secret || totpData.totp || null;
      }
    } catch { /* TOTP may not be configured */ }
  } catch (err) {
    results.error = `auth-vault error: ${err.message}`;
    return results;
  }

  if (!username || !password) {
    results.error = 'Incomplete credentials (missing username or password)';
    return results;
  }

  // 3. Create tab
  try {
    const tabResp = await fetch(`http://127.0.0.1:${camofoxPort}/tabs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: '__vault_bot__', sessionKey: `auto-${service}`, url: loginUrl }),
    });
    if (!tabResp.ok) {
      results.error = `Camofox tab creation failed (${tabResp.status})`;
      return results;
    }
    const tabResult = await tabResp.json();
    results.tabId = tabResult.tabId;
  } catch (err) {
    results.error = `Camofox error: ${err.message}`;
    return results;
  }

  // 4. Wait for page + snapshot
  await sleep(3000);
  let snapshot;

  // Helper: get snapshot
  async function getSnap() {
    const r = await fetch(`http://127.0.0.1:${camofoxPort}/tabs/${results.tabId}/snapshot?userId=__vault_bot__`);
    if (!r.ok) return '';
    const text = await r.text();
    try { const parsed = JSON.parse(text); return parsed.snapshot || text; } catch { return text; }
  }

  // 5. Fill form
  snapshot = await getSnap();
  let fields = detectFormFields(snapshot);

  if (!fields.email) {
    // Try clicking "Sign in" button first (some pages need it)
    const signInRef = extractFirstRef(snapshot, ['sign in', 'log in', 'login', 'get started', 'signin']);
    if (signInRef) {
      await clickTab(results.tabId, signInRef, camofoxPort);
      await sleep(3000);
      snapshot = await getSnap();
      fields = detectFormFields(snapshot);
    }
  }

  if (!fields.email) {
    results.error = 'Could not detect email field';
    results.snapshotPreview = (snapshot || '').substring(0, 300);
    // Close tab on failure
    closeTab(results.tabId, camofoxPort);
    return results;
  }

  // Type email
  await typeTab(results.tabId, fields.email.ref, username, camofoxPort);
  await sleep(800);

  if (fields.password) {
    // Type password
    await typeTab(results.tabId, fields.password.ref, password, camofoxPort);
    await sleep(500);

    // Click submit
    if (fields.submit) {
      await clickTab(results.tabId, fields.submit.ref, camofoxPort);
      await sleep(4000);
    }
  } else if (fields.submit) {
    // Click submit after email (Google-like multi-step)
    await clickTab(results.tabId, fields.submit.ref, camofoxPort);
    await sleep(4000);

    // Now detect password field
    snapshot = await getSnap();
    fields = detectFormFields(snapshot);
    if (fields.password) {
      await typeTab(results.tabId, fields.password.ref, password, camofoxPort);
      await sleep(500);

      // Click submit for password
      if (!fields.submit) {
        const nextRef = extractFirstRef(snapshot, ['next', 'continue', 'dalej']);
        if (nextRef) fields.submit = { ref: nextRef };
      }
      if (fields.submit) {
        await clickTab(results.tabId, fields.submit.ref, camofoxPort);
        await sleep(4000);
      }
    }
  }

  // 6. Handle 2FA/TOTP
  snapshot = await getSnap();
  const otpField = detectOtpField(snapshot);
  if (otpField && totpSecret) {
    log('info', 'auto-login: 2FA detected, generating TOTP', { service });
    try {
      const totpResp = await fetch(`${authVaultUrl}/api/credentials/${credId}/totp`);
      if (totpResp.ok) {
        const totpData = await totpResp.json();
        const code = totpData.code || totpData.totp || '';
        if (code) {
          await typeTab(results.tabId, otpField.ref, code, camofoxPort);
          await sleep(800);
          // Click submit/verify
          const verifyRef = extractFirstRef(snapshot, ['verify', 'confirm', 'next', 'continue', 'submit']);
          if (verifyRef) {
            await clickTab(results.tabId, verifyRef, camofoxPort);
            await sleep(3000);
          }
        }
      }
    } catch (err) {
      log('warn', 'auto-login: TOTP failed', { service, error: err.message });
    }
  } else if (otpField && !totpSecret) {
    log('warn', 'auto-login: 2FA detected but no TOTP secret', { service });
  }

  // 7. Verify login
  await sleep(3000);
  snapshot = await getSnap();
  const verifyFields = detectFormFields(snapshot);
  results.logged = !verifyFields.email;
  results.reason = results.logged ? 'form_disappeared' : 'email_field_still_visible';

  if (results.logged) {
    log('info', 'auto-login SUCCESS', { service, tabId: results.tabId });
    results.ok = true;
  } else {
    log('warn', 'auto-login FAILED', { service, tabId: results.tabId, reason: results.reason });
    closeTab(results.tabId, camofoxPort);
  }

  return results;
}

// ── Helpers ──
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function typeTab(tabId, ref, text, port) {
  await fetch(`http://127.0.0.1:${port}/tabs/${tabId}/type`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: '__vault_bot__', ref, text }),
  });
}

async function clickTab(tabId, ref, port) {
  await fetch(`http://127.0.0.1:${port}/tabs/${tabId}/click`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: '__vault_bot__', ref }),
  });
}

async function closeTab(tabId, port) {
  try { await fetch(`http://127.0.0.1:${port}/tabs/${tabId}?userId=__vault_bot__`, { method: 'DELETE' }); }
  catch {}
}

function extractFirstRef(snapshot, keywords) {
  // Find a button/link that matches keywords - returns first matching ref
  const lines = snapshot.split('\n');
  for (const line of lines) {
    const lower = line.trim().toLowerCase();
    if (!lower) continue;
    // Match button/link with keyword
    const match = lower.match(/\[(e\d+)\]\s*:\s*(\w+)\s+"([^"]+)"/);
    if (match) {
      const type = match[2], label = match[3].toLowerCase(), ref = match[1];
      if (keywords.some(kw => label.includes(kw))) return ref;
    }
    const match2 = lower.match(/-\s+(\w+)\s+"([^"]+)"\s+\[(e\d+)\]/);
    if (match2) {
      const type = match2[1], label = match2[2].toLowerCase(), ref = match2[3];
      if (keywords.some(kw => label.includes(kw))) return ref;
    }
  }
  return null;
}
