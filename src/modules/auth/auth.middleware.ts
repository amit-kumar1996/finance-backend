import type { RequestHandler } from "express";
import { HttpError } from "../../lib/http-error.js";
import type { AuthService } from "./auth.service.js";

export const sessionCookieName = (production: boolean): string =>
  production ? "__Host-pfm_session" : "pfm_session";

export const readSessionCookie = (
  cookieHeader: string | undefined,
  production: boolean,
): string | undefined => {
  const cookieName = sessionCookieName(production);
  for (const part of cookieHeader?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === cookieName) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return undefined;
};

export const requireAuth =
  (auth: AuthService, production: boolean): RequestHandler =>
  async (request, _response, next) => {
    try {
      const rawSessionToken = readSessionCookie(request.headers.cookie, production);
      if (!rawSessionToken) {
        throw new HttpError(
          401,
          "UNAUTHENTICATED",
          "Sign in with a passkey to continue.",
        );
      }
      const session = await auth.loadSession(rawSessionToken);
      if (!session) {
        throw new HttpError(
          401,
          "UNAUTHENTICATED",
          "Your session has expired. Sign in again.",
        );
      }
      request.auth = { session, rawSessionToken };
      next();
    } catch (error) {
      next(error);
    }
  };

export const requireFullSession: RequestHandler = (request, _response, next) => {
  if (request.auth?.session.recoveryOnly) {
    next(
      new HttpError(
        403,
        "RECOVERY_IN_PROGRESS",
        "Register a new passkey before continuing.",
      ),
    );
    return;
  }
  next();
};

export const requireCsrf =
  (auth: AuthService): RequestHandler =>
  async (request, _response, next) => {
    try {
      const context = request.auth;
      const token = request.header("x-csrf-token");
      if (
        !context ||
        !(await auth.isCsrfValid(context.rawSessionToken, context.session, token))
      ) {
        throw new HttpError(
          403,
          "CSRF_INVALID",
          "The request security token is missing or invalid.",
        );
      }
      next();
    } catch (error) {
      next(error);
    }
  };

export const requireSameOrigin =
  (webOrigin: string): RequestHandler =>
  (request, _response, next) => {
    if (request.get("origin") !== webOrigin) {
      next(new HttpError(403, "ORIGIN_INVALID", "The request origin is not allowed."));
      return;
    }
    next();
  };

export const requireOwnedDevice =
  (auth: AuthService): RequestHandler =>
  async (request, _response, next) => {
    try {
      const userId = request.auth?.session.userId;
      const deviceId = request.params.deviceId;
      const deviceOwner = await auth.deviceOwner(
        typeof deviceId === "string" ? deviceId : "",
      );
      if (!userId || !deviceOwner || userId !== deviceOwner) {
        throw new HttpError(404, "DEVICE_NOT_FOUND", "The passkey was not found.");
      }
      next();
    } catch (error) {
      next(error);
    }
  };
