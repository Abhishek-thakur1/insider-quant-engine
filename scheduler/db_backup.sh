#!/bin/sh
set -e

echo "[DB Backup] Starting Postgres dump at $(date)"

# Use docker exec to run pg_dump inside the postgres container
# The postgres container is on the same host, and scheduler mounts docker.sock
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
FILENAME="paper_trades_${TIMESTAMP}.sql"
FILEPATH="/tmp/${FILENAME}"

# Dump the DB
docker exec quant_postgres pg_dump -U postgres -d insider_quant -F c -f "/tmp/${FILENAME}"
docker cp quant_postgres:"/tmp/${FILENAME}" "${FILEPATH}"

echo "[DB Backup] Dump completed. File: ${FILENAME}"

if [ -z "$S3_BACKUP_BUCKET" ]; then
    echo "[DB Backup] S3_BACKUP_BUCKET is not set. Skipping S3 upload."
else
    echo "[DB Backup] Uploading to s3://${S3_BACKUP_BUCKET}/db_backups/${FILENAME}..."
    # This assumes aws-cli is installed in the scheduler container, or we can use curl if it's signed.
    # Since AWS CLI might not be in the alpine container, a standard approach is to use the aws cli container.
    docker run --rm -v "${FILEPATH}:/tmp/${FILENAME}" amazon/aws-cli s3 cp "/tmp/${FILENAME}" "s3://${S3_BACKUP_BUCKET}/db_backups/${FILENAME}"
    echo "[DB Backup] Upload complete."
fi

# Cleanup
docker exec quant_postgres rm "/tmp/${FILENAME}"
rm "${FILEPATH}"

echo "[DB Backup] Finished."
