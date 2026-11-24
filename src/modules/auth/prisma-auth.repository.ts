import { createHash } from "node:crypto";
import type { PrismaClient } from "../../generated/prisma/client.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { AuthenticatorTransport } from "@simplewebauthn/server";
import type {
  AuthRepository,
  CredentialInput,
  DeviceSummary,
  RecoveryCodeInput,
  SessionInput,
  StoredChallenge,
  StoredCredential,
  StoredSession,
} from "./auth.types.js";

const toCredential = (row: {
  id: string;
  userId: string;
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: unknown;
  deviceName: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}): StoredCredential => ({
  ...row,
  transports: Array.isArray(row.transports)
    ? (row.transports.filter(
        (value): value is string => typeof value === "string",
      ) as AuthenticatorTransport[])
    : [],
});

const toSessionData = (session: SessionInput) => ({
  tokenHash: session.tokenHash,
  expiresAt: session.expiresAt,
  recoveryOnly: session.recoveryOnly ?? false,
});

const credentialData = (credential: CredentialInput) => ({
  credentialId: credential.credentialId,
  credentialIdHash: createHash("sha256").update(credential.credentialId).digest("hex"),
  publicKey: Buffer.from(credential.publicKey),
  counter: credential.counter,
  transports: credential.transports as Prisma.InputJsonValue,
  deviceName: credential.deviceName,
});

export class PrismaAuthRepository implements AuthRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findPrimaryUser(): Promise<{ id: string } | null> {
    return this.prisma.user.findUnique({
      where: { singleton: true },
      select: { id: true },
    });
  }

  async listCredentials(userId: string): Promise<StoredCredential[]> {
    const rows = await this.prisma.webAuthnCredential.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toCredential);
  }

  async findCredential(credentialId: string): Promise<StoredCredential | null> {
    const row = await this.prisma.webAuthnCredential.findUnique({
      where: {
        credentialIdHash: createHash("sha256").update(credentialId).digest("hex"),
      },
    });
    return row ? toCredential(row) : null;
  }

  async findDeviceOwner(deviceId: string): Promise<string | null> {
    const row = await this.prisma.webAuthnCredential.findUnique({
      where: { id: deviceId },
      select: { userId: true },
    });
    return row?.userId ?? null;
  }

  async createChallenge(input: {
    challenge: string;
    purpose: "REGISTRATION" | "AUTHENTICATION";
    userId?: string;
    userHandle?: string;
    expiresAt: Date;
  }): Promise<void> {
    await this.prisma.authChallenge.create({ data: input });
  }

  async findChallenge(
    challenge: string,
    purpose: "REGISTRATION" | "AUTHENTICATION",
  ): Promise<StoredChallenge | null> {
    return this.prisma.authChallenge.findUnique({
      where: { challenge, purpose },
      select: {
        id: true,
        challenge: true,
        purpose: true,
        userId: true,
        userHandle: true,
        expiresAt: true,
        consumedAt: true,
      },
    });
  }

  async consumeChallenge(id: string, now: Date): Promise<boolean> {
    const result = await this.prisma.authChallenge.updateMany({
      where: { id, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    return result.count === 1;
  }

  async createInitialUser(input: {
    userId: string;
    credential: CredentialInput;
    session: SessionInput;
    recoveryCodes: RecoveryCodeInput[];
  }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.user.create({ data: { id: input.userId } });
      await tx.webAuthnCredential.create({
        data: { userId: input.userId, ...credentialData(input.credential) },
      });
      await tx.authSession.create({
        data: { userId: input.userId, ...toSessionData(input.session) },
      });
      await tx.recoveryCode.createMany({
        data: input.recoveryCodes.map((recoveryCode) => ({
          userId: input.userId,
          ...recoveryCode,
        })),
      });
    });
  }

  async createCredential(input: {
    userId: string;
    credential: CredentialInput;
    session?: SessionInput;
    rotateRecoveryCodes?: RecoveryCodeInput[];
  }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.webAuthnCredential.create({
        data: { userId: input.userId, ...credentialData(input.credential) },
      });
      if (input.session) {
        const upgraded = await tx.authSession.updateMany({
          where: {
            userId: input.userId,
            tokenHash: input.session.tokenHash,
            recoveryOnly: true,
            revokedAt: null,
          },
          data: {
            recoveryOnly: false,
            expiresAt: input.session.expiresAt,
          },
        });
        if (upgraded.count !== 1) {
          throw new Error("Recovery session is no longer valid");
        }
        await tx.recoveryCode.deleteMany({ where: { userId: input.userId } });
        await tx.recoveryCode.createMany({
          data: (input.rotateRecoveryCodes ?? []).map((recoveryCode) => ({
            userId: input.userId,
            ...recoveryCode,
          })),
        });
      }
    });
  }

  async createSession(userId: string, session: SessionInput): Promise<void> {
    await this.prisma.authSession.create({ data: { userId, ...toSessionData(session) } });
  }

  async findSession(tokenHash: string, now: Date): Promise<StoredSession | null> {
    return this.prisma.authSession.findFirst({
      where: { tokenHash, revokedAt: null, expiresAt: { gt: now } },
      select: {
        id: true,
        userId: true,
        tokenHash: true,
        recoveryOnly: true,
        expiresAt: true,
        revokedAt: true,
      },
    });
  }

  async revokeSession(tokenHash: string, now: Date): Promise<void> {
    await this.prisma.authSession.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  async listDevices(userId: string): Promise<DeviceSummary[]> {
    return this.prisma.webAuthnCredential
      .findMany({
        where: { userId },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          deviceName: true,
          createdAt: true,
          lastUsedAt: true,
        },
      })
      .then((rows) =>
        rows.map((row) => ({
          ...row,
          deviceName: row.deviceName ?? "Passkey",
        })),
      );
  }

  async revokeDevice(
    userId: string,
    deviceId: string,
  ): Promise<"removed" | "last-device" | "not-found"> {
    return this.prisma.$transaction(async (tx) => {
      const device = await tx.webAuthnCredential.findFirst({
        where: { id: deviceId, userId },
        select: { id: true },
      });
      if (!device) return "not-found";
      const count = await tx.webAuthnCredential.count({ where: { userId } });
      if (count <= 1) return "last-device";
      await tx.webAuthnCredential.delete({ where: { id: device.id } });
      return "removed";
    });
  }

  async recoverWithCode(input: {
    userId: string;
    codeHash: string;
    session: SessionInput;
    now: Date;
  }): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.recoveryCode.updateMany({
        where: {
          userId: input.userId,
          codeHash: input.codeHash,
          usedAt: null,
        },
        data: { usedAt: input.now },
      });
      if (claimed.count !== 1) return false;
      await tx.authSession.updateMany({
        where: { userId: input.userId, revokedAt: null },
        data: { revokedAt: input.now },
      });
      await tx.webAuthnCredential.deleteMany({
        where: { userId: input.userId },
      });
      await tx.authSession.create({
        data: {
          userId: input.userId,
          ...toSessionData(input.session),
          recoveryOnly: true,
        },
      });
      return true;
    });
  }

  async updateCredentialAndCreateSession(input: {
    credentialId: string;
    newCounter: number;
    session: SessionInput;
    now: Date;
  }): Promise<string | null> {
    return this.prisma.$transaction(async (tx) => {
      const credential = await tx.webAuthnCredential.findUnique({
        where: {
          credentialIdHash: createHash("sha256").update(input.credentialId).digest("hex"),
        },
        select: { id: true, userId: true },
      });
      if (!credential) return null;
      await tx.webAuthnCredential.update({
        where: { id: credential.id },
        data: { counter: input.newCounter, lastUsedAt: input.now },
      });
      await tx.authSession.create({
        data: { userId: credential.userId, ...toSessionData(input.session) },
      });
      return credential.userId;
    });
  }
}
