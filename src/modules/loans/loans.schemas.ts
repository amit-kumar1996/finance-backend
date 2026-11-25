import { z } from "zod";

const date = z.iso.date();
const amount = z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,4})?$/);
const id = z.string().min(1).max(30);

export const createLoanSchema = z.object({
  name: z.string().trim().min(1).max(120),
  provider: z.string().trim().min(1).max(120),
  principal: amount,
  annualRate: z.string().regex(/^(?:0|[1-9]\d?)(?:\.\d{1,4})?$/),
  termMonths: z.number().int().min(1).max(600),
  dueDay: z.number().int().min(1).max(31),
  startDate: date,
  setupMode: z.enum(["DISBURSEMENT", "EXISTING_BALANCE"]),
  fundingAccountId: id.nullable().optional(),
});

export const loanPaymentSchema = z.object({
  effectiveDate: date,
  accountId: id,
  amount,
  principalAmount: amount,
  interestAmount: amount,
  countsAsEmi: z.boolean().default(true),
  note: z.string().trim().max(250).optional().default(""),
});

export const loanPrepaymentSchema = z.object({
  effectiveDate: date,
  accountId: id,
  amount,
  note: z.string().trim().max(250).optional().default(""),
});
