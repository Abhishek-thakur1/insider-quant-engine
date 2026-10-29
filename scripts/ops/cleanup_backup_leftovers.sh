#!/usr/bin/env bash
# ============================================================
# scripts/ops/cleanup_backup_leftovers.sh — remove the EMPTY directories the old 16:00 backup left
# in the host's /tmp (one per backup day, 23 by 28 Oct: /tmp/paper_trades_YYYYMMDD_160000.sql/, created by Docker when
# the old script bind-mounted a path that only existed inside the scheduler container).
#
# Run on the EC2 host, outside market hours, only with the owner's OK. Default is a dry run that
# LISTS the exact paths. With --apply it runs `rmdir` on exactly those paths: rmdir refuses anything
# that isn't an empty directory, so a real file or a non-empty directory can never be removed.
#   scripts/ops/cleanup_backup_leftovers.sh            # list only
#   scripts/ops/cleanup_backup_leftovers.sh --apply    # remove the listed empty directories
# ============================================================
set -u
mapfile -t DIRS < <(find /tmp -maxdepth 1 -type d -empty -regextype posix-extended \
  -regex '/tmp/paper_trades_[0-9]{8}_[0-9]{6}\.sql' | sort)

echo "Empty backup leftover directories in /tmp: ${#DIRS[@]}"
printf '  %s\n' "${DIRS[@]}"

if [ "${1:-}" != "--apply" ]; then
  echo "Dry run: nothing removed. Re-run with --apply to rmdir exactly the paths above."
  exit 0
fi

removed=0
for d in "${DIRS[@]}"; do
  if sudo rmdir -- "$d"; then removed=$((removed + 1)); else echo "  kept (not removable as an empty dir): $d"; fi
done
echo "Removed ${removed} of ${#DIRS[@]}."
