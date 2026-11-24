# Personal Finance Manager API

This folder is an independent npm project for the Express and Prisma API. Its local Compose file starts MySQL on loopback only (`127.0.0.1:3306`); it does not publish MySQL to the network.

## Local development

Install Docker Desktop and start its engine. From this directory, run `npm.cmd install` in PowerShell (or `npm install` in a shell that permits npm scripts). Copy `.env.example` to `.env`, then run `npm.cmd run dev`. This starts and waits for MySQL, generates the Prisma client, applies checked-in migrations, and starts the API at <http://127.0.0.1:3000>.

Check `http://127.0.0.1:3000/api/v1/health` for API and database readiness. Run `npm.cmd run db:migrate` to create a migration after changing the Prisma schema.

Run `npm.cmd run lint`, `npm.cmd run type-check`, and `npm.cmd test` for the API checks. `npm.cmd run build` compiles the production server.

The Compose credentials are local development values only. Production credentials belong in the VM's environment and must not be copied into this repository.
