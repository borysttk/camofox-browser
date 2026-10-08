#!/bin/sh
# Keepalive for Camofox Browser - prevents idle shutdown and auto-heals
HEALTH=$(curl -s http://127.0.0.1:9377/health)
CONNECTED=$(echo "$HEALTH" | python3 -c "import sys,json;print(json.load(sys.stdin).get('browserConnected',False))")

if [ "$CONNECTED" != "True" ]; then
  echo "[$(date)] Browser dead, triggering session recovery" >> /home/ttk/camofox-browser/keepalive.log
  # Create a tab to force browser relaunch
  curl -s -X POST http://127.0.0.1:9377/tabs -H "Content-Type: application/json" -d '{"userId":"q","sessionKey":"keepalive","url":"https://example.com"}' > /dev/null
else
  echo "[$(date)] Browser healthy" >> /home/ttk/camofox-browser/keepalive.log
fi
