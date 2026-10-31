#!/bin/sh
# ============================================================
# scheduler/db_backup.sh — 16:00 IST Postgres dump, kept on the host and uploaded to S3.
#
# Fixed 2026-10-28. The old script ran `docker run -v /tmp/<dump>:…` from inside this container, so
# the bind-mount path was resolved on the HOST, where the file didn't exist. Docker created an
# empty directory there, `aws s3 cp` failed on it ("Need to rewind the stream"), and `set -e`
# skipped the cleanup: 23 empty host directories (by 28 Oct) and dumps piling up in the containers.
#
# Now:
#   - the dump goes straight to BACKUP_DIR, a host folder bind-mounted at the SAME path in this
#     container (docker-compose.yml), so `docker run -v $BACKUP_DIR:…` sees the real file;
#   - the upload names its region; a failure sends a Telegram admin alert and does NOT skip the
#     rest (the local copy and the retention cleanup still run);
#   - the last KEEP dumps stay on the host.
# The S3 upload needs the IAM policy on the instance role (owner applies it; see the PR).
# ============================================================

umask 077 # dumps readable by root only (review of 28 Oct)
BACKUP_DIR="${BACKUP_DIR:-/var/backups/iqe}"
KEEP="${BACKUP_KEEP:-14}"
REGION="${AWS_REGION:-ap-south-1}"
AWS_CLI_IMAGE="${AWS_CLI_IMAGE:-amazon/aws-cli:2.36.42}" # pinned: the image already on the host, tagged at deploy (no pull)

log() { echo "[DB Backup] $*"; }

alert() {
    log "⚠️ $1"
    if [ -z "$TELEGRAM_BOT_TOKEN" ] || [ -z "$TELEGRAM_ADMIN_ID" ]; then
        log "⚠️ Missing Telegram environment variables. Cannot send alert."
        return
    fi
    curl -s --max-time 20 -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
        -d chat_id="${TELEGRAM_ADMIN_ID}" \
        --data-urlencode text="⚠️ DB backup: $1" > /dev/null || log "⚠️ Telegram alert failed too"
}

log "Starting Postgres dump at $(date)"
mkdir -p "$BACKUP_DIR" || { alert "cannot create $BACKUP_DIR — no backup today"; exit 1; }

TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
FILENAME="paper_trades_${TIMESTAMP}.sql"
FILEPATH="${BACKUP_DIR}/${FILENAME}"

# 1. Dump straight to the host folder: no temp file inside quant_postgres or this container.
if ! docker exec quant_postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -F c' > "$FILEPATH"; then
    rm -f "$FILEPATH"
    alert "pg_dump failed — no backup today"
    exit 1
fi
SIZE=$(wc -c < "$FILEPATH")
TABLES=$(docker exec -i quant_postgres pg_restore -l < "$FILEPATH" 2>/dev/null | grep -c "TABLE DATA")
if [ "${SIZE:-0}" -le 0 ] || [ "${TABLES:-0}" -lt 3 ]; then
    # A bad dump is renamed out of the retention pattern and NOT uploaded, so it can never push a
    # good dump out of the KEEP newest (review of 28 Oct).
    mv -f "$FILEPATH" "${FILEPATH}.bad" 2>/dev/null
    alert "dump ${FILENAME} looks wrong (${SIZE} bytes, ${TABLES} TABLE DATA) — kept as ${FILENAME}.bad, not uploaded"
    exit 1
fi
log "Dump completed. File: ${FILEPATH} (${SIZE} bytes, ${TABLES} TABLE DATA)"

# 2. Upload. A failure alerts and carries on: the local copy is still the backup of record.
if [ -z "$S3_BACKUP_BUCKET" ]; then
    log "S3_BACKUP_BUCKET is not set. Skipping S3 upload."
else
    log "Uploading to s3://${S3_BACKUP_BUCKET}/db_backups/${FILENAME} (region ${REGION})..."
    if OUT=$(docker run --rm -v "${BACKUP_DIR}:/backups:ro" "$AWS_CLI_IMAGE" \
            s3 cp "/backups/${FILENAME}" "s3://${S3_BACKUP_BUCKET}/db_backups/${FILENAME}" \
            --region "$REGION" --only-show-errors 2>&1); then
        log "Upload complete."
    else
        alert "S3 upload failed for ${FILENAME}: $(echo "$OUT" | tail -1 | cut -c1-300). The local copy is kept in ${BACKUP_DIR}."
    fi
fi

# 3. Retention: keep the newest KEEP dumps written by this script (exact name pattern only).
# -d: a directory matching the glob is listed as itself, never expanded; only regular files are removed.
ls -1td "$BACKUP_DIR"/paper_trades_*.sql 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
    [ -f "$old" ] || continue
    rm -f -- "$old" && log "Removed old dump $(basename "$old")"
done

log "Finished."
