import { z } from "zod";

const dateString = z.iso.date();

export const expenseFormSchema = z.object({
  effectiveDate: dateString,
  description: z.string().trim().min(1).max(250),
  amount: z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,4})?$/),
  accountId: z.string().min(1).max(30).optional(),
});

export const expenseQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  from: dateString.optional(),
  to: dateString.optional(),
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
});

export const expenseSummaryQuerySchema = z.object({
  date: dateString,
});
