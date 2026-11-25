import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BackupsService } from "./backups.service.js";

const directories: string[] = [];
const createFixture = async (id = "20261125T120000Z-1234abcd") => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pfm-backups-test-"));
  directories.push(directory);
  const bytes = Buffer.from("encrypted fixture");
  await writeFile(path.join(directory, `${id}.sql.age`), bytes);
  await writeFile(
    path.join(directory, `${id}.json`),
    JSON.stringify({
      id,
      createdAt: "2026-11-25T12:00:00.000Z",
      fileName: `${id}.sql.age`,
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      encryption: "age",
      offsite: "copied",
    }),
  );
  return { directory, id };
};

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("backup history and integrity", () => {
  it("lists artifacts and verifies the encrypted file hash", async () => {
    const { directory, id } = await createFixture();
    const service = new BackupsService(directory);
    expect((await service.list()).backups.map((backup) => backup.id)).toEqual([id]);
    expect((await service.verify(id)).valid).toBe(true);
  });

  it("reports altered ciphertext and rejects path-like identifiers", async () => {
    const { directory, id } = await createFixture();
    await writeFile(path.join(directory, `${id}.sql.age`), "changed");
    const service = new BackupsService(directory);
    expect((await service.verify(id)).valid).toBe(false);
    await expect(service.artifact("../secret")).rejects.toMatchObject({ status: 404 });
  });

  it("requires the typed phrase before starting a scratch restore", async () => {
    const { directory, id } = await createFixture();
    const service = new BackupsService(directory, "unused-restore-command");
    await expect(service.restoreToScratch(id, "yes")).rejects.toMatchObject({
      status: 400,
    });
  });

  it("returns an empty history when the configured directory is not created yet", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "pfm-backups-empty-"));
    directories.push(parent);
    const absent = path.join(parent, "not-created");
    expect((await new BackupsService(absent).list()).backups).toEqual([]);
  });
});
