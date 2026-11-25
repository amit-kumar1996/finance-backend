import express, { type Express } from "express";
import cors from "cors";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { env } from "./config/env.js";
import { errorHandler } from "./middleware/error-handler.js";
import { logger } from "./lib/logger.js";
import { createHealthRouter, type DatabaseCheck } from "./routes/health.js";
import type { Router } from "express";

export const createApp = (
  checkDatabase: DatabaseCheck,
  authRouter?: Router,
  accountsRouter?: Router,
  peopleRouter?: Router,
  expensesRouter?: Router,
  loansRouter?: Router,
  investmentsRouter?: Router,
): Express => {
  const app = express();

  app.disable("x-powered-by");
  if (env.NODE_ENV === "production") app.set("trust proxy", 1);
  app.use(helmet());
  app.use(cors({ origin: env.WEB_ORIGIN, credentials: true }));
  app.use(
    pinoHttp({
      logger,
      redact: {
        paths: [
          "req.headers.cookie",
          "req.headers.x-setup-token",
          "req.headers.x-csrf-token",
          "res.headers.set-cookie",
        ],
        censor: "[REDACTED]",
      },
    }),
  );
  app.use(express.json({ limit: "100kb" }));
  app.use(
    "/api/v1/auth",
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 10,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      handler: (_request, response) => {
        response.status(429).json({
          error: { code: "RATE_LIMITED", message: "Too many authentication requests." },
        });
      },
    }),
  );
  if (authRouter) app.use("/api/v1/auth", authRouter);
  if (accountsRouter) app.use("/api/v1", accountsRouter);
  if (peopleRouter) app.use("/api/v1", peopleRouter);
  if (expensesRouter) app.use("/api/v1", expensesRouter);
  if (loansRouter) app.use("/api/v1", loansRouter);
  if (investmentsRouter) app.use("/api/v1", investmentsRouter);
  app.use("/api/v1", createHealthRouter(checkDatabase));
  app.use((_request, response) => {
    response.status(404).json({
      error: { code: "NOT_FOUND", message: "The requested resource was not found." },
    });
  });
  app.use(errorHandler);

  return app;
};
