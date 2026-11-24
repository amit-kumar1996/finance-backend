import { Router, type Request, type Response } from "express";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { HttpError } from "../../lib/http-error.js";
import { validateBody } from "../../middleware/validate.js";
import type { AuthConfig } from "./auth.types.js";
import type { AuthService } from "./auth.service.js";
import {
  authenticationOptionsSchema,
  authenticationVerifySchema,
  recoverySchema,
  registrationOptionsSchema,
  registrationVerifySchema,
} from "./auth.schemas.js";
import {
  readSessionCookie,
  requireAuth,
  requireCsrf,
  requireFullSession,
  requireOwnedDevice,
  requireSameOrigin,
  sessionCookieName,
} from "./auth.middleware.js";

const publicSession = (session: {
  userId: string;
  csrfToken: string;
  expiresAt: Date;
}): { userId: string; csrfToken: string; expiresAt: Date } => ({
  userId: session.userId,
  csrfToken: session.csrfToken,
  expiresAt: session.expiresAt,
});

const setSessionCookie = (
  response: Response,
  session: { sessionToken: string; expiresAt: Date },
  production: boolean,
): void => {
  response.cookie(sessionCookieName(production), session.sessionToken, {
    httpOnly: true,
    secure: production,
    sameSite: "lax",
    path: "/",
    expires: session.expiresAt,
  });
};

const clearSessionCookie = (response: Response, production: boolean): void => {
  response.clearCookie(sessionCookieName(production), {
    httpOnly: true,
    secure: production,
    sameSite: "lax",
    path: "/",
  });
};

const optionalSession = async (
  request: Request,
  auth: AuthService,
  production: boolean,
) => {
  const rawSessionToken = readSessionCookie(request.headers.cookie, production);
  if (!rawSessionToken) return null;
  const session = await auth.loadSession(rawSessionToken);
  return session ? { session, rawSessionToken } : null;
};

export const createAuthRouter = (
  auth: AuthService,
  config: AuthConfig,
  production: boolean,
) => {
  const router = Router();
  const authenticated = requireAuth(auth, production);
  const sameOrigin = requireSameOrigin(config.webOrigin);

  router.post(
    "/register/options",
    sameOrigin,
    validateBody(registrationOptionsSchema),
    async (request, response) => {
      const current = await optionalSession(request, auth, production);
      if (
        current &&
        !(await auth.isCsrfValid(
          current.rawSessionToken,
          current.session,
          request.header("x-csrf-token"),
        ))
      ) {
        throw new HttpError(
          403,
          "CSRF_INVALID",
          "The request security token is missing or invalid.",
        );
      }
      const setupToken = request.header("x-setup-token");
      const result = await auth.registrationOptions({
        ...(setupToken ? { setupToken } : {}),
        ...(current
          ? {
              userId: current.session.userId,
              recoveryOnly: current.session.recoveryOnly,
            }
          : {}),
      });
      response.json({ data: result });
    },
  );

  router.post(
    "/register/verify",
    sameOrigin,
    validateBody(registrationVerifySchema),
    async (request, response) => {
      const current = await optionalSession(request, auth, production);
      if (
        current &&
        !(await auth.isCsrfValid(
          current.rawSessionToken,
          current.session,
          request.header("x-csrf-token"),
        ))
      ) {
        throw new HttpError(
          403,
          "CSRF_INVALID",
          "The request security token is missing or invalid.",
        );
      }
      const result = await auth.verifyRegistration({
        challenge: request.body.challenge,
        response: request.body.credential as RegistrationResponseJSON,
        deviceName: request.body.deviceName,
        ...(current
          ? {
              authenticatedUserId: current.session.userId,
              recoveryOnly: current.session.recoveryOnly,
              authenticatedSessionToken: current.rawSessionToken,
              authenticatedSessionExpiresAt: current.session.expiresAt,
            }
          : {}),
      });
      if (result.session) setSessionCookie(response, result.session, production);
      response.status(201).json({
        data: {
          userId: result.userId,
          ...(result.session ? { session: publicSession(result.session) } : {}),
          ...(result.recoveryCodes ? { recoveryCodes: result.recoveryCodes } : {}),
        },
      });
    },
  );

  router.post(
    "/login/options",
    sameOrigin,
    validateBody(authenticationOptionsSchema),
    async (_request, response) => {
      const options = await auth.authenticationOptions();
      response.json({ data: { options } });
    },
  );

  router.post(
    "/login/verify",
    sameOrigin,
    validateBody(authenticationVerifySchema),
    async (request, response) => {
      const session = await auth.verifyAuthentication({
        challenge: request.body.challenge,
        response: request.body.credential as AuthenticationResponseJSON,
      });
      setSessionCookie(response, session, production);
      response.json({ data: publicSession(session) });
    },
  );

  router.get("/session", async (request, response) => {
    const rawSessionToken = readSessionCookie(request.headers.cookie, production);
    const current = await auth.getSession(rawSessionToken);
    if (!current) {
      response.status(401).json({
        error: {
          code: "UNAUTHENTICATED",
          message: "Sign in with a passkey to continue.",
        },
      });
      return;
    }
    response.json({
      data: {
        userId: current.session.userId,
        recoveryOnly: current.session.recoveryOnly,
        expiresAt: current.session.expiresAt,
        csrfToken: current.csrfToken,
      },
    });
  });

  router.post(
    "/logout",
    sameOrigin,
    authenticated,
    requireCsrf(auth),
    async (request, response) => {
      await auth.logout(request.auth?.rawSessionToken);
      clearSessionCookie(response, production);
      response.json({ data: { loggedOut: true } });
    },
  );

  router.get("/devices", authenticated, requireFullSession, async (request, response) => {
    const devices = await auth.listDevices(request.auth!.session.userId);
    response.json({ data: { devices } });
  });

  router.delete(
    "/devices/:deviceId",
    sameOrigin,
    authenticated,
    requireFullSession,
    requireCsrf(auth),
    requireOwnedDevice(auth),
    async (request, response) => {
      const deviceId = request.params.deviceId;
      await auth.revokeDevice(
        request.auth!.session.userId,
        typeof deviceId === "string" ? deviceId : "",
      );
      response.json({ data: { removed: true } });
    },
  );

  router.post(
    "/recovery/verify",
    sameOrigin,
    validateBody(recoverySchema),
    async (request, response) => {
      const session = await auth.recover({ code: request.body.code });
      setSessionCookie(response, session, production);
      response.json({ data: publicSession(session) });
    },
  );

  return router;
};
