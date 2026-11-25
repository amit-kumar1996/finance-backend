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
  contributionSchema,
  createInvestmentSchema,
  investmentQuerySchema,
  manualPriceSchema,
  manualValuationSchema,
  tradeSchema,
} from "./investments.schemas.js";
import type { InvestmentsService } from "./investments.service.js";

const readIdempotencyKey = (value: string | undefined): string => {
  if (!value || value.length > 128 || !/^[\w.:~-]+$/.test(value))
    throw new HttpError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "Send a valid Idempotency-Key header.",
    );
  return value;
};

export const createInvestmentsRouter = (
  service: InvestmentsService,
  auth: AuthService,
  config: AuthConfig,
  production: boolean,
) => {
  const router = Router();
  const authenticated = requireAuth(auth, production);
  const fullSession = requireFullSession;
  const csrf = requireCsrf(auth);
  const sameOrigin = requireSameOrigin(config.webOrigin);

  router.get("/investments", authenticated, fullSession, async (request, response) => {
    const { type } = investmentQuerySchema.parse(request.query);
    response.json({
      data: { investments: await service.list(request.auth!.session.userId, type) },
    });
  });

  router.post(
    "/investments/market-data/amfi/sync",
    sameOrigin,
    authenticated,
    fullSession,
    csrf,
    async (request, response) => {
      response.json({ data: await service.syncAmfi(request.auth!.session.userId) });
    },
  );

  router.post(
    "/investments",
    sameOrigin,
    authenticated,
    fullSession,
    csrf,
    validateBody(createInvestmentSchema),
    async (request, response) => {
      const investmentId = await service.create(
        request.auth!.session.userId,
        readIdempotencyKey(request.header("idempotency-key")),
        request.body,
      );
      response.status(201).json({ data: { investmentId } });
    },
  );

  router.post(
    "/investments/:investmentId/buys",
    sameOrigin,
    authenticated,
    fullSession,
    csrf,
    validateBody(tradeSchema),
    async (request, response) => {
      await service.trade(
        request.auth!.session.userId,
        String(request.params.investmentId),
        readIdempotencyKey(request.header("idempotency-key")),
        "BUY",
        request.body,
      );
      response.status(201).json({ data: { posted: true } });
    },
  );
  router.post(
    "/investments/:investmentId/sells",
    sameOrigin,
    authenticated,
    fullSession,
    csrf,
    validateBody(tradeSchema),
    async (request, response) => {
      await service.trade(
        request.auth!.session.userId,
        String(request.params.investmentId),
        readIdempotencyKey(request.header("idempotency-key")),
        "SELL",
        request.body,
      );
      response.status(201).json({ data: { posted: true } });
    },
  );
  router.post(
    "/investments/:investmentId/contributions",
    sameOrigin,
    authenticated,
    fullSession,
    csrf,
    validateBody(contributionSchema),
    async (request, response) => {
      await service.cashActivity(
        request.auth!.session.userId,
        String(request.params.investmentId),
        readIdempotencyKey(request.header("idempotency-key")),
        "CONTRIBUTION",
        request.body,
      );
      response.status(201).json({ data: { posted: true } });
    },
  );
  router.post(
    "/investments/:investmentId/withdrawals",
    sameOrigin,
    authenticated,
    fullSession,
    csrf,
    validateBody(contributionSchema),
    async (request, response) => {
      await service.cashActivity(
        request.auth!.session.userId,
        String(request.params.investmentId),
        readIdempotencyKey(request.header("idempotency-key")),
        "WITHDRAWAL",
        request.body,
      );
      response.status(201).json({ data: { posted: true } });
    },
  );
  router.put(
    "/investments/:investmentId/price",
    sameOrigin,
    authenticated,
    fullSession,
    csrf,
    validateBody(manualPriceSchema),
    async (request, response) => {
      await service.updatePrice(
        request.auth!.session.userId,
        String(request.params.investmentId),
        readIdempotencyKey(request.header("idempotency-key")),
        { ...request.body, source: "MANUAL" },
      );
      response.json({ data: { updated: true } });
    },
  );
  router.put(
    "/investments/:investmentId/valuation",
    sameOrigin,
    authenticated,
    fullSession,
    csrf,
    validateBody(manualValuationSchema),
    async (request, response) => {
      await service.updateValuation(
        request.auth!.session.userId,
        String(request.params.investmentId),
        readIdempotencyKey(request.header("idempotency-key")),
        request.body,
      );
      response.json({ data: { updated: true } });
    },
  );

  return router;
};
