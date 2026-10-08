/**
 * Unit tests for vault-login plugin — auto-login.js
 */
import { jest } from '@jest/globals';
import { detectQDomain, findFieldRef } from './index.js';

let detectFormFields, detectOtpField, autoLogin, modRegister;

beforeAll(async () => {
  const mod = await import('./auto-login.js');
  detectFormFields = mod.detectFormFields;
  detectOtpField = mod.detectOtpField;
  autoLogin = mod.autoLogin;
  try { const idx = await import('./index.js'); modRegister = idx.register; } catch {}
});

global.fetch = jest.fn();

// ── detectFormFields ──

describe('detectFormFields', () => {
  test('detects email in Format 2 (Camofox accessibility tree)', () => {
    const snap = `- main: "Page"
  - textbox "Email or phone" [e1]
  - textbox "Password" [e2]
  - button "Next" [e3]`;
    const r = detectFormFields(snap);
    expect(r.email.ref).toBe('e1');
    expect(r.password.ref).toBe('e2');
    expect(r.submit.ref).toBe('e3');
  });

  test('detects fields in Format 1 ([type ref] label)', () => {
    const snap = `[textbox e1] Email or phone
[textbox e2] Enter your password
[button e3] Sign in`;
    const r = detectFormFields(snap);
    expect(r.email.ref).toBe('e1');
    expect(r.password.ref).toBe('e2');
    expect(r.submit.ref).toBe('e3');
  });

  test('detects fields in Format 3 (eN: type "label")', () => {
    const snap = `[e1]: textbox "Email or phone"
[e2]: textbox "Password"
[e3]: button "Log in"`;
    const r = detectFormFields(snap);
    expect(r.email.ref).toBe('e1');
    expect(r.password.ref).toBe('e2');
    expect(r.submit.ref).toBe('e3');
  });

  test('returns nulls when no fields found', () => {
    const r = detectFormFields('- heading "Welcome"\n- paragraph "Some text"');
    expect(r.email).toBeNull();
    expect(r.password).toBeNull();
    expect(r.submit).toBeNull();
  });

  test('handles empty and null snapshots', () => {
    expect(detectFormFields('').email).toBeNull();
    expect(detectFormFields(null).email).toBeNull();
  });

  test('detects email with keyword variations', () => {
    for (const label of ['Email', 'email', 'e-mail', 'Username', 'Phone']) {
      expect(detectFormFields(`- textbox "${label}" [e1]`).email).toBeTruthy();
    }
  });

  test('detects submit with keyword variations', () => {
    for (const label of ['Next', 'Sign in', 'Log in', 'Continue', 'Submit', 'Dalej']) {
      expect(detectFormFields(`- button "${label}" [e1]`).submit).toBeTruthy();
    }
  });
});

// ── detectOtpField ──

describe('detectOtpField', () => {
  test('detects verification code field', () => {
    const snap = `- textbox "Enter verification code" [e5]
- textbox "Password" [e2]`;
    expect(detectOtpField(snap).ref).toBe('e5');
  });

  test('returns null when no OTP field', () => {
    expect(detectOtpField(`- textbox "Email" [e1]`)).toBeNull();
  });
});

// ── autoLogin pipeline ──

describe('autoLogin pipeline', () => {
  const log = { info: jest.fn(), warn: jest.fn() };

  beforeEach(() => {
    global.fetch.mockReset();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('returns error when auth-vault unreachable', async () => {
    jest.useRealTimers();
    global.fetch.mockRejectedValue(new Error('Connection refused'));
    const r = await autoLogin('google', 'http://vault:5600', {}, log, {}, {}, 9377);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('auth-vault');
  });

  test('returns error when no credentials found', async () => {
    jest.useRealTimers();
    // google is in SERVICE_LOGIN_URLS, so skip login URL lookup
    global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ entries: [] }) });
    const r = await autoLogin('google', 'http://vault:5600', { port: 9377 }, log, {}, {}, 9377);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('No credentials');
  });

  async function runPipeline(pipelineFn) {
    const p = pipelineFn();
    while (true) {
      try { return await Promise.race([p, jest.advanceTimersByTimeAsync(5000)]); }
      catch (e) {
        if (e.message === 'No credentials' || e.message.includes('Connection')) throw e;
        // continue advancing
      }
    }
  }

  test.skip('completes full Google login pipeline', async () => {
    // Integration test - requires real Camofox + auth-vault
  });
});

// ── index.js ──

describe('index.js exports', () => {
  test('exports register function', () => {
    expect(typeof modRegister).toBe('function');
  });
});

// ── detectQDomain ──

describe('detectQDomain', () => {
  test('detects skills.local', () => {
    expect(detectQDomain('https://skills.local/login')).toBe('q-ecosystem');
  });
  test('detects q-battle', () => {
    expect(detectQDomain('https://q-battle.example.com')).toBe('q-battle');
  });
  test('detects predator IP', () => {
    expect(detectQDomain('http://100.127.247.39:9377')).toBe('predator');
  });
  test('detects mariusz IP', () => {
    expect(detectQDomain('http://100.103.113.46:9901')).toBe('mariusz');
  });
  test('detects camofox localhost', () => {
    expect(detectQDomain('http://localhost:9377')).toBe('camofox');
  });
  test('detects tailscale ts.net', () => {
    expect(detectQDomain('https://predator13.tailb6168e.ts.net')).toBe('tailscale');
  });
  test('returns null for unknown domain', () => {
    expect(detectQDomain('https://google.com')).toBeNull();
  });
  test('returns null for empty url', () => {
    expect(detectQDomain('')).toBeNull();
  });
});

// ── findFieldRef ──

describe('findFieldRef', () => {
  test('finds email ref', () => {
    const snap = `- textbox "Email or phone" [e1]\n- button "Sign in" [e2]`;
    expect(findFieldRef(snap, ['email'])).toBe('e1');
  });
  test('finds password ref', () => {
    const snap = `- textbox "Password" [e3]`;
    expect(findFieldRef(snap, ['password'])).toBe('e3');
  });
  test('returns null for no match', () => {
    expect(findFieldRef('no fields here', ['email'])).toBeNull();
  });
});
