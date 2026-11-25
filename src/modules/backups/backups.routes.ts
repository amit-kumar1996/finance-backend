import { Router } from "express";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import type { AuthService } from "../auth/auth.service.js";
import {
  requireAuth,
  requireCsrf,
  requireFullSession,
  requireSameOrigin,
} from "../auth/auth.middleware.js";
import type { BackupsService } from "./backups.service.js";

const restoreSchema = z.object({ confirmation: z.string().min(1).max(100) }).strict();
const routeBackupId = (value: string | string[] | undefined): string =>
  typeof value === "string" ? value : "";

export const createBackupsRouter = (
  service: BackupsService,
  auth: AuthService,
  prisma: PrismaClient,
  webOrigin: string,
  production: boolean,
) => {
  const router = Router();
  const authenticated = requireAuth(auth, production);
  router.get(
    "/backups",
    authenticated,
    requireFullSession,
    async (_request, response) => {
      response.json({ data: await service.list() });
    },
  );
  router.get(
    "/backups/:backupId/download",
    authenticated,
    requireFullSession,
    async (request, response) => {
      const result = await service.artifact(routeBackupId(request.params.backupId));
      await prisma.auditLog.create({
        data: {
          userId: request.auth!.session.userId,
          entityType: "BACKUP",
          entityId: result.manifest.id,
          action: "DOWNLOAD_ENCRYPTED",
        },
      });
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "application/octet-stream");
      response.setHeader(
        "Content-Disposition",
        `attachment; filename="${result.manifest.fileName}"`,
      );
      response.sendFile(result.path);
    },
  );
  router.post(
    "/backups/:backupId/verify",
    requireSameOrigin(webOrigin),
    authenticated,
    requireFullSession,
    requireCsrf(auth),
    async (request, response) => {
      const result = await service.verify(routeBackupId(request.params.backupId));
      await prisma.auditLog.create({
        data: {
          userId: request.auth!.session.userId,
          entityType: "BACKUP",
          entityId: result.id,
          action: result.valid ? "INTEGRITY_VERIFIED" : "INTEGRITY_FAILED",
          changes: { valid: result.valid },
        },
      });
      response.json({ data: result });
    },
  );
  router.post(
    "/backups/:backupId/restore",
    requireSameOrigin(webOrigin),
    authenticated,
    requireFullSession,
    requireCsrf(auth),
    async (request, response) => {
      const { confirmation } = restoreSchema.parse(request.body);
      const result = await service.restoreToScratch(
        routeBackupId(request.params.backupId),
        confirmation,
      );
      await prisma.auditLog.create({
        data: {
          userId: request.auth!.session.userId,
          entityType: "BACKUP",
          entityId: routeBackupId(request.params.backupId),
          action: "RESTORE_TO_SCRATCH",
          changes: { databaseName: result.databaseName, restoreId: result.restoreId },
        },
      });
      response.status(202).json({ data: result });
    },
  );
  return router;
};
