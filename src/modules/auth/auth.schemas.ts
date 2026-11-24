import { z } from "zod";

const base64Url = z.string().min(1).max(32_768);

const registrationResponse = z
  .object({
    id: base64Url,
    rawId: base64Url,
    type: z.literal("public-key"),
    response: z
      .object({
        clientDataJSON: base64Url,
        attestationObject: base64Url,
        transports: z.array(z.string()).optional(),
      })
      .passthrough(),
    clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
    authenticatorAttachment: z.string().nullable().optional(),
  })
  .passthrough();

const authenticationResponse = z
  .object({
    id: base64Url,
    rawId: base64Url,
    type: z.literal("public-key"),
    response: z
      .object({
        clientDataJSON: base64Url,
        authenticatorData: base64Url,
        signature: base64Url,
        userHandle: base64Url.nullable().optional(),
      })
      .passthrough(),
    clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
    authenticatorAttachment: z.string().nullable().optional(),
  })
  .passthrough();

export const registrationOptionsSchema = z.object({}).strict();
export const registrationVerifySchema = z.object({
  challenge: base64Url,
  credential: registrationResponse,
  deviceName: z.string().trim().max(100).optional(),
});
export const authenticationOptionsSchema = z.object({}).strict();
export const authenticationVerifySchema = z.object({
  challenge: base64Url,
  credential: authenticationResponse,
});
export const recoverySchema = z.object({
  code: z.string().trim().min(20).max(80),
});

export type RegistrationVerifyBody = z.infer<typeof registrationVerifySchema>;
export type AuthenticationVerifyBody = z.infer<typeof authenticationVerifySchema>;
