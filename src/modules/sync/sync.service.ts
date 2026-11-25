import { Buffer } from "node:buffer";
import { HttpError } from "../../lib/http-error.js";
import { ZodError } from "zod";
import type { ExpensesService } from "../expenses/expenses.service.js";
import type { AccountsService } from "../accounts/accounts.service.js";
import type { PeopleService } from "../people/people.service.js";
import type { LoansService } from "../loans/loans.service.js";
import type { InvestmentsService } from "../investments/investments.service.js";
import { expenseFormSchema } from "../expenses/expenses.schemas.js";
import {
  cardPaymentSchema,
  cardPurchaseSchema,
  expenseSchema,
  transferSchema,
} from "../accounts/accounts.schemas.js";
import { personMovementSchema } from "../people/people.schemas.js";
import { loanPaymentSchema, loanPrepaymentSchema } from "../loans/loans.schemas.js";
import {
  contributionSchema,
  manualPriceSchema,
  manualValuationSchema,
  tradeSchema,
} from "../investments/investments.schemas.js";
import type { SyncMutation } from "./sync.schemas.js";

export interface SyncRepository {
  listTransactions(
    userId: string,
    cursor: string | undefined,
  ): Promise<{ changes: unknown[]; cursor: string | null; hasMore: boolean }>;
}

export class SyncService {
  constructor(
    private readonly repository: SyncRepository,
    private readonly expenses: ExpensesService,
    private readonly accounts: AccountsService,
    private readonly people: PeopleService,
    private readonly loans: LoansService,
    private readonly investments: InvestmentsService,
  ) {}

  async push(userId: string, mutations: SyncMutation[]) {
    const results = [];
    for (const mutation of mutations) {
      try {
        const result = await this.replay(userId, mutation);
        const record = result as
          { transaction?: { id?: string }; id?: string } | undefined;
        results.push({
          clientId: mutation.clientId,
          status: "accepted",
          ...(record?.transaction?.id || record?.id
            ? { transactionId: record.transaction?.id ?? record.id }
            : {}),
        });
      } catch (error) {
        if (!(error instanceof HttpError) && !(error instanceof ZodError)) throw error;
        const status = error instanceof HttpError ? error.status : 400;
        results.push({
          clientId: mutation.clientId,
          status: status >= 400 && status < 500 ? "conflict" : "retry",
          code: error instanceof HttpError ? error.code : "SYNC_PAYLOAD_INVALID",
          message:
            error instanceof HttpError
              ? error.message
              : "The queued data no longer matches the current transaction rules.",
        });
      }
    }
    return { results };
  }

  pull(userId: string, cursor?: string) {
    return this.repository.listTransactions(userId, cursor);
  }

  private async replay(userId: string, mutation: SyncMutation): Promise<unknown> {
    const key = `offline:${mutation.clientId}`;
    const path = mutation.path;
    const payload = mutation.payload;
    if (mutation.method === "POST" && path === "/expenses")
      return this.expenses.createExpense(userId, key, expenseFormSchema.parse(payload));
    if (mutation.method === "POST" && path === "/transfers")
      return {
        transaction: await this.accounts.transfer(
          userId,
          key,
          transferSchema.parse(payload),
        ),
      };
    if (mutation.method === "POST" && path === "/ledger/expenses")
      return {
        transaction: await this.accounts.expense(
          userId,
          key,
          expenseSchema.parse(payload),
        ),
      };
    if (mutation.method === "POST" && path === "/ledger/credit-card-purchases")
      return {
        transaction: await this.accounts.cardPurchase(
          userId,
          key,
          cardPurchaseSchema.parse(payload),
        ),
      };
    if (mutation.method === "POST" && path === "/ledger/credit-card-payments")
      return {
        transaction: await this.accounts.cardPayment(
          userId,
          key,
          cardPaymentSchema.parse(payload),
        ),
      };
    if (mutation.method === "POST" && path === "/people/transactions") {
      const input = personMovementSchema.parse(payload);
      return this.people.postMovement({
        userId,
        idempotencyKey: key,
        movement: input.movement,
        personId: input.personId,
        effectiveDate: input.effectiveDate,
        amount: input.amount,
        accountId: input.accountId,
        ...(input.note ? { note: input.note } : {}),
      });
    }
    const loan = /^\/loans\/([A-Za-z0-9_-]{1,30})\/(payments|prepayments)$/.exec(path);
    if (mutation.method === "POST" && loan) {
      const loanId = loan[1]!;
      if (loan[2] === "payments")
        return this.loans.payment(userId, loanId, key, loanPaymentSchema.parse(payload));
      return this.loans.prepayment(
        userId,
        loanId,
        key,
        loanPrepaymentSchema.parse(payload),
      );
    }
    const investment =
      /^\/investments\/([A-Za-z0-9_-]{1,30})\/(buys|sells|contributions|withdrawals|price|valuation)$/.exec(
        path,
      );
    if (investment) {
      const investmentId = investment[1]!;
      const action = investment[2]!;
      if (mutation.method === "POST" && (action === "buys" || action === "sells"))
        return this.investments.trade(
          userId,
          investmentId,
          key,
          action === "buys" ? "BUY" : "SELL",
          tradeSchema.parse(payload),
        );
      if (
        mutation.method === "POST" &&
        (action === "contributions" || action === "withdrawals")
      )
        return this.investments.cashActivity(
          userId,
          investmentId,
          key,
          action === "contributions" ? "CONTRIBUTION" : "WITHDRAWAL",
          contributionSchema.parse(payload),
        );
      if (mutation.method === "PUT" && action === "price")
        return this.investments.updatePrice(userId, investmentId, key, {
          ...manualPriceSchema.parse(payload),
          source: "MANUAL",
        });
      if (mutation.method === "PUT" && action === "valuation")
        return this.investments.updateValuation(
          userId,
          investmentId,
          key,
          manualValuationSchema.parse(payload),
        );
    }
    throw new HttpError(
      400,
      "SYNC_OPERATION_UNSUPPORTED",
      "This offline operation is not supported.",
    );
  }
}

export const encodeSyncCursor = (createdAt: Date, id: string): string =>
  Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), id })).toString(
    "base64url",
  );

export const decodeSyncCursor = (cursor: string | undefined) => {
  if (!cursor) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "createdAt" in parsed &&
      "id" in parsed &&
      typeof parsed.createdAt === "string" &&
      typeof parsed.id === "string" &&
      !Number.isNaN(Date.parse(parsed.createdAt))
    )
      return { createdAt: new Date(parsed.createdAt), id: parsed.id };
  } catch {
    // A malformed cursor is rejected below.
  }
  throw new HttpError(400, "SYNC_CURSOR_INVALID", "The sync cursor is invalid.");
};
