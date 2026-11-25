# Encrypted database backups (Oracle VM)

This job is intentionally separate from the Windows local-development Compose stack. Install `age`, `rclone`, and Docker on the VM. The backup job runs on the VM host and uses `docker exec` to reach the existing MySQL container. Keep the age **identity** and rclone credentials readable only by the backup operator. Never put either secret in git or in chat.

## VM environment

Create a root-owned environment file (mode `0600`) with:

```sh
MYSQL_CONTAINER=your_mysql_container_name
MYSQL_DATABASE=personal_finance
MYSQL_USER=pfm
MYSQL_PASSWORD=your_database_password
MYSQL_RESTORE_USER=pfm_restore_admin
MYSQL_RESTORE_PASSWORD=your_restore_admin_password
AGE_RECIPIENT=age1...public_recipient...
AGE_IDENTITY_FILE=/etc/pfm/backup-identity.txt
BACKUP_DIRECTORY=/var/lib/pfm/backups
BACKUP_GROUP=pfm-backup
BACKUP_RETENTION_DAYS=35
RCLONE_REMOTE=r2:pfm-backups
```

`AGE_RECIPIENT` is public and can encrypt backups. The corresponding age identity is private and only needed to decrypt. Configure `rclone` for an S3-compatible Oracle Object Storage bucket or Cloudflare R2 using credentials stored in its protected config, not in this repository. Restrict the bucket to this app and enable provider-side encryption/versioning where available. The script uploads only `.age` files and their small JSON manifests.

Copy `backup.sh` to `/usr/local/sbin/pfm-backup` and `restore-scratch.sh` to `/usr/local/sbin/pfm-restore-scratch`, then make both executable. Configure the protected variables for their service environment. Run the backup once manually and confirm it prints `Backup completed`, then set a daily 02:15 Asia/Kolkata systemd timer or cron entry. Example cron line after securely configuring the environment file:

```cron
CRON_TZ=Asia/Kolkata
15 2 * * * root set -a; . /etc/pfm/backup.env; set +a; /usr/local/sbin/pfm-backup >> /var/log/pfm-backup.log 2>&1
```

The script streams `mysqldump` directly into age encryption, writes the encrypted result atomically with mode `0640`, records its SHA-256, copies it off-host, and prunes local and remote files older than the retention. If the upload fails, the local encrypted artifact remains and the manifest says `pending`; inspect the job log and retry after fixing storage access.

The API container reads these files through the read-only volume at `/var/lib/pfm/backups`. Check that GID 2000 is unused with `getent group 2000`; if free, create the dedicated group and directory:

```sh
sudo groupadd --system --gid 2000 pfm-backup
sudo install -d -o root -g pfm-backup -m 2750 /var/lib/pfm/backups
```

Compose adds GID 2000 as a supplementary API group. Backup artifacts and manifests are group-readable but encrypted artifacts contain no plaintext. The age identity remains root-only and outside the shared directory. If GID 2000 is already assigned, choose a free GID and update `group_add` in `compose.production.yml` to match before deploying.

## API and app configuration

Settings lists backups, verifies ciphertext hashes and downloads encrypted `.age` files. The production API container intentionally has no Docker socket, so its in-app restore action stays disabled. This avoids giving the internet-facing API control over the VM's Docker daemon. Run the scratch restore from a protected VM shell instead; it invokes Docker locally and uses the root-only age identity. Do not expose the Docker socket or backup directory to the public network.

Settings can verify that the encrypted artifact's SHA-256 matches its manifest. That detects missing or altered files. A restore test goes further: age authenticates/decrypts the file and MySQL imports it into a newly created database named `pfm_restore_<id>`. The restore script rejects every other database name and refuses an existing target. It never drops or overwrites a database. To inspect a restored scratch database, connect locally with a MySQL client. Removing it later is a separate manual destructive action and should happen only after review.

## Manual restore from an off-site copy

Download both the `.sql.age` artifact and matching `.json` manifest from the configured storage. Verify the SHA-256 against the manifest, then restore with the protected VM environment loaded:

```sh
sha256sum -c <(printf '%s  %s\n' '<manifest sha256>' '<backup-id>.sql.age')
/usr/local/sbin/pfm-restore-scratch '<backup-id>.sql.age' 'pfm_restore_<12 lowercase hex chars>' 'RESTORE <backup-id>'
```

The web restore action enforces the same typed confirmation (`RESTORE <backup-id>`) and uses a unique scratch name. This is not a live-database replacement procedure. A live recovery must be planned separately, after a scratch restore has been inspected and the app is stopped.
