import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { HttpError } from "../../lib/http-error.js";

export interface BackupManifest {
  id: string;
  createdAt: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  encryption: "age";
  offsite: "copied" | "pending" | "failed";
}

const isId = (value: string): boolean => /^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(value);

export class BackupsService {
  constructor(
    private readonly directory: string,
    private readonly restoreScript?: string,
  ) {}

  private manifestPath(id: string): string {
    if (!isId(id)) throw new HttpError(404, "BACKUP_NOT_FOUND", "Backup not found.");
    return path.join(this.directory, `${id}.json`);
  }

  private async readManifest(id: string): Promise<BackupManifest> {
    try {
      const parsed: unknown = JSON.parse(
        await fs.readFile(this.manifestPath(id), "utf8"),
      );
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("id" in parsed) ||
        parsed.id !== id ||
        !("fileName" in parsed) ||
        parsed.fileName !== `${id}.sql.age` ||
        !("sha256" in parsed) ||
        typeof parsed.sha256 !== "string"
      )
        throw new Error("invalid manifest");
      return parsed as BackupManifest;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(404, "BACKUP_NOT_FOUND", "Backup not found.");
    }
  }

  async list(): Promise<{ backups: BackupManifest[] }> {
    let files: string[];
    try {
      files = await fs.readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { backups: [] };
      throw error;
    }
    const backups = await Promise.all(
      files
        .filter((name) => /^\d{8}T\d{6}Z-[a-f0-9]{8}\.json$/.test(name))
        .map(async (name) => {
          try {
            return await this.readManifest(name.slice(0, -5));
          } catch {
            return null;
          }
        }),
    );
    return {
      backups: backups
        .filter((entry): entry is BackupManifest => entry !== null)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    };
  }

  async artifact(id: string): Promise<{ manifest: BackupManifest; path: string }> {
    const manifest = await this.readManifest(id);
    const artifactPath = path.join(this.directory, manifest.fileName);
    try {
      const info = await fs.stat(artifactPath);
      if (!info.isFile()) throw new Error("not a file");
    } catch {
      throw new HttpError(404, "BACKUP_NOT_FOUND", "Backup artifact not found.");
    }
    return { manifest, path: artifactPath };
  }

  async verify(id: string): Promise<{ id: string; valid: boolean; checkedAt: string }> {
    const { manifest, path: artifactPath } = await this.artifact(id);
    const digest = createHash("sha256");
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(artifactPath);
      stream.on("data", (chunk: Buffer) => digest.update(chunk));
      stream.once("error", reject);
      stream.once("end", resolve);
    });
    return {
      id,
      valid: digest.digest("hex") === manifest.sha256,
      checkedAt: new Date().toISOString(),
    };
  }

  async restoreToScratch(
    id: string,
    confirmation: string,
  ): Promise<{ restoreId: string; databaseName: string; status: "started" }> {
    const { path: artifactPath } = await this.artifact(id);
    if (confirmation !== `RESTORE ${id}`) {
      throw new HttpError(
        400,
        "RESTORE_CONFIRMATION_REQUIRED",
        `Type RESTORE ${id} to continue.`,
      );
    }
    if (!this.restoreScript) {
      throw new HttpError(
        503,
        "RESTORE_NOT_CONFIGURED",
        "Scratch restore is not configured on this server.",
      );
    }
    const restoreId = randomUUID().replaceAll("-", "").slice(0, 12);
    const databaseName = `pfm_restore_${restoreId}`;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        this.restoreScript!,
        [artifactPath, databaseName, confirmation],
        {
          stdio: "ignore",
          shell: false,
          env: process.env,
        },
      );
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`Restore command exited with ${code ?? "signal"}.`)),
      );
    }).catch(() => {
      throw new HttpError(
        500,
        "RESTORE_FAILED",
        "Scratch restore failed. Check the server backup log.",
      );
    });
    return { restoreId, databaseName, status: "started" };
  }
}
