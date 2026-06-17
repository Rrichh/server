#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# Backup giornaliero del database Postgres.
# Installa nel crontab del VPS con:
#   crontab -e
#   0 3 * * * /opt/wattlab/scripts/backup.sh >> /opt/wattlab/backups/backup.log 2>&1
#
# Mantiene gli ultimi 14 backup, comprime con gzip.
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

BACKUP_DIR=/opt/wattlab/backups
STAMP=$(date +%Y%m%d_%H%M%S)
KEEP=14

mkdir -p "$BACKUP_DIR"

echo "[$(date -Is)] Backup start"
docker compose -f /opt/wattlab/docker-compose.yml exec -T postgres \
  pg_dump -U wattlab -d wattlab --no-owner --clean --if-exists \
  | gzip > "$BACKUP_DIR/wattlab_$STAMP.sql.gz"

SIZE=$(du -h "$BACKUP_DIR/wattlab_$STAMP.sql.gz" | cut -f1)
echo "[$(date -Is)] Backup ok: wattlab_$STAMP.sql.gz ($SIZE)"

# Pulizia: tieni solo gli ultimi $KEEP
ls -1t "$BACKUP_DIR"/wattlab_*.sql.gz 2>/dev/null | tail -n +$((KEEP+1)) | xargs -r rm -f
echo "[$(date -Is)] Cleanup done (kept last $KEEP)"
