import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { HttpError } from "../../lib/http-error.js";
import type {
  AuthConfig,
  AuthRepository,
  CredentialInput,
  SessionInput,
  SessionResult,
  StoredSession,
  WebAuthnVerifier,
} from "./auth.types.js";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

const newToken = (): string => randomBytes(32).toString("base64url");
const csrfForSession = (sessionToken: string): string =>
  createHmac("sha256", sessionToken).update("pfm-csrf-v1").digest("base64url");

const secureEquals = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
};

const createRecoveryCodes = (): { codes: string[]; hashes: string[] } => {
  const codes = Array.from({ length: 10 }, () => {
    const raw = randomBytes(16).toString("hex");
    return raw.match(/.{1,4}/g)?.join("-") ?? raw;
  });
  return { codes, hashes: codes.map((code) => hash(code.replaceAll("-", ""))) };
};

const normalizedRecoveryCode = (value: string): string =>
  value.replaceAll("-", "").replaceAll(" ", "").toLowerCase();

const isUniqueConstraintError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "P2002";

export interface AuthenticatedSession {
  session: StoredSession;
  csrfToken: string;
}

export class AuthService {
  constructor(
    private readonly repository: AuthRepository,
    private readonly webAuthn: WebAuthnVerifier,
    private readonly config: AuthConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async registrationOptions(input: {
    setupToken?: string;
    userId?: string;
    recoveryOnly?: boolean;
  }) {
    const user = await this.repository.findPrimaryUser();
    let userId: string;
    let isInitialSetup = false;

    if (!input.userId) {
      if (user) {
        throw new HttpError(
          409,
          "REGISTRATION_CLOSED",
          "Passkey setup is already complete.",
        );
      }
      if (
        !this.config.setupToken ||
        !input.setupToken ||
        !secureEquals(hash(input.setupToken), hash(this.config.setupToken))
      ) {
        throw new HttpError(403, "INVALID_SETUP_TOKEN", "The setup token is invalid.");
      }
      userId = randomBytes(16).toString("base64url");
      isInitialSetup = true;
    } else {
      if (!user || user.id !== input.userId) {
        throw new HttpError(
          401,
          "UNAUTHENTICATED",
          "Sign in to register another passkey.",
        );
      }
      if (input.recoveryOnly !== true && input.recoveryOnly !== false) {
        throw new HttpError(
          401,
          "UNAUTHENTICATED",
          "Sign in to register another passkey.",
        );
      }
      userId = user.id;
    }

    const existingCredentials = isInitialSetup
      ? []
      : await this.repository.listCredentials(userId);
    const options = await this.webAuthn.generateRegistrationOptions({
      userId,
      userName: "personal-finance-manager",
      excludeCredentials: existingCredentials.map((credential) => ({
        id: credential.credentialId,
        transports: credential.transports,
      })),
    });

    await this.repository.createChallenge({
      challenge: options.challenge,
      purpose: "REGISTRATION",
      ...(isInitialSetup ? { userHandle: userId } : { userId }),
      expiresAt: new Date(this.now().getTime() + this.config.challengeTtlSeconds * 1000),
    });

    return { options, isInitialSetup };
  }

  async verifyRegistration(input: {
    challenge: string;
    response: Parameters<WebAuthnVerifier["verifyRegistration"]>[0]["response"];
    authenticatedUserId?: string;
    recoveryOnly?: boolean;
    authenticatedSessionToken?: string;
    authenticatedSessionExpiresAt?: Date;
    deviceName?: string;
  }): Promise<{
    userId: string;
    session?: SessionResult;
    recoveryCodes?: string[];
  }> {
    const challenge = await this.repository.findChallenge(
      input.challenge,
      "REGISTRATION",
    );
    const now = this.now();
    if (!challenge || challenge.consumedAt || challenge.expiresAt <= now) {
      throw new HttpError(
        400,
        "CHALLENGE_INVALID",
        "The registration challenge is expired or has already been used.",
      );
    }

    if (challenge.userId && challenge.userId !== input.authenticatedUserId) {
      throw new HttpError(
        401,
        "UNAUTHENTICATED",
        "Sign in to finish registering this passkey.",
      );
    }
    if (!challenge.userId && input.authenticatedUserId) {
      throw new HttpError(
        400,
        "CHALLENGE_INVALID",
        "The setup challenge is no longer valid.",
      );
    }
    if (!(await this.repository.consumeChallenge(challenge.id, now))) {
      throw new HttpError(
        400,
        "CHALLENGE_INVALID",
        "The registration challenge has already been used.",
      );
    }

    let verified: Awaited<ReturnType<WebAuthnVerifier["verifyRegistration"]>>;
    try {
      verified = await this.webAuthn.verifyRegistration({
        response: input.response,
        expectedChallenge: challenge.challenge,
      });
    } catch {
      verified = null;
    }
    if (!verified) {
      throw new HttpError(
        400,
        "PASSKEY_INVALID",
        "The passkey registration could not be verified.",
      );
    }

    const credential: CredentialInput = {
      ...verified,
      deviceName: input.deviceName?.trim().slice(0, 100) || "Passkey",
    };

    if (!challenge.userId) {
      if (!challenge.userHandle) {
        throw new HttpError(400, "CHALLENGE_INVALID", "The setup challenge is invalid.");
      }
      const session = this.createSessionInput(false);
      const recovery = createRecoveryCodes();
      try {
        await this.repository.createInitialUser({
          userId: challenge.userHandle,
          credential,
          session,
          recoveryCodes: recovery.hashes.map((codeHash) => ({ codeHash })),
        });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new HttpError(
            409,
            "SETUP_ALREADY_COMPLETED",
            "First-time setup was completed in another request.",
          );
        }
        throw error;
      }
      return {
        userId: challenge.userHandle,
        session: this.toSessionResult(challenge.userHandle, session),
        recoveryCodes: recovery.codes,
      };
    }

    if (!input.authenticatedUserId) {
      throw new HttpError(401, "UNAUTHENTICATED", "Sign in to register another passkey.");
    }
    if (input.recoveryOnly) {
      if (!input.authenticatedSessionToken || !input.authenticatedSessionExpiresAt) {
        throw new HttpError(401, "UNAUTHENTICATED", "The recovery session has expired.");
      }
      const session = {
        rawToken: input.authenticatedSessionToken,
        tokenHash: hash(input.authenticatedSessionToken),
        recoveryOnly: false,
        expiresAt: input.authenticatedSessionExpiresAt,
      };
      const recovery = createRecoveryCodes();
      try {
        await this.repository.createCredential({
          userId: input.authenticatedUserId,
          credential,
          session,
          rotateRecoveryCodes: recovery.hashes.map((codeHash) => ({ codeHash })),
        });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new HttpError(
            409,
            "PASSKEY_ALREADY_REGISTERED",
            "This passkey is already registered.",
          );
        }
        throw error;
      }
      return {
        userId: input.authenticatedUserId,
        session: this.toSessionResult(input.authenticatedUserId, session),
        recoveryCodes: recovery.codes,
      };
    }

    try {
      await this.repository.createCredential({
        userId: input.authenticatedUserId,
        credential,
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new HttpError(
          409,
          "PASSKEY_ALREADY_REGISTERED",
          "This passkey is already registered.",
        );
      }
      throw error;
    }
    return { userId: input.authenticatedUserId };
  }

  async authenticationOptions() {
    const user = await this.repository.findPrimaryUser();
    if (!user) {
      throw new HttpError(
        409,
        "SETUP_REQUIRED",
        "Complete first-time setup before signing in.",
      );
    }
    const credentials = await this.repository.listCredentials(user.id);
    if (credentials.length === 0) {
      throw new HttpError(
        409,
        "NO_PASSKEYS",
        "No passkeys are registered for this account.",
      );
    }
    const options = await this.webAuthn.generateAuthenticationOptions({
      allowCredentials: credentials.map((credential) => ({
        id: credential.credentialId,
        transports: credential.transports,
      })),
    });
    await this.repository.createChallenge({
      challenge: options.challenge,
      purpose: "AUTHENTICATION",
      userId: user.id,
      expiresAt: new Date(this.now().getTime() + this.config.challengeTtlSeconds * 1000),
    });
    return options;
  }

  async verifyAuthentication(input: {
    challenge: string;
    response: Parameters<WebAuthnVerifier["verifyAuthentication"]>[0]["response"];
  }): Promise<SessionResult> {
    const challenge = await this.repository.findChallenge(
      input.challenge,
      "AUTHENTICATION",
    );
    const now = this.now();
    if (!challenge || challenge.consumedAt || challenge.expiresAt <= now) {
      throw new HttpError(
        400,
        "CHALLENGE_INVALID",
        "The sign-in challenge is expired or has already been used.",
      );
    }
    if (!(await this.repository.consumeChallenge(challenge.id, now))) {
      throw new HttpError(
        400,
        "CHALLENGE_INVALID",
        "The sign-in challenge has already been used.",
      );
    }

    const credential = await this.repository.findCredential(input.response.id);
    if (!credential || credential.userId !== challenge.userId) {
      throw new HttpError(401, "PASSKEY_INVALID", "The passkey could not be verified.");
    }
    let verified: Awaited<ReturnType<WebAuthnVerifier["verifyAuthentication"]>>;
    try {
      verified = await this.webAuthn.verifyAuthentication({
        response: input.response,
        credential,
        expectedChallenge: challenge.challenge,
      });
    } catch {
      verified = null;
    }
    if (!verified) {
      throw new HttpError(401, "PASSKEY_INVALID", "The passkey could not be verified.");
    }

    const session = this.createSessionInput(false);
    const userId = await this.repository.updateCredentialAndCreateSession({
      credentialId: credential.credentialId,
      newCounter: verified.newCounter,
      session,
      now,
    });
    if (!userId) {
      throw new HttpError(401, "PASSKEY_INVALID", "The passkey could not be verified.");
    }
    return this.toSessionResult(userId, session);
  }

  async recover(input: { code: string }): Promise<SessionResult> {
    const user = await this.repository.findPrimaryUser();
    if (!user)
      throw new HttpError(409, "SETUP_REQUIRED", "Complete first-time setup first.");
    const session = this.createSessionInput(true);
    const recovered = await this.repository.recoverWithCode({
      userId: user.id,
      codeHash: hash(normalizedRecoveryCode(input.code)),
      session,
      now: this.now(),
    });
    if (!recovered) {
      throw new HttpError(
        401,
        "RECOVERY_CODE_INVALID",
        "The recovery code is invalid or has already been used.",
      );
    }
    return this.toSessionResult(user.id, session);
  }

  async getSession(rawToken: string | undefined): Promise<AuthenticatedSession | null> {
    if (!rawToken) return null;
    const session = await this.loadSession(rawToken);
    if (!session) return null;
    return { session, csrfToken: csrfForSession(rawToken) };
  }

  async loadSession(rawToken: string): Promise<StoredSession | null> {
    return this.repository.findSession(hash(rawToken), this.now());
  }

  async isCsrfValid(
    sessionToken: string,
    session: StoredSession,
    csrfToken: string | undefined,
  ): Promise<boolean> {
    if (!csrfToken) return false;
    return Promise.resolve(secureEquals(csrfForSession(sessionToken), csrfToken));
  }

  async logout(rawToken: string | undefined): Promise<void> {
    if (rawToken) await this.repository.revokeSession(hash(rawToken), this.now());
  }

  listDevices(userId: string) {
    return this.repository.listDevices(userId);
  }

  async revokeDevice(userId: string, deviceId: string) {
    const result = await this.repository.revokeDevice(userId, deviceId);
    if (result === "last-device") {
      throw new HttpError(
        409,
        "LAST_PASSKEY",
        "Add another passkey or use recovery before removing the last one.",
      );
    }
    if (result === "not-found") {
      throw new HttpError(404, "DEVICE_NOT_FOUND", "The passkey was not found.");
    }
  }

  async deviceOwner(deviceId: string): Promise<string | null> {
    return this.repository.findDeviceOwner(deviceId);
  }

  private createSessionInput(recoveryOnly: boolean): SessionInput & {
    rawToken: string;
  } {
    const rawToken = newToken();
    return {
      rawToken,
      tokenHash: hash(rawToken),
      recoveryOnly,
      expiresAt: new Date(
        this.now().getTime() + this.config.sessionTtlHours * 60 * 60 * 1000,
      ),
    };
  }

  private toSessionResult(
    userId: string,
    session: SessionInput & { rawToken: string },
  ): SessionResult {
    return {
      userId,
      sessionToken: session.rawToken,
      csrfToken: csrfForSession(session.rawToken),
      expiresAt: session.expiresAt,
    };
  }
}
