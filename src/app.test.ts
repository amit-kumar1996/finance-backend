import { Router } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";

const createTestApp = () => {
  const authRouter = Router();
  authRouter.get("/session", (_request, response) => response.json({ ok: true }));
  authRouter.post("/login/options", (_request, response) => response.json({ ok: true }));
  return createApp(async () => undefined, authRouter);
};

describe("authentication rate limits", () => {
  it("does not count session checks or unknown auth paths as passkey attempts", async () => {
    const app = createTestApp();

    for (let attempt = 0; attempt < 12; attempt += 1) {
      expect((await request(app).get("/api/v1/auth/session")).status).toBe(200);
      expect((await request(app).get("/api/v1/auth/accounts")).status).toBe(404);
    }
  });

  it("limits repeated passkey login option requests", async () => {
    const app = createTestApp();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await request(app).post("/api/v1/auth/login/options")).status).toBe(200);
    }

    const limited = await request(app).post("/api/v1/auth/login/options");
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("RATE_LIMITED");
  });
});
