/**
 * Q-Mask — uniwersalna warstwa kontrolna dla agentów AI.
 * Wstrzykiwana przez addInitScript do KAŻDEJ strony (desktop + mobile).
 *
 * Problem który rozwiązuje:
 *   Angular/Gemini randomizują aria-label/ID/klasy żeby zablokować automatyzację.
 *   Agent goni volatile DOM → przegrywa.
 *
 * Rozwiązanie (maska):
 *   Agent rozmawia TYLKO ze stabilną warstwą [data-q-mask="*"].
 *   Maska tłumaczy intencje agenta na volatile DOM przez HEURYSTYKI ZACHOWANIA,
 *   nie przez sztywne selektory.
 *
 * Kontrakt maski (stałe atrybuty):
 *   [data-q-mask="app"]         — korzeń maski (fixed overlay)
 *   [data-q-mask="input"]        — pole tekstowe (agent wpisuje tu prompt)
 *   [data-q-mask="attach"]       — przycisk dodania załącznika (obraz/plik)
 *   [data-q-mask="send"]         — przycisk wysyłania
 *   [data-q-mask="canvas"]       — płótno debug (bboxy, adnotacje)
 *   [data-q-mask="status"]       — log statusu (loading, ready, sent)
 *   [data-q-mask="mode"]         — desktop | mobile (wygląd maski)
 *
 * Maska NIE nadpisuje strony — jest przezroczystym overlayem z wyłączanym
 * "trybem agenta" (toggle prawy górny róg). Gdy wyłączona, strona działa normalnie.
 */

const QMASK_INIT = function () {
  // Już wstrzyknięte?
  if (window.__qmask_installed) return;
  window.__qmask_installed = true;

  // Wykryj mobile (viewport < 768 lub touch)
  const isMobile = (window.innerWidth < 768) ||
    ('ontouchstart' in window) ||
    /Mobi|Android/i.test(navigator.userAgent);

  // ── Styl maski ───────────────────────────────────────
  const style = document.createElement('style');
  style.setAttribute('data-q-mask-style', 'true');
  style.textContent = `
    [data-q-mask="app"] {
      position: fixed;
      top: 0; left: 0;
      width: 100%; height: 100%;
      pointer-events: none;
      z-index: 2147483647;
      font-family: -apple-system, system-ui, sans-serif;
    }
    [data-q-mask="app"].qmask-hidden { display: none; }

    [data-q-mask="toggle"] {
      position: fixed;
      top: 8px; right: 8px;
      width: 34px; height: 34px;
      border-radius: 50%;
      background: #003F7A; color: #f5c518;
      border: 2px solid #f5c518;
      pointer-events: auto;
      cursor: pointer;
      font-size: 16px; font-weight: bold;
      display: flex; align-items: center; justify-content: center;
      z-index: 2147483647;
      box-shadow: 0 2px 8px rgba(0,0,0,.5);
    }
    [data-q-mask="toggle"].active { background: #f5c518; color: #003F7A; }

    [data-q-mask="bar"] {
      position: fixed;
      bottom: 0; left: 0;
      width: 100%;
      display: flex; gap: 6px;
      padding: 8px;
      background: linear-gradient(transparent, rgba(0,63,122,.92));
      pointer-events: auto;
      box-sizing: border-box;
    }
    [data-q-mask="app"].qmask-hidden [data-q-mask="bar"] { display: none; }

    [data-q-mask="input"] {
      flex: 1;
      min-height: 40px;
      max-height: 120px;
      resize: none;
      border: 2px solid #003F7A;
      border-radius: 8px;
      padding: 8px 12px;
      font-size: 15px;
      background: rgba(255,255,255,.97);
      color: #111;
      pointer-events: auto;
    }
    [data-q-mask="attach"], [data-q-mask="send"] {
      width: 44px; height: 44px;
      border-radius: 8px;
      border: none;
      cursor: pointer;
      font-size: 20px;
      pointer-events: auto;
      flex-shrink: 0;
    }
    [data-q-mask="attach"] { background: #444; color: #fff; }
    [data-q-mask="send"] { background: #003F7A; color: #f5c518; }
    [data-q-mask="send"]:disabled { opacity: .4; cursor: not-allowed; }

    [data-q-mask="status"] {
      position: fixed;
      top: 8px; left: 8px;
      background: rgba(0,0,0,.8); color: #f5c518;
      padding: 4px 10px; border-radius: 12px;
      font-size: 12px; pointer-events: none;
      max-width: 60%;
      z-index: 2147483647;
    }

    /* LED — świecąca dioda statusu */
    [data-q-mask="led"] {
      position: fixed;
      top: 12px; right: 50px;
      width: 14px; height: 14px;
      border-radius: 50%;
      background: #00ff66;
      box-shadow: 0 0 8px #00ff66, 0 0 16px #00ff66;
      pointer-events: none;
      z-index: 2147483647;
      transition: background .3s, box-shadow .3s;
    }
    [data-q-mask="led"].qmask-led-idle {
      background: #00ff66; box-shadow: 0 0 8px #00ff66, 0 0 16px #00ff66;
      animation: qmask-pulse 2s infinite;
    }
    [data-q-mask="led"].qmask-led-processing {
      background: #ffcc00; box-shadow: 0 0 10px #ffcc00, 0 0 20px #ffcc00;
      animation: qmask-blink 0.8s infinite;
    }
    [data-q-mask="led"].qmask-led-attach {
      background: #3399ff; box-shadow: 0 0 10px #3399ff, 0 0 20px #3399ff;
      animation: qmask-pulse 1s infinite;
    }
    [data-q-mask="led"].qmask-led-error {
      background: #ff3333; box-shadow: 0 0 10px #ff3333, 0 0 20px #ff3333;
      animation: qmask-blink 0.4s infinite;
    }
    [data-q-mask="led"].qmask-led-notify {
      background: #cc66ff; box-shadow: 0 0 12px #cc66ff, 0 0 24px #cc66ff;
      animation: qmask-pulse 0.6s infinite;
    }
    @keyframes qmask-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    @keyframes qmask-blink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.2; }
    }

    [data-q-mask="canvas"] {
      position: fixed; inset: 0;
      pointer-events: none;
      z-index: 2147483646;
    }

    /* Mobile: bar na dole, większe przyciski */
    [data-q-mask="app"].qmask-mobile [data-q-mask="input"] { font-size: 16px; }
    [data-q-mask="app"].qmask-mobile [data-q-mask="attach"],
    [data-q-mask="app"].qmask-mobile [data-q-mask="send"] { width: 52px; height: 52px; }
  `;
  document.documentElement.appendChild(style);

  // ── Struktura maski ─────────────────────────────────
  const app = document.createElement('div');
  app.setAttribute('data-q-mask', 'app');
  app.setAttribute('data-q-mask-mode', isMobile ? 'mobile' : 'desktop');
  if (isMobile) app.classList.add('qmask-mobile');

  // Toggle
  const toggle = document.createElement('button');
  toggle.setAttribute('data-q-mask', 'toggle');
  toggle.textContent = 'Q';
  toggle.title = 'Q-Mask: przełącz warstwę agenta';
  toggle.classList.add('active');
  toggle.addEventListener('click', () => {
    const hidden = app.classList.toggle('qmask-hidden');
    toggle.classList.toggle('active', !hidden);
  });

  // LED (świecąca dioda statusu)
  const led = document.createElement('div');
  led.setAttribute('data-q-mask', 'led');
  led.classList.add('qmask-led-idle');
  led.title = 'Q-Mask status LED';

  // Status
  const status = document.createElement('div');
  status.setAttribute('data-q-mask', 'status');
  status.textContent = 'Q-Mask gotowy';

  // Canvas (debug)
  const canvas = document.createElement('canvas');
  canvas.setAttribute('data-q-mask', 'canvas');

  // Bar (input + attach + send)
  const bar = document.createElement('div');
  bar.setAttribute('data-q-mask', 'bar');

  const input = document.createElement('textarea');
  input.setAttribute('data-q-mask', 'input');
  input.placeholder = 'Wpisz prompt dla agenta…';

  const attach = document.createElement('button');
  attach.setAttribute('data-q-mask', 'attach');
  attach.textContent = '📎';
  attach.title = 'Dodaj załącznik (obraz/plik)';

  const send = document.createElement('button');
  send.setAttribute('data-q-mask', 'send');
  send.textContent = '➤';
  send.title = 'Wyślij';

  // Hidden file input (per maska)
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*,application/*';
  fileInput.style.display = 'none';
  fileInput.setAttribute('data-q-mask-file', 'true');

  bar.appendChild(input);
  bar.appendChild(attach);
  bar.appendChild(send);

  app.appendChild(canvas);
  app.appendChild(status);
  app.appendChild(toggle);
  app.appendChild(led);
  app.appendChild(bar);
  app.appendChild(fileInput);
  document.documentElement.appendChild(app);

  // ── LED (świecąca dioda statusu) ─────────────────────
  function setLed(s) {
    led.className = '';
    led.classList.add('qmask-led-' + s);
  }
  window.__qmask_setLed = setLed;

  // ── Stan maski ───────────────────────────────────────
  const state = {
    mode: isMobile ? 'mobile' : 'desktop',
    attachmentReady: false,
    sending: false,
  };
  window.__qmask_state = state;

  function setStatus(msg) {
    status.textContent = msg;
    // LED reaguje na słowa kluczowe w statusie
    const m = (msg || '').toLowerCase();
    if (/błąd|error|fail/.test(m)) setLed('error');
    else if (/wysył|processing|ładowan|czek/.test(m)) setLed('processing');
    else if (/załącz|attach/.test(m)) setLed('attach');
    else if (/gotowy|ready|✓/.test(m)) setLed('idle');
    else setLed('idle');
  }
  window.__qmask_setStatus = setStatus;

  // ── HEURYSTYKI (wolatile DOM → stabilna intencja) ────

  // Znajdź właściwe pole tekstowe na stronie docelowej
  function findTargetInput() {
    // 1. contenteditable (Gemini, ChatGPT, Notion…)
    const ce = document.querySelector('[contenteditable="true"]');
    if (ce) return { el: ce, kind: 'contenteditable' };
    // 2. textarea
    const ta = document.querySelector('textarea:not([data-q-mask="input"])');
    if (ta) return { el: ta, kind: 'textarea' };
    // 3. input[type=text]
    const inp = document.querySelector('input[type="text"], input[type="search"]');
    if (inp) return { el: inp, kind: 'input' };
    return null;
  }

  // Znajdź przycisk wysyłania (4 fallbacki)
  function findSendButton() {
    // 1. aria-label zawiera "wyślij"/"send"/"submit"
    const byAria = Array.from(document.querySelectorAll('button[aria-label]'))
      .find(b => /wyślij|wyslij|send|submit/i.test(b.getAttribute('aria-label')));
    if (byAria) return byAria;
    // 2. ostatni button w composerze (form w okolicy inputu)
    const tgt = findTargetInput();
    if (tgt) {
      const form = tgt.el.closest('form');
      if (form) {
        const btn = form.querySelector('button[type="submit"]');
        if (btn) return btn;
      }
    }
    // 3. button z strzałką / ikoną send
    const byIcon = Array.from(document.querySelectorAll('button'))
      .find(b => /send|paper|arrow|➤|→/i.test(b.textContent || '') ||
                  (b.querySelector && b.querySelector('svg path[d*="M2.01"]')));
    if (byIcon) return byIcon;
    // 4. fallback: Enter w polu
    return null;
  }

  // Znajdź ukryty input[type=file] strony (dla załącznika)
  function findPageFileInput() {
    return document.querySelector('input[type="file"]');
  }

  // ── ZACHOWANIA ───────────────────────────────────────

  // ATTACH: agent klika [data-q-mask="attach"]
  attach.addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    setStatus('Załączanie: ' + file.name);

    // 1. Znajdź ukryty file input strony
    const pageFile = findPageFileInput();
    if (pageFile) {
      try {
        const dt = new DataTransfer();
        dt.items.add(file);
        pageFile.files = dt.files;
        pageFile.dispatchEvent(new Event('change', { bubbles: true }));
        pageFile.dispatchEvent(new Event('input', { bubbles: true }));
      } catch (e) {
        setStatus('Błąd załączania: ' + e.message);
        return;
      }
    } else {
      setStatus('Brak input[type=file] na stronie');
      return;
    }

    // 2. CZEKAJ aż obrazek się załaduje (Gemini: "Wczytuję obraz")
    const waitForReady = () => new Promise((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const body = document.body.innerText || '';
        const ready = !body.includes('Wczytuję obraz') &&
                      !body.includes('Loading image') &&
                      !body.includes('Przesyłanie');
        const hasAttach = Array.from(document.querySelectorAll('button[aria-label]'))
          .some(b => /zamknij załącznik|remove attachment|delete attachment/i.test(b.getAttribute('aria-label') || ''));
        if ((ready && hasAttach) || Date.now() - t0 > 15000) {
          clearInterval(iv);
          resolve(ready && hasAttach);
        }
      }, 300);
    });

    const ok = await waitForReady();
    state.attachmentReady = ok;
    send.disabled = false;
    setStatus(ok ? 'Załącznik gotowy ✓' : 'Załącznik: timeout (spróbuj ręcznie)');
  });

  // SEND: agent klika [data-q-mask="send"] LUB Enter w input
  async function doSend() {
    if (state.sending) return;
    state.sending = true;
    send.disabled = true;
    setStatus('Wysyłanie…');

    const text = input.value.trim();
    const tgt = findTargetInput();

    if (tgt) {
      if (tgt.kind === 'contenteditable') {
        tgt.el.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(tgt.el);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('insertText', false, text);
      } else {
        const cur = tgt.el.value || '';
        tgt.el.value = cur ? cur + '\n' + text : text;
        tgt.el.dispatchEvent(new Event('input', { bubbles: true }));
        tgt.el.focus();
      }
    }

    const sendBtn = findSendButton();
    if (sendBtn) {
      sendBtn.click();
    } else if (tgt) {
      tgt.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      tgt.el.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      tgt.el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    }

    input.value = '';
    state.attachmentReady = false;
    state.sending = false;
    setStatus('Wysłano ✓');
    setLed('notify');  // fioletowa dioda = wysłano, czekaj na odpowiedź
    setTimeout(() => { send.disabled = false; }, 500);
  }

  send.addEventListener('click', doSend);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  });

  // Canvas resize
  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // ATTACH FILE (przez server-side endpoint — omija Chromium restrictions)
  // Maska wywołuje: window.__qmask.attachFile("iVBOR...", "image/png")
  // Serwer (camofox q-mask plugin) robi Playwright setInputFiles.
  async function attachFile(b64, mime) {
    setStatus('Załączanie pliku…');
    const tabId = window.__qmask_tabId;
    if (!tabId) { setStatus('Brak tabId (maska niezainicjalizowana)'); return false; }
    try {
      const resp = await fetch(`/qmask/attach/${tabId}?userId=q&sessionKey=botai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ b64, mime: mime || 'image/png', userId: 'q', sessionKey: 'botai' })
      });
      const data = await resp.json();
      if (!data.ok) { setStatus('Błąd serwera: ' + (data.error || 'unknown')); return false; }
      const ok = data.attached;
      state.attachmentReady = ok;
      send.disabled = false;
      setStatus(ok ? 'Załącznik gotowy ✓' : 'Załącznik: timeout');
      return ok;
    } catch (e) {
      setStatus('Błąd załączania: ' + e.message);
      return false;
    }
  }

  // API dla agenta (przez page.evaluate)
  window.__qmask = {
    attach: () => attach.click(),
    attachFile: (dataUrl) => attachFile(dataUrl),
    send: (text) => { input.value = text; return doSend(); },
    getState: () => ({ ...state, mode: isMobile ? 'mobile' : 'desktop' }),
    setMode: (m) => { state.mode = m; app.classList.toggle('qmask-mobile', m === 'mobile'); },
    toggle: () => toggle.click(),
    setLed: (s) => setLed(s),
    drawBox: (x, y, w, h, label) => {
      const ctx = canvas.getContext('2d');
      ctx.strokeStyle = '#f5c518';
      ctx.lineWidth = 3;
      ctx.strokeRect(x, y, w, h);
      if (label) {
        ctx.fillStyle = '#f5c518';
        ctx.font = '14px sans-serif';
        ctx.fillText(label, x + 4, y - 6);
      }
    },
    clearCanvas: () => { const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height); },
  };

  console.log('[Q-Mask] installed (mode=' + (isMobile ? 'mobile' : 'desktop') + ')');
};

// Export jako string dla addInitScript
export const QMASK_SOURCE = '(' + QMASK_INIT.toString() + ')();';
