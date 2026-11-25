import { Router } from "express";
import type { AuthConfig } from "../auth/auth.types.js";
import type { AuthService } from "../auth/auth.service.js";
import {
  requireAuth,
  requireCsrf,
  requireFullSession,
  requireSameOrigin,
} from "../auth/auth.middleware.js";
import { validateBody } from "../../middleware/validate.js";
import { syncPullSchema, syncPushSchema } from "./sync.schemas.js";
import type { SyncService } from "./sync.service.js";

export const createSyncRouter = (
  service: SyncService,
  auth: AuthService,
  config: AuthConfig,
  production: boolean,
) => {
  const router = Router();
  const authenticated = requireAuth(auth, production);
  router.post(
    "/sync/push",
    requireSameOrigin(config.webOrigin),
    authenticated,
    requireFullSession,
    requireCsrf(auth),
    validateBody(syncPushSchema),
    async (request, response) => {
      const result = await service.push(
        request.auth!.session.userId,
        request.body.mutations,
      );
      response.json({ data: result });
    },
  );
  router.get(
    "/sync/pull",
    authenticated,
    requireFullSession,
    async (request, response) => {
      const { cursor } = syncPullSchema.parse(request.query);
      const result = await service.pull(request.auth!.session.userId, cursor);
      response.json({ data: result });
    },
  );
  return router;
};
