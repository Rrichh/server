#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# Ripristina un backup del database.
# Uso: ./restore.sh /opt/wattlab/backups/wattlab_20260611_030000.sql.gz
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

FILE="${1:?Uso: ./restore.sh <file.sql.gz>}"

if [[ ! -f "$FILE" ]]; then
  echo "File non trovato: $FILE"; exit 1
fi

echo "⚠️  Questo SOVRASCRIVE il database corrente con: $FILE"
read -p "Confermi? (scrivi 'si'): " CONFIRM
[[ "$CONFIRM" == "si" ]] || { echo "Annullato."; exit 1; }

gunzip -c "$FILE" | docker compose -f /opt/wattlab/docker-compose.yml exec -T postgres \
  psql -U wattlab -d wattlab

echo "✓ Ripristino completato."
