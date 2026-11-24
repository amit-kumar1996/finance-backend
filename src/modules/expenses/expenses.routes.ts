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
import {
  expenseFormSchema,
  expenseQuerySchema,
  expenseSummaryQuerySchema,
} from "./expenses.schemas.js";
import type { ExpensesService } from "./expenses.service.js";

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

export const createExpensesRouter = (
  service: ExpensesService,
  auth: AuthService,
  config: AuthConfig,
  production: boolean,
) => {
  const router = Router();
  const authenticated = requireAuth(auth, production);
  const csrf = requireCsrf(auth);
  const sameOrigin = requireSameOrigin(config.webOrigin);

  router.get(
    "/expenses",
    authenticated,
    requireFullSession,
    async (request, response) => {
      const filters = expenseQuerySchema.parse(request.query);
      const expenses = await service.listExpenses(request.auth!.session.userId, {
        ...(filters.search ? { search: filters.search } : {}),
        ...(filters.from ? { from: filters.from } : {}),
        ...(filters.to ? { to: filters.to } : {}),
        ...(filters.month ? { month: filters.month } : {}),
      });
      response.json({ data: { expenses } });
    },
  );

  router.get(
    "/expenses/summary",
    authenticated,
    requireFullSession,
    async (request, response) => {
      const { date } = expenseSummaryQuerySchema.parse(request.query);
      const summary = await service.getSummary(request.auth!.session.userId, date);
      response.json({ data: { summary } });
    },
  );

  router.post(
    "/expenses",
    sameOrigin,
    authenticated,
    requireFullSession,
    csrf,
    validateBody(expenseFormSchema),
    async (request, response) => {
      const result = await service.createExpense(
        request.auth!.session.userId,
        readIdempotencyKey(request.header("idempotency-key")),
        request.body,
      );
      response.status(201).json({ data: result });
    },
  );

  router.patch(
    "/expenses/:expenseId",
    sameOrigin,
    authenticated,
    requireFullSession,
    csrf,
    validateBody(expenseFormSchema),
    async (request, response) => {
      const expenseId = request.params.expenseId;
      const result = await service.editExpense(
        request.auth!.session.userId,
        readIdempotencyKey(request.header("idempotency-key")),
        typeof expenseId === "string" ? expenseId : "",
        request.body,
      );
      response.json({ data: result });
    },
  );

  router.delete(
    "/expenses/:expenseId",
    sameOrigin,
    authenticated,
    requireFullSession,
    csrf,
    async (request, response) => {
      const expenseId = request.params.expenseId;
      const result = await service.deleteExpense(
        request.auth!.session.userId,
        readIdempotencyKey(request.header("idempotency-key")),
        typeof expenseId === "string" ? expenseId : "",
      );
      response.json({ data: result });
    },
  );

  return router;
};
