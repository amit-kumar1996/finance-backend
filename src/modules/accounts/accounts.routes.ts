import { Router } from "express";
import { HttpError } from "../../lib/http-error.js";
import { validateBody } from "../../middleware/validate.js";
import type { AuthConfig } from "../auth/auth.types.js";
import type { AuthService } from "../auth/auth.service.js";
import {
  requireAuth,
  requireCsrf,
  requireFullSession,
  requireSameOrigin,
} from "../auth/auth.middleware.js";
import type { AccountsService } from "./accounts.service.js";
import {
  cardPaymentSchema,
  cardPurchaseSchema,
  createAccountSchema,
  defaultExpenseAccountSchema,
  expenseSchema,
  reversalSchema,
  transferSchema,
} from "./accounts.schemas.js";

const readIdempotencyKey = (value: string | undefined): string => {
  if (!value || value.length > 128 || !/^[\w.:~-]+$/.test(value)) {
    throw new HttpError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "Send a valid Idempotency-Key header.",
    );
  }
  return value;
};

export const createAccountsRouter = (
  service: AccountsService,
  auth: AuthService,
  config: AuthConfig,
  production: boolean,
) => {
  const router = Router();
  const authenticated = requireAuth(auth, production);
  const fullSession = requireFullSession;
  const csrf = requireCsrf(auth);
  const sameOrigin = requireSameOrigin(config.webOrigin);

  router.get("/accounts", authenticated, fullSession, async (request, response) => {
    const accounts = await service.listAccounts(request.auth!.session.userId);
    response.json({ data: { accounts } });
  });

  router.get(
    "/preferences/default-expense-account",
    authenticated,
    fullSession,
    async (request, response) => {
      const account = await service.getDefaultExpenseAccount(
        request.auth!.session.userId,
      );
      response.json({ data: { account } });
    },
  );

  router.put(
    "/preferences/default-expense-account",
    sameOrigin,
    authenticated,
    fullSession,
    csrf,
    validateBody(defaultExpenseAccountSchema),
    async (request, response) => {
      const account = await service.setDefaultExpenseAccount(
        request.auth!.session.userId,
        readIdempotencyKey(request.header("idempotency-key")),
        request.body.accountId,
      );
      response.json({ data: { account } });
    },
  );

  router.post(
    "/accounts",
    sameOrigin,
    authenticated,
    fullSession,
    csrf,
    validateBody(createAccountSchema),
    async (request, response) => {
      const account = await service.createAccount(
        request.auth!.session.userId,
        readIdempotencyKey(request.header("idempotency-key")),
        request.body,
      );
      response.status(201).json({ data: { account } });
    },
  );

  router.post(
    "/transfers",
    sameOrigin,
    authenticated,
    fullSession,
    csrf,
    validateBody(transferSchema),
    async (request, response) => {
      const transaction = await service.transfer(
        request.auth!.session.userId,
        readIdempotencyKey(request.header("idempotency-key")),
        request.body,
      );
      response.status(201).json({ data: { transaction } });
    },
  );

  router.post(
    "/ledger/expenses",
    sameOrigin,
    authenticated,
    fullSession,
    csrf,
    validateBody(expenseSchema),
    async (request, response) => {
      const transaction = await service.expense(
        request.auth!.session.userId,
        readIdempotencyKey(request.header("idempotency-key")),
        request.body,
      );
      response.status(201).json({ data: { transaction } });
    },
  );

  router.post(
    "/ledger/credit-card-purchases",
    sameOrigin,
    authenticated,
    fullSession,
    csrf,
    validateBody(cardPurchaseSchema),
    async (request, response) => {
      const transaction = await service.cardPurchase(
        request.auth!.session.userId,
        readIdempotencyKey(request.header("idempotency-key")),
        request.body,
      );
      response.status(201).json({ data: { transaction } });
    },
  );

  router.post(
    "/ledger/credit-card-payments",
    sameOrigin,
    authenticated,
    fullSession,
    csrf,
    validateBody(cardPaymentSchema),
    async (request, response) => {
      const transaction = await service.cardPayment(
        request.auth!.session.userId,
        readIdempotencyKey(request.header("idempotency-key")),
        request.body,
      );
      response.status(201).json({ data: { transaction } });
    },
  );

  router.post(
    "/ledger/transactions/:transactionId/reversals",
    sameOrigin,
    authenticated,
    fullSession,
    csrf,
    validateBody(reversalSchema),
    async (request, response) => {
      const transactionId = request.params.transactionId;
      const transaction = await service.reverse(
        request.auth!.session.userId,
        readIdempotencyKey(request.header("idempotency-key")),
        typeof transactionId === "string" ? transactionId : "",
        request.body,
      );
      response.status(201).json({ data: { transaction } });
    },
  );

  return router;
};
