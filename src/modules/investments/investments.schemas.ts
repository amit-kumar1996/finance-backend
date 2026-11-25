import { z } from "zod";

const date = z.iso.date();
const money = z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,4})?$/);
const units = z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,8})?$/);
const price = z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,8})?$/);
const id = z.string().min(1).max(30);

export const createInvestmentSchema = z.object({
  investmentType: z.enum(["NPS", "MUTUAL_FUND", "STOCK", "FD", "PPF", "EPF"]),
  name: z.string().trim().min(1).max(160),
  provider: z.string().trim().max(120).optional().default(""),
  symbol: z.string().trim().max(32).optional().default(""),
  annualRate: z
    .string()
    .regex(/^(?:0|[1-9]\d?)(?:\.\d{1,4})?$/)
    .optional(),
  maturityDate: date.nullable().optional(),
});

export const tradeSchema = z.object({
  effectiveDate: date,
  accountId: id,
  units,
  unitPrice: price,
  note: z.string().trim().max(250).optional().default(""),
});

export const contributionSchema = z.object({
  effectiveDate: date,
  accountId: id,
  amount: money,
  note: z.string().trim().max(250).optional().default(""),
});

export const manualPriceSchema = z.object({
  effectiveDate: date,
  unitPrice: price,
});

export const manualValuationSchema = z.object({
  effectiveDate: date,
  currentValue: money,
});

export const investmentQuerySchema = z.object({
  type: z.enum(["NPS", "MUTUAL_FUND", "STOCK", "FD", "PPF", "EPF"]).optional(),
});
