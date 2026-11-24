import type { StoredSession } from "./auth.types.js";

declare global {
  namespace Express {
    interface Request {
      auth?: {
        session: StoredSession;
        rawSessionToken: string;
      };
    }
  }
}

export {};
