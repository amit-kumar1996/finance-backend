import { z } from "zod";
import { financialAccountTypes } from "./accounts.types.js";

const amountString = z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,4})?$/);
const dateString = z.iso.date();

export const createAccountSchema = z.object({
  name: z.string().trim().min(1).max(100),
  accountType: z.enum(financialAccountTypes),
  institutionName: z.string().trim().max(100).nullable().optional(),
  openingBalance: amountString.default("0"),
  effectiveDate: dateString.optional(),
});

export const transferSchema = z.object({
  fromAccountId: z.string().min(1).max(30),
  toAccountId: z.string().min(1).max(30),
  effectiveDate: dateString,
  amount: amountString,
  description: z.string().trim().min(1).max(250),
});

export const expenseSchema = z.object({
  accountId: z.string().min(1).max(30),
  effectiveDate: dateString,
  amount: amountString,
  description: z.string().trim().min(1).max(250),
});

export const cardPurchaseSchema = expenseSchema.extend({
  creditCardAccountId: z.string().min(1).max(30),
});

export const cardPaymentSchema = z.object({
  creditCardAccountId: z.string().min(1).max(30),
  bankAccountId: z.string().min(1).max(30),
  effectiveDate: dateString,
  amount: amountString,
  description: z.string().trim().min(1).max(250),
});

export const reversalSchema = z.object({
  effectiveDate: dateString,
  reason: z.string().trim().min(1).max(250),
});
