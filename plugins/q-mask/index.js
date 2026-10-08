/**
 * Q-Mask plugin — uniwersalna warstwa kontrolna (maska) dla agentów AI.
 *
 * Wstrzykuje się do KAŻDEJ strony przez addInitScript (tab:created hook).
 * Daje agentowi stabilny kontrakt [data-q-mask="*"] niezależny od volatile DOM.
 *
 * Endpoints:
 *   GET  /qmask/status               → health
 *   POST /qmask/send/:tabId          → wyślij tekst przez maskę (body: {text, userId, sessionKey})
 *   POST /qmask/state/:tabId         → stan maski
 *   POST /qmask/attach/:tabId        → SERVER-SIDE attach (Playwright setInputFiles, omija Chromium restrictions)
 *
 * Config: "plugins": { "q-mask": { "enabled": true, "autoInject": true } }
 */

import { QMASK_SOURCE } from './mask.js';
import fs from 'fs';

export async function register(app, ctx, pluginConfig = {}) {
  const { events, log, sessions, getSession, safeError } = ctx;
  const autoInject = pluginConfig.autoInject !== false;

  log('info', 'q-mask plugin: registering', { autoInject });

  if (autoInject && events && typeof events.on === 'function') {
    events.on('tab:created', async ({ userId, tabId, page, url }) => {
      try {
        if (!page || typeof page.addInitScript !== 'function') return;
        await page.addInitScript(QMASK_SOURCE);
        try { await page.evaluate(QMASK_SOURCE); } catch (e) {}
        // Przekaż tabId do maski (do server-side attach)
        try { await page.evaluate(`window.__qmask_tabId = '${tabId}'`); } catch (e) {}
        log('debug', 'q-mask: injected', { userId, tabId, url: url?.slice(0, 60) });
      } catch (e) {
        log('error', 'q-mask: inject failed', { userId, tabId, error: e.message });
      }
    });
    log('info', 'q-mask: tab:created hook active');
  }

  function getPage(userId, tabId) {
    const uid = String(userId).trim();
    const session = sessions.get(uid);
    if (!session) return null;
    for (const group of session.tabGroups.values()) {
      const ts = group.get(tabId);
      if (ts && ts.page) return ts.page;
    }
    return null;
  }

  app.get('/qmask/status', (req, res) => {
    res.json({ ok: true, plugin: 'q-mask', autoInject, activeSessions: sessions.size,
      hint: 'Maska wstrzykiwana automatycznie przez tab:created. Agent używa [data-q-mask="*"].' });
  });

  // ── SERVER-SIDE ATTACH (Playwright setInputFiles) ──
  // Chromium blokuje pageFile.files=dt.files w init script context.
  // Server ma pełny dostęp do page → używa native setInputFiles.
  app.post('/qmask/attach/:tabId', async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    const { tabId } = req.params;
    const userId = req.query.userId || req.body?.userId || 'q';
    const sessionKey = req.query.sessionKey || req.body?.sessionKey || 'botai';
    const b64 = req.body?.b64 || req.body?.base64;
    const mime = req.body?.mime || 'image/png';
    if (!b64) return res.status(400).json({ error: 'missing b64' });
    const page = getPage(userId, tabId);
    if (!page) return res.status(404).json({ error: 'tab not found', userId, tabId });

    const tmp = `/tmp/qmask_attach_${tabId}.bin`;
    try {
      fs.writeFileSync(tmp, Buffer.from(b64, 'base64'));
      // Kliknij menu załącznika (jak w działającym gemini_client.upload_file)
      const menuClicked = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button[aria-label]'))
          .find(b => /przesyłanie|załącz|attach|narz/i.test(b.getAttribute('aria-label') || ''));
        if (btn) { btn.click(); return true; }
        return false;
      });
      await page.waitForTimeout(2000);
      // Kliknij "Pliki" w menu (jak w upload_file: get_by_role button name="Pliki")
      const filesClicked = await page.evaluate(() => {
        const f = Array.from(document.querySelectorAll('button'))
          .find(b => (b.textContent || '').trim().toLowerCase() === 'pliki');
        if (f) { f.click(); return true; }
        return false;
      });
      await page.waitForTimeout(1500);
      // setInputFiles na pierwszy input[type=file]
      const selector = 'input[type=file]';
      await page.setInputFiles(selector, tmp);
      await page.waitForTimeout(2000);
      // Kliknij przycisk potwierdzający w dialogu plików (Gemini 2026: "Otwórz"/"Załącz"/"Wyślij")
      const confirmClicked = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const confirm = btns.find(b => {
          const t = (b.textContent || '').trim().toLowerCase();
          return t === 'otwórz' || t === 'otworz' || t === 'załącz' || t === 'wyślij' || t === 'wybierz' || /confirm|ok|select/i.test(t);
        });
        if (confirm) { confirm.click(); return confirm.textContent.trim(); }
        return false;
      });
      await page.waitForTimeout(2000);
      // Czekaj aż "Wczytuję obraz" zniknie (obrazek załadowany do UI)
      const ok = await page.waitForFunction(() => {
        const body = document.body.innerText || '';
        return !body.includes('Wczytuję obraz') && !body.includes('Loading image') && !body.includes('Przesyłanie');
      }, { timeout: 15000 }).then(() => true).catch(() => false);
      fs.unlinkSync(tmp);
      res.json({ ok: true, attached: ok, menuClicked, filesClicked, confirmClicked });
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      res.status(500).json({ error: safeError(e) });
    }
  });

  app.post('/qmask/send/:tabId', async (req, res) => {
    const { tabId } = req.params;
    const userId = req.query.userId || req.body?.userId || 'q';
    const sessionKey = req.query.sessionKey || req.body?.sessionKey || 'botai';
    const text = req.body?.text || '';
    const page = getPage(userId, tabId);
    if (!page) return res.status(404).json({ error: 'tab not found', userId, tabId });
    try {
      const result = await page.evaluate((t) => {
        if (!window.__qmask) return { error: 'mask not installed' };
        return window.__qmask.send(t);
      }, text);
      res.json({ ok: true, result });
    } catch (e) {
      res.status(500).json({ error: safeError(e) });
    }
  });

  app.post('/qmask/state/:tabId', async (req, res) => {
    const { tabId } = req.params;
    const userId = req.query.userId || req.body?.userId || 'q';
    const sessionKey = req.query.sessionKey || req.body?.sessionKey || 'botai';
    const page = getPage(userId, tabId);
    if (!page) return res.status(404).json({ error: 'tab not found' });
    try {
      const state = await page.evaluate(() => window.__qmask ? window.__qmask.getState() : null);
      res.json({ ok: true, state });
    } catch (e) {
      res.status(500).json({ error: safeError(e) });
    }
  });

  log('info', 'q-mask plugin: registered endpoints /qmask/*');
}
