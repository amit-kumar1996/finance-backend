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

## Investments and market data

The Investments page separates NPS, mutual funds, and stocks from FD, PPF, and EPF. Purchases and fixed-product contributions debit an investment asset and credit the selected bank, cash, or UPI asset. They are not expenses. Sells credit the investment asset, debit the receiving account, and recognize realized gain or loss; the market value reserve is reclassified when a position is sold. Market holdings use FIFO cost basis. Fixed-product balances use explicit dated valuations. All rupee postings use decimal amounts and are audited and idempotent.

Mutual fund NAV refresh downloads AMFI's published NAV text report and matches the investment's scheme code. AMFI describes daily NAV publication and provides latest and historical NAV downloads at [NAV Download](https://www.amfiindia.com/net-asset-value/nav-download) and [NAV History](https://www.amfiindia.com/net-asset-value/nav-history). The API records the NAV date/source, and displays stale data when the latest date is more than five days old. Failed downloads leave the last saved value intact and return an error.

NPS and stock prices currently require a dated manual quote. No exchange or NPS credentials are configured, and no prices are fabricated. `MarketDataAdapter` is the provider boundary; AMFI implements it. One stock-market provider option is Angel One [SmartAPI](https://smartapi.angelbroking.com/docs), which documents quote endpoints and requires an API key and an authenticated Angel One account. A future adapter would also need provider-specific symbol/token mapping and must comply with the account's market-data terms. Keep any API keys on the backend VM, never in the web build. NPS holdings remain manual unless the account's record keeper offers an authorized data feed.

Use the page's **Refresh AMFI NAV** button to update mutual funds. For stocks or NPS, use **Record → Manual unit price** and enter the quote date. For FD, PPF, and EPF, record dated contributions/withdrawals and use **Manual total valuation** when their current value changes. New mutual fund records require the AMFI scheme code; new stock records require the market symbol. The routes are under `/api/v1/investments`; local development applies the investment migration through `npm.cmd run dev` or `npm.cmd run db:deploy`.

Run `npm.cmd run lint`, `npm.cmd run type-check`, and `npm.cmd test` for the API checks. `npm.cmd run build` compiles the production server.

The Compose credentials are local development values only. Production credentials belong in the VM's environment and must not be copied into this repository.

## Production deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) for Oracle VM and Cloudflare deployment, TLS/Nginx, private Docker networking to the existing MySQL container, restricted GitHub Actions rollout, health checks, rollback, firewall and smoke tests. It intentionally does not create or replace a database container.

For encrypted database backup configuration and scratch restore instructions, see [ops/backup/README.md](ops/backup/README.md). The production API container has no Docker socket; perform restore tests with the protected VM-side restore script.
