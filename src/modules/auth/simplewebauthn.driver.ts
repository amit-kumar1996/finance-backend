import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticatorTransport,
} from "@simplewebauthn/server";
import type { AuthConfig, StoredCredential, WebAuthnVerifier } from "./auth.types.js";

export class SimpleWebAuthnDriver implements WebAuthnVerifier {
  constructor(private readonly config: AuthConfig) {}

  generateRegistrationOptions(input: {
    userId: string;
    userName: string;
    excludeCredentials: Array<{
      id: string;
      transports: AuthenticatorTransport[];
    }>;
  }) {
    return generateRegistrationOptions({
      rpName: this.config.rpName,
      rpID: this.config.rpId,
      userID: new TextEncoder().encode(input.userId),
      userName: input.userName,
      userDisplayName: "Personal Finance Manager",
      attestationType: "none",
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
      excludeCredentials: input.excludeCredentials,
    });
  }

  generateAuthenticationOptions(input: {
    allowCredentials: Array<{
      id: string;
      transports: AuthenticatorTransport[];
    }>;
  }) {
    return generateAuthenticationOptions({
      rpID: this.config.rpId,
      userVerification: "required",
      allowCredentials: input.allowCredentials,
    });
  }

  async verifyRegistration(input: Parameters<WebAuthnVerifier["verifyRegistration"]>[0]) {
    const result = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: this.config.webOrigin,
      expectedRPID: this.config.rpId,
      requireUserVerification: true,
    });
    if (!result.verified) return null;
    return {
      credentialId: result.registrationInfo.credential.id,
      publicKey: result.registrationInfo.credential.publicKey,
      counter: result.registrationInfo.credential.counter,
      transports: (result.registrationInfo.credential.transports ??
        []) as AuthenticatorTransport[],
    };
  }

  async verifyAuthentication(input: {
    response: Parameters<WebAuthnVerifier["verifyAuthentication"]>[0]["response"];
    credential: StoredCredential;
    expectedChallenge: string;
  }) {
    const result = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: this.config.webOrigin,
      expectedRPID: this.config.rpId,
      requireUserVerification: true,
      credential: {
        id: input.credential.credentialId,
        publicKey: Uint8Array.from(input.credential.publicKey),
        counter: input.credential.counter,
        transports: input.credential.transports,
      },
    });
    return result.verified ? { newCounter: result.authenticationInfo.newCounter } : null;
  }
}
