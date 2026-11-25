import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";
import { AuthService } from "./modules/auth/auth.service.js";
import { PrismaAuthRepository } from "./modules/auth/prisma-auth.repository.js";
import { SimpleWebAuthnDriver } from "./modules/auth/simplewebauthn.driver.js";
import { createAuthRouter } from "./modules/auth/auth.routes.js";
import { AccountsService } from "./modules/accounts/accounts.service.js";
import { createAccountsRouter } from "./modules/accounts/accounts.routes.js";
import { PrismaAccountsRepository } from "./modules/accounts/prisma-accounts.repository.js";
import { PeopleService } from "./modules/people/people.service.js";
import { PrismaPeopleRepository } from "./modules/people/prisma-people.repository.js";
import { createPeopleRouter } from "./modules/people/people.routes.js";
import { ExpensesService } from "./modules/expenses/expenses.service.js";
import { PrismaExpensesRepository } from "./modules/expenses/prisma-expenses.repository.js";
import { createExpensesRouter } from "./modules/expenses/expenses.routes.js";
import { LoansService } from "./modules/loans/loans.service.js";
import { PrismaLoansRepository } from "./modules/loans/prisma-loans.repository.js";
import { createLoansRouter } from "./modules/loans/loans.routes.js";

const authConfig = {
  rpId: env.WEBAUTHN_RP_ID,
  rpName: env.WEBAUTHN_RP_NAME,
  webOrigin: env.WEB_ORIGIN,
  setupToken: env.SETUP_TOKEN,
  challengeTtlSeconds: env.AUTH_CHALLENGE_TTL_SECONDS,
  sessionTtlHours: env.AUTH_SESSION_TTL_HOURS,
};
const authService = new AuthService(
  new PrismaAuthRepository(prisma),
  new SimpleWebAuthnDriver(authConfig),
  authConfig,
);
const accountsService = new AccountsService(new PrismaAccountsRepository(prisma));
const peopleService = new PeopleService(
  new PrismaPeopleRepository(prisma),
  accountsService,
);
const expensesService = new ExpensesService(
  new PrismaExpensesRepository(prisma),
  accountsService,
);
const loansService = new LoansService(new PrismaLoansRepository(prisma));

const app = createApp(
  async () => {
    await prisma.$queryRaw`SELECT 1`;
  },
  createAuthRouter(authService, authConfig, env.NODE_ENV === "production"),
  createAccountsRouter(
    accountsService,
    authService,
    authConfig,
    env.NODE_ENV === "production",
  ),
  createPeopleRouter(
    peopleService,
    authService,
    authConfig,
    env.NODE_ENV === "production",
  ),
  createExpensesRouter(
    expensesService,
    authService,
    authConfig,
    env.NODE_ENV === "production",
  ),
  createLoansRouter(loansService, authService, authConfig, env.NODE_ENV === "production"),
);

const server = app.listen(env.API_PORT, env.API_HOST, () => {
  logger.info({ host: env.API_HOST, port: env.API_PORT }, "API listening");
});

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, "Shutting down API");
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
