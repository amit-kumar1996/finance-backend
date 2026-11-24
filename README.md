# Personal Finance Manager API

This folder is an independent npm project for the Express and Prisma API. Its local Compose file starts MySQL on loopback only (`127.0.0.1:3307` on Windows, forwarded to container port `3306`); it does not publish MySQL to the network.

## Local development

Install Docker Desktop and start its engine. From this directory, run `npm.cmd install` in PowerShell (or `npm install` in a shell that permits npm scripts). Copy `.env.example` to `.env`, then run `npm.cmd run dev`. This starts and waits for MySQL, generates the Prisma client, applies checked-in migrations, and starts the API at <http://127.0.0.1:3000>.

Check `http://127.0.0.1:3000/api/v1/health` for API and database readiness. Run `npm.cmd run db:migrate` to create a migration after changing the Prisma schema.

## Passkey sign-in

For local WebAuthn, use `http://localhost:5173` in the browser (not the numeric loopback IP). `localhost` is allowed for WebAuthn without HTTPS. The API's `.env` must use `WEB_ORIGIN=http://localhost:5173` and `WEBAUTHN_RP_ID=localhost`; the RP ID must match the host portion of the page URL. In production, set `WEB_ORIGIN` to the exact HTTPS frontend origin and `WEBAUTHN_RP_ID` to the parent domain shared by the app and API, such as `example.com`.

Generate a strong one-time setup token locally with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`, put it in the backend `.env` as `SETUP_TOKEN`, and enter it on the first setup screen. Do not commit the `.env` file or share the token. First registration closes as soon as the first user and passkey are created.

The first registration displays ten recovery codes once. Save them privately. Each code can be used once to invalidate existing passkeys and sessions; the recovery flow then requires registering a replacement passkey before the app can be used again. The API stores only hashes of recovery codes and session tokens. Production cookies are `HttpOnly`, `Secure`, and `SameSite=Lax`; local HTTP uses the `localhost` exception and omits `Secure`.

The server uses the configured exact frontend origin for CORS and WebAuthn origin checks. State-changing API calls also require that origin and a CSRF token. A request from a page served at `127.0.0.1` will not match the default `localhost` origin settings.

Run `npm.cmd run lint`, `npm.cmd run type-check`, and `npm.cmd test` for the API checks. `npm.cmd run build` compiles the production server.

The Compose credentials are local development values only. Production credentials belong in the VM's environment and must not be copied into this repository.
