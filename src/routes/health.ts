import { Router } from "express";

export type DatabaseCheck = () => Promise<void>;

export const createHealthRouter = (checkDatabase: DatabaseCheck): Router => {
  const router = Router();

  router.get("/health", async (_request, response, next) => {
    try {
      await checkDatabase();
      response.status(200).json({
        data: { status: "ok", database: "ok", version: "v1" },
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
};
