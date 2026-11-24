import request from "supertest";
import express from "express";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { errorHandler } from "../middleware/error-handler.js";
import { validateBody } from "../middleware/validate.js";

describe("GET /api/v1/health", () => {
  it("reports API and database readiness", async () => {
    const response = await request(createApp(async () => undefined)).get(
      "/api/v1/health",
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: { status: "ok", database: "ok", version: "v1" },
    });
  });

  it("returns a safe error when the database check fails", async () => {
    const response = await request(
      createApp(async () => {
        throw new Error("database secret details");
      }),
    ).get("/api/v1/health");

    expect(response.status).toBe(500);
    expect(response.body.error.message).toBe("An unexpected error occurred.");
    expect(JSON.stringify(response.body)).not.toContain("database secret details");
  });
});

describe("request validation", () => {
  it("rejects invalid input with a safe validation response", async () => {
    const app = express();
    app.use(express.json());
    app.post(
      "/test",
      validateBody(z.object({ amount: z.string().regex(/^\d+$/) })),
      (req, res) => {
        res.json({ data: req.body });
      },
    );
    app.use(errorHandler);

    const response = await request(app).post("/test").send({ amount: "not-a-number" });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });
});
