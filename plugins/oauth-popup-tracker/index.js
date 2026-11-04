/**
 * oauth-popup-tracker — śledzi strony otwierane poza `page.on('popup')`.
 *
 * PROBLEM
 * Rdzeń (`server.js`, funkcja `attachPopupHandler`) wiąże `page.on('popup')`
 * TYLKO na stronach, które sam utworzył przez endpointy. Strona otwarta
 * z iframe'a, z `chrome-extension://`, albo popup wywołany z kontekstu, do
 * którego handler nie dotarł, jest "sierotą" — widać ją w przeglądarce,
 * ale `GET /tabs` jej nie wymienia, więc nie da się w nią kliknąć ani
 * odczytać snapshotu przez REST/MCP.
 *
 * To jest dokładnie ślepa plama, o którą zahacza attachPopupHandler
 * (patrz komentarz w rdzeniu: popup z iframe jest sierotą).
 *
 * ROZWIĄZANIE
 * `ctx.sessions` daje dostęp do mapy `userId -> { context, tabGroups }`.
 * W hooku `session:created` podpinamy `context.on('page')` — to zdarzenie
 * Playwrighta na KONTEKST, więc łapie KAŻDĄ nową stronę, w tym te, na które
 * nie ma lokalnego handlera. Nową stronę rejestrujemy w grupie `__popups__`
 * i emitujemy `tab:created`, żeby q-mask zobaczył popup tak samo jak zwykły tab.
 *
 * ZERO zmian w rdzeniu — plugin korzysta wyłącznie z publicznego `ctx`.
 *
 * KONFIGURACJA (camofox.config.json):
 *   "plugins": { "oauth-popup-tracker": { "enabled": true, "sessionKey": "__popups__" } }
 */

import crypto from 'node:crypto';

export async function register(app, ctx, pluginConfig = {}) {
  const { events, log, sessions, normalizeUserId } = ctx;

  if (pluginConfig.enabled === false) return;

  const groupKey = pluginConfig.sessionKey || '__popups__';
  // Niektóre konteksty mają wiele stron; hookujemy każdy kontekst dokładnie raz.
  const watched = new WeakSet();

  /** Minimalny TabState — rdzeń używa createTabState(), którego nie ma w ctx. */
  function makeTabState(page) {
    return {
      page,
      url: '',
      title: '',
      createdAt: Date.now(),
      lastAccess: Date.now(),
      downloads: [],
      // znaczniki, których szuka logika raportów i sprzątanie
      isPopup: true,
      popupOf: null,
    };
  }

  function watch(userId, context, sessionKey) {
    if (!context || typeof context.on !== 'function') return;
    if (watched.has(context)) return;
    watched.add(context);

    context.on('page', (page) => {
      try {
        const key = normalizeUserId(userId);
        const session = sessions.get(key);
        // Sesja mogła zostać zamknięta między hookiem a zdarzeniem.
        if (!session || session._closing) return;

        // `context.on('page')` NIE odróżnia nowej karty od popupu — wyzwala się
        // także przy normalnym otwarciu taba przez endpointy.
        //
        // Q patch (2026-10-11): SYNCHRONICZNY check poniżej przegrywał wyścig
        // i to był realny bug. `context.on('page')` fires w momencie, gdy
        // Playwright tworzy Page — a POST /tabs rejestruje kartę w
        // session.tabGroups dopiero PO `await createLeasedPage()`. Przez
        // ten czas zwykły tab wygląda jak sierota, więc KAŻDY tab
        // otwarty przez API był duplikowany do `__popups__` z tym samym URL.
        // Otwarcie 3 tabów dawało 3 prawdziwe + 3 duchy, które potem
        // widać w /tabs, w VNC i w każdym freeze/thaw liczącym karty.
        //
        // Poprawka: decyzję odraczamy o tick, bo wtedy rdzeń zdążył już
        // zarejestrować kartę. Prawdziwy popup (iframe / window.open z
        // strony, której nikt nie zarządza) nadal nie jest zarejestrowany
        // przez nikogo i nadal jest adoptowany.
        setTimeout(() => {
          try {
            const live = sessions.get(key);
            if (!live || live._closing) return;
            // Teraz check jest wiarygodny: rdzeń miał szansę zarejestrować.
            for (const group of live.tabGroups.values()) {
              for (const state of group.values()) {
                if (state && state.page === page) return; // ma zarządcę
              }
            }

            const tabId = `tab_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
            const group = live.tabGroups.get(groupKey) || new Map();
            if (!live.tabGroups.has(groupKey)) live.tabGroups.set(groupKey, group);

            const state = makeTabState(page);
            group.set(tabId, state);
            live.lastAccess = Date.now();

            log('info', 'oauth popup registered as managed tab', { userId: key, tabId, sessionKey: groupKey });
            // Dzięki temu q-mask wstrzykuje się do popupu jak do każdego taba.
            events.emit('tab:created', { userId: key, tabId, page, url: '' });

            // Rejestruj głębiej — popup może otworzyć kolejny popup.
            watch(key, page.context?.() || context, sessionKey);
          } catch (err) {
            log('warn', 'oauth-popup-tracker: page handler failed', { error: err?.message });
          }
        }, 0);
      } catch (err) {
        log('warn', 'oauth-popup-tracker: page handler failed', { error: err?.message });
      }
    });
  }

  events.on('session:created', ({ userId, context }) => {
    watch(normalizeUserId(userId), context, groupKey);
  });

  // Restart przeglądarki tworzy nowe konteksty — hook ponownie na created.
  events.on('browser:launched', () => {
    watched.unsafeReset?.();
  });

  log('info', 'oauth-popup-tracker enabled', { sessionKey: groupKey });
}