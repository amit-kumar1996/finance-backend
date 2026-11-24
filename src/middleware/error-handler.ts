import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { logger } from "../lib/logger.js";
import { HttpError } from "../lib/http-error.js";

export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  request,
  response,
  _next,
) => {
  if (error instanceof ZodError) {
    response.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "The request did not match the expected format.",
        details: error.issues.map(({ path, message }) => ({ path, message })),
      },
    });
    return;
  }

  if (error instanceof HttpError) {
    response.status(error.status).json({
      error: { code: error.code, message: error.message },
    });
    return;
  }

  logger.error(
    {
      errorType: error instanceof Error ? error.name : "UnknownError",
      requestId: request.id,
    },
    "Unhandled request error",
  );
  response.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred.",
      requestId: request.id,
    },
  });
};
