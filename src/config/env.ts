import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  WEB_ORIGIN: z.url().default("http://localhost:5173"),
  WEBAUTHN_RP_ID: z.string().min(1).default("localhost"),
  WEBAUTHN_RP_NAME: z.string().min(1).default("Personal Finance Manager"),
  SETUP_TOKEN: z.string().min(32).optional(),
  AUTH_CHALLENGE_TTL_SECONDS: z.coerce.number().int().min(60).max(600).default(300),
  AUTH_SESSION_TTL_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .default(12),
  DATABASE_URL: z
    .url()
    .default("mysql://pfm:pfm-local-only@127.0.0.1:3306/personal_finance"),
  AMFI_NAV_URL: z.url().default("https://portal.amfiindia.com/spages/NAVAll.txt"),
  BACKUP_DIRECTORY: z.string().default("./var/backups"),
  BACKUP_RESTORE_SCRIPT: z.string().optional(),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  throw new Error(
    `Invalid environment configuration: ${z.prettifyError(parsedEnv.error)}`,
  );
}

export const env = parsedEnv.data;
