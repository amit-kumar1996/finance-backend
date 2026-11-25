#!/usr/bin/env bash
set -euo pipefail

: "${MYSQL_CONTAINER:?Set MYSQL_CONTAINER to the MySQL container name}"
: "${MYSQL_DATABASE:?Set MYSQL_DATABASE to the application database}"
: "${MYSQL_USER:?Set MYSQL_USER}"
: "${MYSQL_PASSWORD:?Set MYSQL_PASSWORD}"
: "${AGE_RECIPIENT:?Set AGE_RECIPIENT to the age public recipient}"
: "${BACKUP_DIRECTORY:?Set BACKUP_DIRECTORY to a private directory}"
: "${RCLONE_REMOTE:?Set RCLONE_REMOTE, for example r2:pfm-backups}"
: "${BACKUP_RETENTION_DAYS:=35}"

command -v docker >/dev/null
command -v age >/dev/null
command -v rclone >/dev/null
install -d -m 700 "$BACKUP_DIRECTORY"
umask 077
id="$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
file="$BACKUP_DIRECTORY/$id.sql.age"
tmp="$file.tmp"
manifest="$BACKUP_DIRECTORY/$id.json"
manifest_tmp="$manifest.tmp"
trap 'rm -f "$tmp" "$manifest_tmp"' EXIT

docker exec -e MYSQL_PWD="$MYSQL_PASSWORD" "$MYSQL_CONTAINER" \
  mysqldump --user="$MYSQL_USER" --single-transaction --quick --skip-lock-tables \
    --routines --events --triggers --hex-blob --default-character-set=utf8mb4 "$MYSQL_DATABASE" \
  | age --encrypt --recipient "$AGE_RECIPIENT" --output "$tmp"
chmod 600 "$tmp"
mv "$tmp" "$file"
sha="$(sha256sum "$file" | cut -d ' ' -f1)"
size="$(stat -c '%s' "$file")"
created="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '{"id":"%s","createdAt":"%s","fileName":"%s.sql.age","sizeBytes":%s,"sha256":"%s","encryption":"age","offsite":"pending"}\n' \
  "$id" "$created" "$id" "$size" "$sha" > "$manifest_tmp"
chmod 600 "$manifest_tmp"
mv "$manifest_tmp" "$manifest"

# Copy only encrypted artifacts and their manifest. The VM copy remains usable if off-site sync fails.
if rclone copyto "$file" "$RCLONE_REMOTE/$id.sql.age" && rclone copyto "$manifest" "$RCLONE_REMOTE/$id.json"; then
  sed 's/"offsite":"pending"/"offsite":"copied"/' "$manifest" > "$manifest_tmp"
  chmod 600 "$manifest_tmp"
  mv "$manifest_tmp" "$manifest"
  rclone copyto "$manifest" "$RCLONE_REMOTE/$id.json"
else
  echo "Encrypted backup created locally, but off-site copy failed: $id" >&2
fi

find "$BACKUP_DIRECTORY" -type f \( -name '*.sql.age' -o -name '*.json' \) \
  -mtime "+$BACKUP_RETENTION_DAYS" -delete
rclone delete "$RCLONE_REMOTE" --min-age "${BACKUP_RETENTION_DAYS}d"
echo "Backup completed: $id ($size bytes; sha256 $sha)"
