import { Router } from "express";
import { z } from "zod";
import type { AuthService } from "../auth/auth.service.js";
import { requireAuth, requireFullSession } from "../auth/auth.middleware.js";
import { todayInKolkata, type NetWorthService } from "./net-worth.service.js";

const yearQuery = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

export const createNetWorthRouter = (
  service: NetWorthService,
  auth: AuthService,
  production: boolean,
) => {
  const router = Router();
  const authenticated = requireAuth(auth, production);
  router.get(
    "/dashboard",
    authenticated,
    requireFullSession,
    async (request, response) => {
      response.json({ data: await service.dashboard(request.auth!.session.userId) });
    },
  );
  router.get(
    "/net-worth",
    authenticated,
    requireFullSession,
    async (request, response) => {
      response.json({ data: await service.netWorth(request.auth!.session.userId) });
    },
  );
  router.get("/reports", authenticated, requireFullSession, async (request, response) => {
    const { year } = yearQuery.parse(request.query);
    response.json({
      data: await service.reports(
        request.auth!.session.userId,
        year ?? Number(todayInKolkata().slice(0, 4)),
      ),
    });
  });
  return router;
};
