#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# Aggiorna l'app in produzione (dopo aver copiato i nuovi file).
# Uso sul VPS: /opt/wattlab/scripts/update.sh
#
# Flusso tipico di aggiornamento dal tuo PC:
#   1. scp index.html root@IP:/opt/wattlab/site/          (nuovo sito)
#   2. scp -r wattlab-server/src root@IP:/opt/wattlab/server/   (nuovo backend)
#   3. ssh root@IP /opt/wattlab/scripts/update.sh
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail
cd /opt/wattlab

echo "▸ Rebuild API container…"
docker compose build api

echo "▸ Restart con zero-downtime-ish…"
docker compose up -d

echo "▸ Pulizia immagini vecchie…"
docker image prune -f

echo "▸ Stato:"
docker compose ps
echo "✓ Aggiornamento completato."
