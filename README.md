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

## Formal loans and EMI

The Loans & EMI page supports a new disbursement into a bank, cash, or UPI account, or recording an already-existing outstanding loan. A disbursement debits the receiving asset and credits a loan liability; an existing loan is offset against opening-balance equity and does not change a cash account. The reducing-balance schedule uses the entered annual rate divided by 12 and rounds each period's interest to paise.

When recording an EMI, enter its total along with the principal and interest portions. The API requires the total to equal those parts. Principal debits the loan liability, interest debits general expenses, and the selected account is credited for the amount paid. A principal prepayment debits the liability and credits the selected account. Every posting is atomic, audited, and idempotent. Partial payments can be recorded without marking the scheduled installment complete; mark it complete when the remaining payment finishes that installment. The page recalculates future dates and balances from the ledger and shows overdue dates as due reminders.

The API routes are `GET/POST /api/v1/loans`, `POST /api/v1/loans/:loanId/payments`, and `POST /api/v1/loans/:loanId/prepayments`. Local development applies the loan migration through `npm.cmd run dev` or `npm.cmd run db:deploy`.

Run `npm.cmd run lint`, `npm.cmd run type-check`, and `npm.cmd test` for the API checks. `npm.cmd run build` compiles the production server.

The Compose credentials are local development values only. Production credentials belong in the VM's environment and must not be copied into this repository.
