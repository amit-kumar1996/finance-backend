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
  createLoanSchema,
  loanPaymentSchema,
  loanPrepaymentSchema,
} from "./loans.schemas.js";
import type { LoansService } from "./loans.service.js";

const readIdempotencyKey = (value: string | undefined): string => {
  if (!value || value.length > 128 || !/^[\w.:~-]+$/.test(value))
    throw new HttpError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "Send a valid Idempotency-Key header.",
    );
  return value;
};

export const createLoansRouter = (
  service: LoansService,
  auth: AuthService,
  config: AuthConfig,
  production: boolean,
) => {
  const router = Router();
  const authenticated = requireAuth(auth, production);
  const csrf = requireCsrf(auth);
  const sameOrigin = requireSameOrigin(config.webOrigin);

  router.get("/loans", authenticated, requireFullSession, async (request, response) => {
    const loans = await service.list(request.auth!.session.userId);
    response.json({ data: { loans } });
  });
  router.post(
    "/loans",
    sameOrigin,
    authenticated,
    requireFullSession,
    csrf,
    validateBody(createLoanSchema),
    async (request, response) => {
      const loan = await service.create(
        request.auth!.session.userId,
        readIdempotencyKey(request.header("idempotency-key")),
        request.body,
      );
      response.status(201).json({ data: { loan } });
    },
  );
  router.post(
    "/loans/:loanId/payments",
    sameOrigin,
    authenticated,
    requireFullSession,
    csrf,
    validateBody(loanPaymentSchema),
    async (request, response) => {
      await service.payment(
        request.auth!.session.userId,
        String(request.params.loanId),
        readIdempotencyKey(request.header("idempotency-key")),
        request.body,
      );
      response.status(201).json({ data: { posted: true } });
    },
  );
  router.post(
    "/loans/:loanId/prepayments",
    sameOrigin,
    authenticated,
    requireFullSession,
    csrf,
    validateBody(loanPrepaymentSchema),
    async (request, response) => {
      await service.prepayment(
        request.auth!.session.userId,
        String(request.params.loanId),
        readIdempotencyKey(request.header("idempotency-key")),
        request.body,
      );
      response.status(201).json({ data: { posted: true } });
    },
  );
  return router;
};
