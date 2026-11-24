import type { RequestHandler } from "express";
import type { ZodType } from "zod";

export const validateBody =
  (schema: ZodType): RequestHandler =>
  (request, _response, next) => {
    const parsedBody = schema.safeParse(request.body);
    if (!parsedBody.success) {
      next(parsedBody.error);
      return;
    }

    request.body = parsedBody.data;
    next();
  };
