import { z } from "zod";

export const syncPushSchema = z.object({
  mutations: z
    .array(
      z.object({
        clientId: z.uuid(),
        method: z.enum(["POST", "PUT"]),
        path: z
          .string()
          .regex(
            /^\/(?:expenses|transfers|ledger\/expenses|ledger\/credit-card-purchases|ledger\/credit-card-payments|people\/transactions|loans\/[A-Za-z0-9_-]{1,30}\/(?:payments|prepayments)|investments\/[A-Za-z0-9_-]{1,30}\/(?:buys|sells|contributions|withdrawals|price|valuation))$/,
          ),
        payload: z.record(z.string(), z.unknown()),
      }),
    )
    .min(1)
    .max(50),
});

export const syncPullSchema = z.object({
  cursor: z.string().max(256).optional(),
});

export type SyncMutation = z.infer<typeof syncPushSchema>["mutations"][number];
