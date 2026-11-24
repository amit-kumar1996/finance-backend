import { z } from "zod";

const dateString = z.iso.date();
const noteString = z.string().trim().max(500).nullable().optional();

export const createPersonSchema = z.object({
  name: z.string().trim().min(1).max(120),
  notes: noteString,
});

export const updatePersonSchema = createPersonSchema;

export const personMovementSchema = z.object({
  movement: z.enum(["GIVE", "RECEIVE", "BORROW", "REPAY"]),
  personId: z.string().min(1).max(30),
  effectiveDate: dateString,
  amount: z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,4})?$/),
  accountId: z.string().min(1).max(30),
  note: z.string().trim().max(250).optional(),
});
