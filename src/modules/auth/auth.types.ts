import type {
  AuthenticationResponseJSON,
  AuthenticatorTransport,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

export type ChallengePurpose = "REGISTRATION" | "AUTHENTICATION";

export interface StoredCredential {
  id: string;
  userId: string;
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: AuthenticatorTransport[];
  deviceName: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface StoredChallenge {
  id: string;
  challenge: string;
  purpose: ChallengePurpose;
  userId: string | null;
  userHandle: string | null;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface StoredSession {
  id: string;
  userId: string;
  tokenHash: string;
  recoveryOnly: boolean;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface CredentialInput {
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: AuthenticatorTransport[];
  deviceName: string;
}

export interface SessionInput {
  tokenHash: string;
  expiresAt: Date;
  recoveryOnly?: boolean;
}

export interface RecoveryCodeInput {
  codeHash: string;
}

export interface RegistrationOptionsResult {
  options: PublicKeyCredentialCreationOptionsJSON;
  isInitialSetup: boolean;
}

export interface AuthenticationOptionsResult {
  options: PublicKeyCredentialRequestOptionsJSON;
}

export interface SessionResult {
  userId: string;
  sessionToken: string;
  csrfToken: string;
  expiresAt: Date;
}

export interface RegistrationResult extends SessionResult {
  recoveryCodes?: string[];
}

export interface DeviceSummary {
  id: string;
  deviceName: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface WebAuthnVerifier {
  generateRegistrationOptions(input: {
    userId: string;
    userName: string;
    excludeCredentials: Array<{
      id: string;
      transports: AuthenticatorTransport[];
    }>;
  }): Promise<PublicKeyCredentialCreationOptionsJSON>;
  generateAuthenticationOptions(input: {
    allowCredentials: Array<{
      id: string;
      transports: AuthenticatorTransport[];
    }>;
  }): Promise<PublicKeyCredentialRequestOptionsJSON>;
  verifyRegistration(input: {
    response: RegistrationResponseJSON;
    expectedChallenge: string;
  }): Promise<{
    credentialId: string;
    publicKey: Uint8Array;
    counter: number;
    transports: AuthenticatorTransport[];
  } | null>;
  verifyAuthentication(input: {
    response: AuthenticationResponseJSON;
    credential: StoredCredential;
    expectedChallenge: string;
  }): Promise<{ newCounter: number } | null>;
}

export interface AuthRepository {
  findPrimaryUser(): Promise<{ id: string } | null>;
  listCredentials(userId: string): Promise<StoredCredential[]>;
  findCredential(credentialId: string): Promise<StoredCredential | null>;
  findDeviceOwner(deviceId: string): Promise<string | null>;
  createChallenge(input: {
    challenge: string;
    purpose: ChallengePurpose;
    userId?: string;
    userHandle?: string;
    expiresAt: Date;
  }): Promise<void>;
  findChallenge(
    challenge: string,
    purpose: ChallengePurpose,
  ): Promise<StoredChallenge | null>;
  consumeChallenge(id: string, now: Date): Promise<boolean>;
  createInitialUser(input: {
    userId: string;
    credential: CredentialInput;
    session: SessionInput;
    recoveryCodes: RecoveryCodeInput[];
  }): Promise<void>;
  createCredential(input: {
    userId: string;
    credential: CredentialInput;
    session?: SessionInput;
    rotateRecoveryCodes?: RecoveryCodeInput[];
  }): Promise<void>;
  createSession(userId: string, session: SessionInput): Promise<void>;
  findSession(tokenHash: string, now: Date): Promise<StoredSession | null>;
  revokeSession(tokenHash: string, now: Date): Promise<void>;
  listDevices(userId: string): Promise<DeviceSummary[]>;
  revokeDevice(
    userId: string,
    deviceId: string,
  ): Promise<"removed" | "last-device" | "not-found">;
  recoverWithCode(input: {
    userId: string;
    codeHash: string;
    session: SessionInput;
    now: Date;
  }): Promise<boolean>;
  updateCredentialAndCreateSession(input: {
    credentialId: string;
    newCounter: number;
    session: SessionInput;
    now: Date;
  }): Promise<string | null>;
}

export interface AuthConfig {
  rpId: string;
  rpName: string;
  webOrigin: string;
  setupToken: string | undefined;
  challengeTtlSeconds: number;
  sessionTtlHours: number;
}
