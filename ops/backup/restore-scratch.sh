#!/usr/bin/env bash
set -euo pipefail

artifact="${1:?Pass the encrypted backup artifact path}"
target="${2:?Pass a new pfm_restore_<id> database name}"
confirmation="${3:?Type RESTORE <backup-id> as the third argument}"
: "${MYSQL_CONTAINER:?Set MYSQL_CONTAINER}"
: "${MYSQL_USER:?Set MYSQL_USER}"
: "${MYSQL_PASSWORD:?Set MYSQL_PASSWORD}"
: "${AGE_IDENTITY_FILE:?Set AGE_IDENTITY_FILE to the protected age identity file}"

[[ "$target" =~ ^pfm_restore_[a-f0-9]{12}$ ]] || { echo 'Refusing database name outside pfm_restore_<12 hex chars>.' >&2; exit 2; }
[[ -f "$artifact" && "$artifact" == *.sql.age ]] || { echo 'Expected an encrypted .sql.age artifact.' >&2; exit 2; }
backup_id="$(basename "$artifact" .sql.age)"
[[ "$confirmation" == "RESTORE $backup_id" ]] || { echo "Type RESTORE $backup_id to confirm." >&2; exit 2; }
command -v age >/dev/null
command -v docker >/dev/null

export MYSQL_PWD="$MYSQL_PASSWORD"
exists="$(docker exec -e MYSQL_PWD "$MYSQL_CONTAINER" mysql --batch --skip-column-names --user="$MYSQL_USER" \
  --execute="SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name='$target'")"
[[ "$exists" == "0" ]] || { echo "Refusing restore: $target already exists; no database was changed." >&2; exit 3; }

docker exec -e MYSQL_PWD "$MYSQL_CONTAINER" mysql --user="$MYSQL_USER" \
  --execute="CREATE DATABASE \`$target\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
if ! age --decrypt --identity "$AGE_IDENTITY_FILE" "$artifact" \
  | docker exec -i -e MYSQL_PWD "$MYSQL_CONTAINER" mysql --user="$MYSQL_USER" "$target"; then
  echo "Restore import failed. The incomplete scratch database $target was left untouched for inspection; drop it manually only after review." >&2
  exit 4
fi
echo "Encrypted backup restored into new scratch database: $target"
