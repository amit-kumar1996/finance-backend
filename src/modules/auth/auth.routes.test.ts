import type {
  AuthenticationResponseJSON,
  AuthenticatorTransport,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { AuthService } from "./auth.service.js";
import { createAuthRouter } from "./auth.routes.js";
import type {
  AuthRepository,
  CredentialInput,
  DeviceSummary,
  RecoveryCodeInput,
  SessionInput,
  StoredChallenge,
  StoredCredential,
  StoredSession,
  WebAuthnVerifier,
} from "./auth.types.js";

const WEB_ORIGIN = "http://localhost:5173";
const SETUP_TOKEN = "local-test-setup-token-that-is-at-least-32-characters";
const authConfig = {
  rpId: "localhost",
  rpName: "Personal Finance Manager",
  webOrigin: WEB_ORIGIN,
  setupToken: SETUP_TOKEN,
  challengeTtlSeconds: 300,
  sessionTtlHours: 12,
};

class MemoryAuthRepository implements AuthRepository {
  user: { id: string } | null = null;
  readonly credentials: StoredCredential[] = [];
  readonly challenges: StoredChallenge[] = [];
  readonly sessions: StoredSession[] = [];
  readonly recoveryCodes = new Map<string, { userId: string; usedAt: Date | null }>();
  private nextId = 0;

  addForeignDevice(credentialId: string): void {
    this.credentials.push({
      id: `device-${credentialId}`,
      userId: "user-b",
      credentialId,
      publicKey: new Uint8Array([1, 2, 3]),
      counter: 0,
      transports: ["internal"],
      deviceName: "Other user device",
      createdAt: new Date(),
      lastUsedAt: null,
    });
  }

  async findPrimaryUser() {
    return this.user;
  }

  async listCredentials(userId: string) {
    return this.credentials.filter((credential) => credential.userId === userId);
  }

  async findCredential(credentialId: string) {
    return (
      this.credentials.find((credential) => credential.credentialId === credentialId) ??
      null
    );
  }

  async findDeviceOwner(deviceId: string) {
    return (
      this.credentials.find((credential) => credential.id === deviceId)?.userId ?? null
    );
  }

  async createChallenge(input: {
    challenge: string;
    purpose: "REGISTRATION" | "AUTHENTICATION";
    userId?: string;
    userHandle?: string;
    expiresAt: Date;
  }) {
    this.challenges.push({
      id: `challenge-${++this.nextId}`,
      challenge: input.challenge,
      purpose: input.purpose,
      userId: input.userId ?? null,
      userHandle: input.userHandle ?? null,
      expiresAt: input.expiresAt,
      consumedAt: null,
    });
  }

  async findChallenge(challenge: string, purpose: "REGISTRATION" | "AUTHENTICATION") {
    return (
      this.challenges.find(
        (item) => item.challenge === challenge && item.purpose === purpose,
      ) ?? null
    );
  }

  async consumeChallenge(id: string, now: Date) {
    const challenge = this.challenges.find((item) => item.id === id);
    if (!challenge || challenge.consumedAt || challenge.expiresAt <= now) return false;
    challenge.consumedAt = now;
    return true;
  }

  async createInitialUser(input: {
    userId: string;
    credential: CredentialInput;
    session: SessionInput;
    recoveryCodes: RecoveryCodeInput[];
  }) {
    if (this.user) throw new Error("Single user already exists");
    this.user = { id: input.userId };
    this.addCredential(this.user.id, input.credential);
    this.addSession(this.user.id, input.session);
    for (const recoveryCode of input.recoveryCodes) {
      this.recoveryCodes.set(recoveryCode.codeHash, {
        userId: this.user.id,
        usedAt: null,
      });
    }
  }

  async createCredential(input: {
    userId: string;
    credential: CredentialInput;
    session?: SessionInput;
    rotateRecoveryCodes?: RecoveryCodeInput[];
  }) {
    this.addCredential(input.userId, input.credential);
    if (input.session) {
      const session = this.sessions.find(
        (item) => item.tokenHash === input.session?.tokenHash,
      );
      if (!session || !session.recoveryOnly)
        throw new Error("Recovery session is no longer valid");
      session.recoveryOnly = false;
      for (const [codeHash, code] of this.recoveryCodes) {
        if (code.userId === input.userId) this.recoveryCodes.delete(codeHash);
      }
      for (const recoveryCode of input.rotateRecoveryCodes ?? []) {
        this.recoveryCodes.set(recoveryCode.codeHash, {
          userId: input.userId,
          usedAt: null,
        });
      }
    }
  }

  async createSession(userId: string, session: SessionInput) {
    this.addSession(userId, session);
  }

  async findSession(tokenHash: string, now: Date) {
    return (
      this.sessions.find(
        (session) =>
          session.tokenHash === tokenHash &&
          !session.revokedAt &&
          session.expiresAt > now,
      ) ?? null
    );
  }

  async revokeSession(tokenHash: string, now: Date) {
    const session = this.sessions.find((item) => item.tokenHash === tokenHash);
    if (session) session.revokedAt = now;
  }

  async listDevices(userId: string): Promise<DeviceSummary[]> {
    return this.credentials
      .filter((credential) => credential.userId === userId)
      .map(({ id, deviceName, createdAt, lastUsedAt }) => ({
        id,
        deviceName: deviceName ?? "Passkey",
        createdAt,
        lastUsedAt,
      }));
  }

  async revokeDevice(userId: string, deviceId: string) {
    const index = this.credentials.findIndex(
      (credential) => credential.userId === userId && credential.id === deviceId,
    );
    if (index < 0) return "not-found" as const;
    if (
      this.credentials.filter((credential) => credential.userId === userId).length <= 1
    ) {
      return "last-device" as const;
    }
    this.credentials.splice(index, 1);
    return "removed" as const;
  }

  async recoverWithCode(input: {
    userId: string;
    codeHash: string;
    session: SessionInput;
    now: Date;
  }) {
    const code = this.recoveryCodes.get(input.codeHash);
    if (!code || code.userId !== input.userId || code.usedAt) return false;
    code.usedAt = input.now;
    this.sessions.forEach((session) => {
      if (session.userId === input.userId && !session.revokedAt)
        session.revokedAt = input.now;
    });
    for (let i = this.credentials.length - 1; i >= 0; i--) {
      if (this.credentials[i]?.userId === input.userId) this.credentials.splice(i, 1);
    }
    this.addSession(input.userId, { ...input.session, recoveryOnly: true });
    return true;
  }

  async updateCredentialAndCreateSession(input: {
    credentialId: string;
    newCounter: number;
    session: SessionInput;
    now: Date;
  }) {
    const credential = this.credentials.find(
      (item) => item.credentialId === input.credentialId,
    );
    if (!credential) return null;
    credential.counter = input.newCounter;
    credential.lastUsedAt = input.now;
    this.addSession(credential.userId, input.session);
    return credential.userId;
  }

  private addCredential(userId: string, input: CredentialInput) {
    this.credentials.push({
      id: `device-${input.credentialId}`,
      userId,
      ...input,
      createdAt: new Date(),
      lastUsedAt: null,
    });
  }

  private addSession(userId: string, input: SessionInput) {
    this.sessions.push({
      id: `session-${++this.nextId}`,
      userId,
      tokenHash: input.tokenHash,
      recoveryOnly: input.recoveryOnly ?? false,
      expiresAt: input.expiresAt,
      revokedAt: null,
    });
  }
}

class FakeWebAuthn implements WebAuthnVerifier {
  private sequence = 0;

  async generateRegistrationOptions(): Promise<PublicKeyCredentialCreationOptionsJSON> {
    return {
      challenge: `registration-${++this.sequence}`,
    } as PublicKeyCredentialCreationOptionsJSON;
  }

  async generateAuthenticationOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
    return {
      challenge: `authentication-${++this.sequence}`,
    } as PublicKeyCredentialRequestOptionsJSON;
  }

  async verifyRegistration(input: { response: RegistrationResponseJSON }) {
    return {
      credentialId: input.response.id,
      publicKey: new Uint8Array([1, 2, 3]),
      counter: 0,
      transports: ["internal"] as AuthenticatorTransport[],
    };
  }

  async verifyAuthentication(input: {
    response: AuthenticationResponseJSON;
    credential: StoredCredential;
  }) {
    return input.response.id === input.credential.credentialId
      ? { newCounter: input.credential.counter + 1 }
      : null;
  }
}

const registrationCredential = (id: string) => ({
  id,
  rawId: id,
  type: "public-key" as const,
  response: { clientDataJSON: "Y2xpZW50", attestationObject: "YXR0ZXN0" },
});

const authenticationCredential = (id: string) => ({
  id,
  rawId: id,
  type: "public-key" as const,
  response: {
    clientDataJSON: "Y2xpZW50",
    authenticatorData: "YXV0aA",
    signature: "c2ln",
  },
});

const createTestServer = (options?: { now?: () => Date; production?: boolean }) => {
  const repository = new MemoryAuthRepository();
  const auth = new AuthService(repository, new FakeWebAuthn(), authConfig, options?.now);
  const app = createApp(
    async () => undefined,
    createAuthRouter(auth, authConfig, options?.production ?? false),
  );
  return { repository, auth, app, agent: request.agent(app) };
};

const withOrigin = (testRequest: request.Test) => testRequest.set("Origin", WEB_ORIGIN);

const firstRegistration = async (
  agent: ReturnType<typeof request.agent>,
  credentialId = "credential-1",
) => {
  const optionsResponse = await withOrigin(
    agent.post("/api/v1/auth/register/options").set("X-Setup-Token", SETUP_TOKEN),
  ).send({});
  const challenge = optionsResponse.body.data.options.challenge as string;
  const verifyResponse = await withOrigin(
    agent.post("/api/v1/auth/register/verify"),
  ).send({ challenge, credential: registrationCredential(credentialId) });
  return { optionsResponse, verifyResponse, challenge };
};

describe("WebAuthn authentication flows", () => {
  it("gates first registration, creates one user, and issues a secure session cookie and recovery codes", async () => {
    const { repository, agent, app } = createTestServer();
    const optionsResponse = await withOrigin(
      agent.post("/api/v1/auth/register/options"),
    ).send({});
    expect(optionsResponse.status).toBe(403);

    const { verifyResponse } = await firstRegistration(agent);
    expect(verifyResponse.status).toBe(201);
    expect(repository.user).not.toBeNull();
    expect(repository.credentials).toHaveLength(1);
    expect(verifyResponse.body.data.recoveryCodes).toHaveLength(10);
    expect(verifyResponse.headers["set-cookie"]?.[0]).toContain("HttpOnly");
    expect(verifyResponse.headers["set-cookie"]?.[0]).toContain("SameSite=Lax");

    const secondSetup = await withOrigin(
      request(app)
        .post("/api/v1/auth/register/options")
        .set("X-Setup-Token", SETUP_TOKEN),
    ).send({});
    expect(secondSetup.status).toBe(409);
  });

  it("marks production session cookies Secure and scopes them to the host", async () => {
    const { agent } = createTestServer({ production: true });
    const { verifyResponse } = await firstRegistration(agent);
    const cookie = verifyResponse.headers["set-cookie"]?.[0] ?? "";
    expect(cookie).toContain("__Host-pfm_session=");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie.toLowerCase()).not.toContain("domain=");
  });

  it("expires and consumes each challenge once", async () => {
    let now = new Date("2026-11-24T00:00:00Z");
    const { agent, app } = createTestServer({ now: () => now });
    const optionsResponse = await withOrigin(
      agent.post("/api/v1/auth/register/options").set("X-Setup-Token", SETUP_TOKEN),
    ).send({});
    const challenge = optionsResponse.body.data.options.challenge as string;
    now = new Date(now.getTime() + 301_000);
    const expired = await withOrigin(agent.post("/api/v1/auth/register/verify")).send({
      challenge,
      credential: registrationCredential("expired"),
    });
    expect(expired.status).toBe(400);
    expect(expired.body.error.code).toBe("CHALLENGE_INVALID");

    now = new Date("2026-11-24T00:00:00Z");
    const { verifyResponse, challenge: freshChallenge } = await firstRegistration(
      agent,
      "valid",
    );
    expect(verifyResponse.status).toBe(201);
    const replay = await withOrigin(
      request(app).post("/api/v1/auth/register/verify"),
    ).send({ challenge: freshChallenge, credential: registrationCredential("replay") });
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe("CHALLENGE_INVALID");
  });

  it("logs in with a passkey and logs out using a CSRF token", async () => {
    const { agent } = createTestServer();
    await firstRegistration(agent);
    const loginOptions = await withOrigin(agent.post("/api/v1/auth/login/options")).send(
      {},
    );
    const challenge = loginOptions.body.data.options.challenge as string;
    const login = await withOrigin(agent.post("/api/v1/auth/login/verify")).send({
      challenge,
      credential: authenticationCredential("credential-1"),
    });
    expect(login.status).toBe(200);

    const session = await agent.get("/api/v1/auth/session");
    expect(session.status).toBe(200);
    expect(session.body.data.recoveryOnly).toBe(false);
    const logout = await withOrigin(agent.post("/api/v1/auth/logout"))
      .set("X-CSRF-Token", session.body.data.csrfToken)
      .send({});
    expect(logout.status).toBe(200);
    expect((await agent.get("/api/v1/auth/session")).status).toBe(401);
  });

  it("lists and revokes only owned devices and prevents removing the last one", async () => {
    const { agent, repository } = createTestServer();
    await firstRegistration(agent);
    repository.addForeignDevice("foreign-credential");
    const session = await agent.get("/api/v1/auth/session");
    const csrfToken = session.body.data.csrfToken as string;

    const options = await withOrigin(agent.post("/api/v1/auth/register/options"))
      .set("X-CSRF-Token", csrfToken)
      .send({});
    const challenge = options.body.data.options.challenge as string;
    const added = await withOrigin(agent.post("/api/v1/auth/register/verify"))
      .set("X-CSRF-Token", csrfToken)
      .send({ challenge, credential: registrationCredential("credential-2") });
    expect(added.status).toBe(201);

    const devices = await agent.get("/api/v1/auth/devices");
    expect(devices.body.data.devices).toHaveLength(2);
    expect(
      devices.body.data.devices.map((device: DeviceSummary) => device.deviceName),
    ).not.toContain("Other user device");

    const foreignDelete = await withOrigin(
      agent.delete("/api/v1/auth/devices/device-foreign-credential"),
    ).set("X-CSRF-Token", csrfToken);
    expect(foreignDelete.status).toBe(404);

    const removed = await withOrigin(
      agent.delete("/api/v1/auth/devices/device-credential-2"),
    ).set("X-CSRF-Token", csrfToken);
    expect(removed.status).toBe(200);
    const lastDevice = await withOrigin(
      agent.delete("/api/v1/auth/devices/device-credential-1"),
    ).set("X-CSRF-Token", csrfToken);
    expect(lastDevice.status).toBe(409);
  });

  it("uses recovery codes once, invalidates old sessions, and requires a replacement passkey", async () => {
    const { agent } = createTestServer();
    const { verifyResponse } = await firstRegistration(agent);
    const recoveryCode = verifyResponse.body.data.recoveryCodes[0] as string;
    const recovery = await withOrigin(agent.post("/api/v1/auth/recovery/verify")).send({
      code: recoveryCode,
    });
    expect(recovery.status).toBe(200);

    const session = await agent.get("/api/v1/auth/session");
    expect(session.body.data.recoveryOnly).toBe(true);
    const csrfToken = session.body.data.csrfToken as string;
    const options = await withOrigin(agent.post("/api/v1/auth/register/options"))
      .set("X-CSRF-Token", csrfToken)
      .send({});
    const challenge = options.body.data.options.challenge as string;
    const replacement = await withOrigin(agent.post("/api/v1/auth/register/verify"))
      .set("X-CSRF-Token", csrfToken)
      .send({ challenge, credential: registrationCredential("replacement") });
    expect(replacement.status).toBe(201);
    expect(replacement.body.data.recoveryCodes).toHaveLength(10);
    expect((await agent.get("/api/v1/auth/session")).body.data.recoveryOnly).toBe(false);

    const replay = await withOrigin(agent.post("/api/v1/auth/recovery/verify")).send({
      code: recoveryCode,
    });
    expect(replay.status).toBe(401);
  });
});
