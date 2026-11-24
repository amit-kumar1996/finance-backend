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
import type { PeopleService } from "./people.service.js";
import {
  createPersonSchema,
  personMovementSchema,
  updatePersonSchema,
} from "./people.schemas.js";

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

export const createPeopleRouter = (
  service: PeopleService,
  auth: AuthService,
  config: AuthConfig,
  production: boolean,
) => {
  const router = Router();
  const authenticated = requireAuth(auth, production);
  const csrf = requireCsrf(auth);
  const sameOrigin = requireSameOrigin(config.webOrigin);

  router.get("/people", authenticated, requireFullSession, async (request, response) => {
    const people = await service.listPeople(request.auth!.session.userId);
    response.json({ data: { people } });
  });

  router.post(
    "/people",
    sameOrigin,
    authenticated,
    requireFullSession,
    csrf,
    validateBody(createPersonSchema),
    async (request, response) => {
      const person = await service.createPerson(
        request.auth!.session.userId,
        readIdempotencyKey(request.header("idempotency-key")),
        request.body,
      );
      response.status(201).json({ data: { person } });
    },
  );

  router.post(
    "/people/transactions",
    sameOrigin,
    authenticated,
    requireFullSession,
    csrf,
    validateBody(personMovementSchema),
    async (request, response) => {
      const result = await service.postMovement({
        userId: request.auth!.session.userId,
        idempotencyKey: readIdempotencyKey(request.header("idempotency-key")),
        ...request.body,
      });
      response.status(201).json({ data: result });
    },
  );

  router.get(
    "/people/:personId/statement",
    authenticated,
    requireFullSession,
    async (request, response) => {
      const personId = request.params.personId;
      const statement = await service.getStatement(
        request.auth!.session.userId,
        typeof personId === "string" ? personId : "",
      );
      response.json({ data: statement });
    },
  );

  router.get(
    "/people/:personId",
    authenticated,
    requireFullSession,
    async (request, response) => {
      const personId = request.params.personId;
      const person = await service.getPerson(
        request.auth!.session.userId,
        typeof personId === "string" ? personId : "",
      );
      response.json({ data: { person } });
    },
  );

  router.patch(
    "/people/:personId",
    sameOrigin,
    authenticated,
    requireFullSession,
    csrf,
    validateBody(updatePersonSchema),
    async (request, response) => {
      const personId = request.params.personId;
      const person = await service.updatePerson(
        request.auth!.session.userId,
        typeof personId === "string" ? personId : "",
        readIdempotencyKey(request.header("idempotency-key")),
        request.body,
      );
      response.json({ data: { person } });
    },
  );

  router.delete(
    "/people/:personId",
    sameOrigin,
    authenticated,
    requireFullSession,
    csrf,
    async (request, response) => {
      const personId = request.params.personId;
      const result = await service.archivePerson(
        request.auth!.session.userId,
        typeof personId === "string" ? personId : "",
        readIdempotencyKey(request.header("idempotency-key")),
      );
      response.json({ data: result });
    },
  );

  return router;
};
