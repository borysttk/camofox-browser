#!/usr/bin/env python3
"""Keepalive Camofoxa — gwarantuje, że ZAWSZE jest żywa zakładka.

Wymóg TTK (2026-10-01):
  1. Camofox działa cały czas (nie tylko podczas sesji)
  2. Po zamknięciu ostatniej karty nowa otwiera się w ciągu chwili

Dlaczego to ważne przy VNC: w trybie CAMOFOX_INTERACTIVE=desktop Camoufox
renderuje okno na DISPLAY. Zamknięcie ostatniej karty zabija okno → x11vnc
pokazuje pusty root window → noVNC na telefonie = czarny ekran.

Poprzedni keepalive.sh tylko sprawdzał `browserConnected` i nigdy nie odtwarzał
zakładki, więc po zamknięciu ostatniej karty VNC ciemniał na dobre.

Używa Authorization: Bearer z unita systemd — /tabs wymaga tokena.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

API = "http://127.0.0.1:9377"
# userId musi być identyczny z camofox.config.json (userId: "q") — inaczej
# persistence trzyma osobny profil cookies i karta ratunkowa loguje się
# na nowo zamiast współdzielić sesję z kartami otwartymi w VNC.
USER_ID = "q"
# sessionKey musi być TYM SAMYM co w camofox.config.json (sessionKey: "botai").
# Różna wartość = inna grupa zakładek, więc /tabs widzi kartę ratunkową osobno
# od Twoich kart VNC i mogą się nie wykluczać przy sprawdzaniu aktywności.
SESSION_KEY = "botai"

# Strona startowa — lekka, zawsze dostępna, widać że przeglądarka żyje.
#
# Q patch (2026-10-11): URL brany jest ze zmiennej Q_START_URL z unita
# systemd, zamiast być wpisany na sztywno. Wcześniej startowało github.com
# niezależnie od tego, co faktycznie skonfigurowano — Q_START_URL był
# ustawiony, ale nikt go nie czytał (server.js też go ignoruje), więc
# wyglądało to na "strona startowa działa", a tak nie było.
#
# Kolejność: Q_START_URL → Q_START_URL_FALLBACK → about:blank.
# about:blank jest ostatni, nie domyślny: github/google zasłaniają
# prawdziwy stan sesji w VNC, a pusta strona jest uczciwym wskaźnikiem
# że przeglądarka żyje, choć jeszcze nic nie załadowała.
START_URL = (os.environ.get("Q_START_URL") or "").strip() or "about:blank"

LOG = "/home/ttk/camofox-browser/keepalive.log"
MAX_LOG_LINES = 500


def log(msg: str) -> None:
    line = f"[{time.strftime('%a %d %b %Y %H:%M:%S')}] {msg}"
    print(line, file=sys.stderr)
    try:
        with open(LOG, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        pass
    # przycięcie logu, żeby nie rośl w nieskończoność
    try:
        with open(LOG, encoding="utf-8") as fh:
            lines = fh.readlines()
        if len(lines) > MAX_LOG_LINES:
            with open(LOG, "w", encoding="utf-8") as fh:
                fh.writelines(lines[-MAX_LOG_LINES:])
    except OSError:
        pass


def api_key() -> str | None:
    """CAMOFOX_API_KEY z unita systemd — nie hardkodujemy sekretu."""
    try:
        out = subprocess.run(
            ["systemctl", "--user", "show", "camofox-browser", "-p", "Environment", "--value"],
            capture_output=True, text=True, timeout=10,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    for token in out.split():
        if token.startswith("CAMOFOX_API_KEY="):
            return token.split("=", 1)[1].strip() or None
    return None


def request(path: str, key: str | None, body: dict | None = None, timeout: int = 30):
    """GET albo POST z Bearer. Zwraca (status, payload) — nie rzuca na 401/500."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method="POST" if data else "GET")
    req.add_header("Content-Type", "application/json")
    if key:
        req.add_header("Authorization", f"Bearer {key}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode(errors="replace")
            try:
                return resp.status, json.loads(raw)
            except json.JSONDecodeError:
                return resp.status, {"raw": raw[:200]}
    except urllib.error.HTTPError as e:
        return e.code, {"error": e.read().decode(errors="replace")[:160]}
    except Exception as e:  # noqa: BLE001 — keepalive musi przeżyć wszystko
        return 0, {"error": str(e)[:160]}


def tab_count(key: str | None) -> int:
    st, data = request(f"/tabs?userId={USER_ID}", key, timeout=20)
    if st != 200:
        return -1
    # /tabs zwraca OBIEKT {running, tabs:[...]} — nie tablicę.
    if isinstance(data, dict):
        tabs = data.get("tabs") or []
        return len(tabs) if isinstance(tabs, list) else 0
    return len(data) if isinstance(data, list) else 0


def open_start_tab(key: str | None) -> bool:
    st, data = request("/tabs/open", key, {"userId": USER_ID, "url": START_URL,
                                           "listItemId": SESSION_KEY}, timeout=90)
    ok = st == 200 and bool(data.get("tabId") or data.get("targetId")) if isinstance(data, dict) else st == 200
    return ok


def main() -> int:
    key = api_key()
    if not key:
        log("KEEPALIVE ERROR: nie znaleziono CAMOFOX_API_KEY w unicie — "
            "wolę nie strzelać ślepo do API")
        return 2

    st, health = request("/health", key, timeout=15)
    connected = bool(isinstance(health, dict) and health.get("browserConnected"))

    n = tab_count(key)
    if n < 0:
        log(f"KEEPALIVE: /tabs nie odpowiada (status={st}) — Camofox startuje lub pada")
        # Przeglądarka bywa martwa mimo 'running' → próbujemy wskazać restart przez kartę
        if not open_start_tab(key):
            log("KEEPALIVE: nie udało się otworzyć karty ratunkowej")
            return 1
        log("KEEPALIVE: otwarto kartę ratunkową")
        return 0

    if n == 0:
        if open_start_tab(key):
            log(f"KEEPALIVE: brak zakładek (browserConnected={connected}) — "
                f"otwarto {START_URL}, VNC znów ma co pokazać")
            return 0
        log("KEEPALIVE: brak zakładek i otwarcie nie powiodło się")
        return 1

    log(f"KEEPALIVE: OK — {n} zakładek, browserConnected={connected}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())