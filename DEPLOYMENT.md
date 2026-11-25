# Production deployment

The frontend is a static Cloudflare Pages site. The API image runs on the existing Oracle Ubuntu VM behind the existing host Nginx. Production Compose deliberately does not create a second MySQL instance: it joins an external private Docker network and connects to the MySQL container already on the VM. It publishes only loopback port 3000. Do not replace the host Nginx configuration.

## Build the images locally

From the finance-backend directory:

```powershell
docker build --target runtime -t pfm-api:local .
docker build --target migrate -t pfm-api-migrate:local .
```

The runtime image contains production npm dependencies, compiled API code, and the generated Prisma client. The separate migration image retains Prisma CLI and migrations. The Docker ignore file excludes local environment files, dependencies, generated output and backup data.

## Inspect the VM first

Check the existing database before deployment. Do not start a new database volume or run migrations until you have confirmed the existing MySQL container contains the finance data and a current backup exists.

```sh
free -h
df -h
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
docker inspect --format '{{json .NetworkSettings.Networks}}' MYSQL_CONTAINER
docker port MYSQL_CONTAINER 3306
docker inspect --format '{{.State.Health.Status}}' MYSQL_CONTAINER
```

Replace MYSQL_CONTAINER with its actual name. Keep MySQL private and without a public port binding. If docker port shows 0.0.0.0 or [::], stop and correct the existing database deployment before proceeding.

The API memory limit is 320 MB; adjust it only after checking VM shape and current memory use. This Compose file does not manage MySQL memory settings. Do not expose the database on a public interface.

Set up the protected backup directory's shared read-only access. Compose uses supplemental group ID 2000 for the API process; verify the ID is unused before creating it:

```sh
getent group 2000
sudo groupadd --system --gid 2000 pfm-backup
sudo install -d -o root -g pfm-backup -m 2750 /var/lib/pfm/backups
```

If ID 2000 already exists, select an unused ID and change group_add in compose.production.yml to that ID. The backup job writes group-readable encrypted artifacts; the API only receives a read-only mount.

## Connect to the existing MySQL container

Identify the Docker bridge network used by the database. Create a private network only if one does not already exist, then attach the existing database with a stable name:

```sh
docker network ls
docker network create pfm-private
docker network connect --alias pfm-mysql pfm-private MYSQL_CONTAINER
docker network inspect pfm-private
```

Skip creation if pfm-private already exists. Inspect the network before attaching a container. Replace MYSQL_CONTAINER with the actual name. Set PFM_DOCKER_NETWORK=pfm-private and use pfm-mysql as the database hostname.

Use a dedicated MySQL application user, not root. Confirm it has the rights needed by the existing application and migrations. Set DATABASE_URL to mysql://USER:URL_ENCODED_PASSWORD@pfm-mysql:3306/personal_finance. Hex-generated passwords avoid URL escaping issues.

## Production environment file

Copy .env.production.example to .env.production on the VM. Replace every example value. Set the file owner to root and mode 0600. Never commit it. The API needs the exact frontend origin, parent-domain WebAuthn RP ID, database URL and one-time setup token. Remove SETUP_TOKEN from the server environment after first passkey registration.

Do not put database passwords, setup tokens, backup keys or storage credentials in GitHub Actions. They stay on the VM. Keep backup configuration in the protected environment used by the Phase 10 scripts.

## TLS and Nginx

This setup uses a Cloudflare Origin CA certificate with Cloudflare SSL mode Full (strict). It works for a proxied Cloudflare hostname and avoids a DNS API token on the VM. Browsers trust the certificate through Cloudflare; they do not trust it when connecting directly to the origin. Keep the API DNS record proxied. If direct origin browser access is needed, configure Let's Encrypt with automatic renewal instead.

In the Cloudflare dashboard, open SSL/TLS, then Origin Server, then Create Certificate. Include api.example.com (replace with the actual hostname). Save the certificate and private key outside the repository. From your workstation, transfer the certificate, private key and Nginx template to a temporary VM directory:

```powershell
scp ops/nginx/api.example.com.conf pfm-origin.crt pfm-origin.key ADMIN_USER@VM:/tmp/pfm-phase11/
```

On the VM, replace api.example.com in the temporary template with your real API hostname:

```sh
sudoedit /tmp/pfm-phase11/api.example.com.conf
```

After editing the template, install the certificate and separate Nginx server block:

```sh
sudo install -d -o root -g root -m 700 /etc/ssl/cloudflare
sudo install -o root -g root -m 644 /tmp/pfm-phase11/pfm-origin.crt /etc/ssl/cloudflare/pfm-origin.crt
sudo install -o root -g root -m 600 /tmp/pfm-phase11/pfm-origin.key /etc/ssl/cloudflare/pfm-origin.key
sudo install -o root -g root -m 644 /tmp/pfm-phase11/api.example.com.conf /etc/nginx/sites-available/pfm-api.conf
sudo ln -s /etc/nginx/sites-available/pfm-api.conf /etc/nginx/sites-enabled/pfm-api.conf
sudo nginx -t
```

Replace api.example.com in the config first. The symlink is a one-time command; check if it exists before repeating. nginx -t validates the full configuration without applying it. Only after it succeeds, reload Nginx:

```sh
sudo systemctl reload nginx
```

The new block redirects HTTP to HTTPS and proxies to 127.0.0.1:3000. It does not replace or edit any other Nginx site. Keep the private certificate key readable only by root.

## Oracle and Ubuntu firewalls

Opening public web ports exposes the Nginx host to internet traffic. First inspect current rules so you do not replace them:

```sh
sudo ufw status verbose
sudo iptables -L INPUT -n --line-numbers
```

In the Oracle Cloud Console, add ingress TCP 80 and 443 to the VM's existing Network Security Group or subnet Security List. Keep SSH port 22 restricted to your admin IP.

If UFW is active, add only the web ports:

```sh
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw status numbered
```

If UFW is inactive and the current iptables policy blocks those ports, add rules without flushing existing chains:

```sh
sudo iptables -I INPUT 1 -p tcp --dport 80 -m conntrack --ctstate NEW -j ACCEPT
sudo iptables -I INPUT 1 -p tcp --dport 443 -m conntrack --ctstate NEW -j ACCEPT
sudo iptables -L INPUT -n --line-numbers
```

Direct iptables rules may not survive reboot. Use the VM's existing persistence method after reviewing it; do not replace firewall tooling blindly. Both Oracle cloud ingress and Ubuntu's host firewall must permit the traffic.

## Cloudflare DNS and Pages

In Cloudflare DNS, point api to the VM public IP with proxy enabled. Add app as a Pages custom domain and follow its DNS prompt for the pages.dev CNAME. Keep the app and API under the same parent domain. Set SSL/TLS mode to Full (strict) and enable Always Use HTTPS. Do not publish a MySQL DNS record.

The finance-ui repository includes public/_redirects for SPA routing and public/_headers for security headers. Replace api.example.com in _headers with the real API hostname before the production build. The CSP permits API connections only to that host and disallows inline scripts.

In the Cloudflare dashboard, open Workers & Pages, select the project, then Settings and Builds & deployments. Set:

| Setting             | Value                                       |
| ------------------- | ------------------------------------------- |
| Production branch   | main                                        |
| Root directory      | / (UI repository root)                      |
| Build command       | npm run build                               |
| Output directory    | dist                                        |
| Production variable | VITE_API_URL=https://api.example.com/api/v1 |

Replace the example API hostname. VITE_API_URL is embedded in the public bundle and must not contain secrets. GitHub Actions run UI CI on dev and main; the Pages Git connection publishes main. Preview Pages hostnames are not same-site with the API, so passkey login requires the custom app domain or a separately configured staging app/API.

## GitHub Actions deploy account

The backend workflow publishes multi-architecture API and migration images (AMD64 and ARM64) to GHCR on main, then connects to the VM over SSH. Add these repository Actions secrets:

| Secret                 | Value                                                             |
| ---------------------- | ----------------------------------------------------------------- |
| API_DEPLOY_HOST        | VM public IP or direct SSH hostname, not the proxied API hostname |
| API_DEPLOY_USER        | dedicated pfm-deploy account                                      |
| API_DEPLOY_SSH_KEY     | private key used only by the workflow                             |
| API_DEPLOY_KNOWN_HOSTS | verified SSH host-key line for the VM                             |

Collect the host-key line from your workstation, then compare its fingerprint with the value shown through a trusted Oracle console before saving it as the secret. Do not trust the scan alone or disable host-key checking:

```powershell
ssh-keyscan -H VM_PUBLIC_IP > pfm-known-hosts
ssh-keygen -lf pfm-known-hosts
```

For the initial installation, copy the production Compose file and deployment scripts to a temporary directory on the VM using your admin SSH account. From the checked-out finance-backend repo on your workstation:

```powershell
scp compose.production.yml .env.production.example ops/deploy/pfm-deploy ops/deploy/pfm-ssh-command ADMIN_USER@VM:/tmp/pfm-phase11/
```

Then on the VM, install root-owned copies and create the protected environment file:

```sh
sudo install -d -o root -g root -m 750 /opt/pfm/finance-backend
sudo install -o root -g root -m 644 /tmp/pfm-phase11/compose.production.yml /opt/pfm/finance-backend/compose.production.yml
sudo install -o root -g root -m 755 /tmp/pfm-phase11/pfm-deploy /usr/local/sbin/pfm-deploy
sudo install -o root -g root -m 755 /tmp/pfm-phase11/pfm-ssh-command /usr/local/sbin/pfm-ssh-command
sudo test ! -e /opt/pfm/finance-backend/.env.production
sudo install -o root -g root -m 600 /tmp/pfm-phase11/.env.production.example /opt/pfm/finance-backend/.env.production
sudoedit /opt/pfm/finance-backend/.env.production
```

The `test` command prevents overwriting an existing production environment file. If it reports that the file already exists, stop and edit the existing file intentionally instead of copying the example over it.

Replace owner, hostname, network, image, DB URL and token values in the protected file before deploying. Transfer the API TLS files and install the Nginx config separately as described above. Delete only the temporary copies after confirming the installed copies and config; do not delete application data.

The VM's root Docker client needs pull access to the private GHCR package. Create a GitHub token limited to read:packages, then log in without putting the token in shell history:

```sh
read -rsp 'GHCR read:packages token: ' GHCR_TOKEN; echo
printf '%s' "$GHCR_TOKEN" | sudo docker login ghcr.io --username YOUR_GITHUB_OWNER --password-stdin
unset GHCR_TOKEN
```

The deploy account must not receive this registry token.

Create a dedicated SSH key on your admin workstation. Keep the private file private and add its full contents to the GitHub secret, not to the repository:

```powershell
ssh-keygen -t ed25519 -C github-actions-pfm-deploy -f pfm-gha-deploy
```

On the VM, create the account and authorized-keys file, then append the public key using the forced-command options shown below:

```sh
sudo adduser --disabled-password --gecos '' pfm-deploy
sudo install -d -o pfm-deploy -g pfm-deploy -m 700 /home/pfm-deploy/.ssh
sudoedit /home/pfm-deploy/.ssh/authorized_keys
sudo chown pfm-deploy:pfm-deploy /home/pfm-deploy/.ssh/authorized_keys
sudo chmod 600 /home/pfm-deploy/.ssh/authorized_keys
```

The account must not be in the docker group. The deployment script must be root-owned at /usr/local/sbin/pfm-deploy and the forced-command wrapper root-owned at /usr/local/sbin/pfm-ssh-command; both should have mode 0755. Add the least-privilege sudo rule and validate it:

Create the sudoers file with this one command, then validate it:

```sh
echo 'pfm-deploy ALL=(root) NOPASSWD: /usr/local/sbin/pfm-deploy *' | sudo tee /etc/sudoers.d/pfm-deploy >/dev/null
sudo chown root:root /etc/sudoers.d/pfm-deploy
sudo chmod 440 /etc/sudoers.d/pfm-deploy
sudo visudo -cf /etc/sudoers.d/pfm-deploy
```

Force the deployment public key in the deploy user's authorized_keys:

```text
command="/usr/local/sbin/pfm-ssh-command",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty,no-user-rc ssh-ed25519 AAAA... github-actions-pfm
```

The forced-command wrapper accepts only deploy followed by a 40-character lowercase commit SHA. The root-owned script validates the SHA, runs migrations, deploys the image, checks API health, and restores the previous app image if health fails. The VM root Docker client needs a GHCR token with read:packages permission to pull the private package; do not give that token to the deploy user or Actions.

Install compose.production.yml and the checked-out deployment scripts in /opt/pfm/finance-backend. Keep the directory root-owned and .env.production root-owned mode 0600. Later changes to Compose, Nginx or deployment scripts require an intentional admin update on the VM; the workflow changes image versions only.

Migrations are forward-only. Keep them backward-compatible with the previous API image. App rollback does not undo a database migration. Take and verify a backup before a schema-changing release.

## Deploy and rollback

Merge a reviewed change to main to start the production workflow. It publishes both images, runs the Prisma migration image against the existing database, deploys the API, and waits for the health endpoint.

Manual deployment from the VM uses the same restricted script:

```sh
sudo /usr/local/sbin/pfm-deploy 40_CHARACTER_LOWERCASE_COMMIT_SHA
```

The last healthy image is recorded in /var/lib/pfm-deploy/last-known-good-image. To roll back, run the script with that release's commit SHA. It restores the app image and checks health again. Do not drop or restore the database as an application rollback step. A migration recovery requires the separately documented backup and scratch-restore procedure.

## Production smoke test

1. curl -i https://api.example.com/api/v1/health returns HTTP 200 with status ok and database ok.
2. Compose shows the API healthy. docker port MYSQL_CONTAINER 3306 shows no public binding.
3. https://app.example.com loads over HTTPS and a nested route reloads successfully.
4. Browser tools show requests only to the HTTPS API hostname with no CORS or CSP errors.
5. Complete first passkey setup once, save recovery codes privately, sign out and sign in again. Confirm the session cookie is Secure, HttpOnly and SameSite=Lax.
6. In Settings, confirm backup history, verify a backup hash, and download an encrypted .sql.age artifact. The production API container has no Docker socket, so its UI restore action remains disabled. Use the protected VM restore-scratch.sh procedure in ops/backup/README.md for restore testing.
7. Record a small test transaction, verify it appears once after refresh, then reverse it in the app. Do not use a real financial transaction for this smoke test.

Do not call deployment complete until these checks pass and a scratch restore has been inspected.
