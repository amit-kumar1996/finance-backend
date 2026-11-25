import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { HttpError } from "../../lib/http-error.js";
import { buildEmiEntries } from "./loans.math.js";
import type { LoansRepository, LoanRecord } from "./loans.types.js";

const dateOnly = (date: Date): string => date.toISOString().slice(0, 10);
const isUniqueConstraintError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "P2002";

export class PrismaLoansRepository implements LoansRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listLoans(userId: string): Promise<LoanRecord[]> {
    const rows = await this.prisma.loan.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
    });
    return Promise.all(rows.map((row) => this.mapLoan(userId, row)));
  }

  async findLoan(userId: string, loanId: string): Promise<LoanRecord | null> {
    const row = await this.prisma.loan.findFirst({ where: { id: loanId, userId } });
    return row ? this.mapLoan(userId, row) : null;
  }

  async createLoan(input: Parameters<LoansRepository["createLoan"]>[0]): Promise<string> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const prior = await tx.loan.findFirst({
            where: { userId: input.userId, idempotencyKey: input.idempotencyKey },
          });
          if (prior) {
            if (prior.requestHash !== input.requestHash) throw this.idempotencyError();
            return prior.id;
          }
          let account: { id: string; ledgerAccountId: string } | null = null;
          if (input.setupMode === "DISBURSEMENT") {
            account = await tx.financialAccount.findFirst({
              where: {
                id: input.fundingAccountId ?? "",
                userId: input.userId,
                accountType: { in: ["BANK", "CASH", "UPI"] },
              },
              select: { id: true, ledgerAccountId: true },
            });
            if (!account)
              throw new HttpError(
                404,
                "FUNDING_ACCOUNT_NOT_FOUND",
                "The receiving account was not found.",
              );
          }
          const loanCode = `LOAN_${randomUUID().replaceAll("-", "")}`;
          const liability = await tx.ledgerAccount.create({
            data: {
              userId: input.userId,
              code: loanCode,
              name: `${input.loan.name} liability`,
              category: "LIABILITY",
              normalBalance: "CREDIT",
            },
            select: { id: true },
          });
          const loan = await tx.loan.create({
            data: {
              userId: input.userId,
              name: input.loan.name,
              provider: input.loan.provider,
              principal: new Prisma.Decimal(input.loan.principal),
              annualRate: new Prisma.Decimal(input.loan.annualRate),
              termMonths: input.loan.termMonths,
              emiAmount: new Prisma.Decimal(input.loan.emiAmount),
              dueDay: input.loan.dueDay,
              startDate: new Date(`${input.loan.startDate}T00:00:00.000Z`),
              liabilityAccountId: liability.id,
              idempotencyKey: input.idempotencyKey,
              requestHash: input.requestHash,
            },
            select: { id: true },
          });
          const contraId =
            account?.ledgerAccountId ??
            (
              await tx.ledgerAccount.upsert({
                where: {
                  userId_code: { userId: input.userId, code: "SYS_OPENING_EQUITY" },
                },
                create: {
                  userId: input.userId,
                  code: "SYS_OPENING_EQUITY",
                  name: "Opening balance equity",
                  category: "EQUITY",
                  normalBalance: "CREDIT",
                  isSystem: true,
                },
                update: {},
                select: { id: true },
              })
            ).id;
          const source =
            input.setupMode === "DISBURSEMENT"
              ? "LOAN_DISBURSEMENT"
              : "LOAN_OPENING_BALANCE";
          const entries =
            input.setupMode === "DISBURSEMENT"
              ? [
                  {
                    ledgerAccountId: account!.ledgerAccountId,
                    debitAmount: input.loan.principal,
                    creditAmount: "0.00",
                  },
                  {
                    ledgerAccountId: liability.id,
                    debitAmount: "0.00",
                    creditAmount: input.loan.principal,
                  },
                ]
              : [
                  {
                    ledgerAccountId: contraId,
                    debitAmount: input.loan.principal,
                    creditAmount: "0.00",
                  },
                  {
                    ledgerAccountId: liability.id,
                    debitAmount: "0.00",
                    creditAmount: input.loan.principal,
                  },
                ];
          await this.writeLedger(tx, {
            userId: input.userId,
            loanId: loan.id,
            effectiveDate: input.loan.startDate,
            description: `${input.loan.name} ${input.setupMode === "DISBURSEMENT" ? "disbursement" : "opening balance"}`,
            source,
            idempotencyKey: `LOAN_OPEN_${createHash("sha256").update(`${input.userId}:${input.idempotencyKey}`).digest("hex").slice(0, 40)}`,
            requestHash: input.requestHash,
            entries,
          });
          await tx.auditLog.create({
            data: {
              userId: input.userId,
              entityType: "LOAN",
              entityId: loan.id,
              action: "LOAN_CREATED",
              changes: {
                ...input.loan,
                setupMode: input.setupMode,
                fundingAccountId: input.fundingAccountId,
              },
            },
          });
          return loan.id;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      );
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const raced = await this.prisma.loan.findFirst({
        where: { userId: input.userId, idempotencyKey: input.idempotencyKey },
      });
      if (!raced) throw error;
      if (raced.requestHash !== input.requestHash) throw this.idempotencyError();
      return raced.id;
    }
  }

  async postPayment(input: Parameters<LoansRepository["postPayment"]>[0]): Promise<void> {
    try {
      await this.prisma.$transaction(
        async (tx) => {
          const duplicate = await this.existingWrite(
            tx,
            input.userId,
            input.idempotencyKey,
            input.requestHash,
          );
          if (duplicate) return;
          const { loan, account, outstanding, currentFunds } =
            await this.lockLoanAndAccount(
              tx,
              input.userId,
              input.loanId,
              input.accountId,
            );
          if (new Prisma.Decimal(input.principalAmount).gt(outstanding))
            throw new HttpError(
              409,
              "PRINCIPAL_EXCEEDS_BALANCE",
              "Principal paid cannot exceed the outstanding balance.",
            );
          if (new Prisma.Decimal(input.amount).gt(currentFunds))
            throw new HttpError(
              409,
              "INSUFFICIENT_FUNDS",
              "The selected account does not have enough balance for this payment.",
            );
          const expenseAccountId = await this.systemExpenseId(tx, input.userId);
          const entries = buildEmiEntries({
            liabilityAccountId: loan.liabilityAccountId,
            expenseAccountId,
            bankAccountId: account.ledgerAccountId,
            principalAmount: input.principalAmount,
            interestAmount: input.interestAmount,
          });
          await this.writeLedger(tx, {
            ...input,
            loanId: loan.id,
            source: "LOAN_EMI_PAYMENT",
            description: input.description,
            entries,
          });
          await this.refreshStatus(tx, loan.id, outstanding.minus(input.principalAmount));
          await tx.auditLog.create({
            data: {
              userId: input.userId,
              entityType: "LOAN",
              entityId: loan.id,
              action: "LOAN_EMI_PAID",
              changes: {
                amount: input.amount,
                principalAmount: input.principalAmount,
                interestAmount: input.interestAmount,
                effectiveDate: input.effectiveDate,
              },
            },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      );
    } catch (error) {
      await this.resolveDuplicateWrite(
        error,
        input.userId,
        input.idempotencyKey,
        input.requestHash,
      );
    }
  }

  async postPrepayment(
    input: Parameters<LoansRepository["postPrepayment"]>[0],
  ): Promise<void> {
    try {
      await this.prisma.$transaction(
        async (tx) => {
          const duplicate = await this.existingWrite(
            tx,
            input.userId,
            input.idempotencyKey,
            input.requestHash,
          );
          if (duplicate) return;
          const { loan, account, outstanding, currentFunds } =
            await this.lockLoanAndAccount(
              tx,
              input.userId,
              input.loanId,
              input.accountId,
            );
          const amount = new Prisma.Decimal(input.amount);
          if (amount.gt(outstanding))
            throw new HttpError(
              409,
              "PREPAYMENT_EXCEEDS_BALANCE",
              "Prepayment cannot exceed the outstanding loan balance.",
            );
          if (amount.gt(currentFunds))
            throw new HttpError(
              409,
              "INSUFFICIENT_FUNDS",
              "The selected account does not have enough balance for this prepayment.",
            );
          await this.writeLedger(tx, {
            ...input,
            loanId: loan.id,
            source: "LOAN_PREPAYMENT",
            description: input.description,
            entries: [
              {
                ledgerAccountId: loan.liabilityAccountId,
                debitAmount: input.amount,
                creditAmount: "0.00",
              },
              {
                ledgerAccountId: account.ledgerAccountId,
                debitAmount: "0.00",
                creditAmount: input.amount,
              },
            ],
          });
          await this.refreshStatus(tx, loan.id, outstanding.minus(amount));
          await tx.auditLog.create({
            data: {
              userId: input.userId,
              entityType: "LOAN",
              entityId: loan.id,
              action: "LOAN_PREPAID",
              changes: { amount: input.amount, effectiveDate: input.effectiveDate },
            },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      );
    } catch (error) {
      await this.resolveDuplicateWrite(
        error,
        input.userId,
        input.idempotencyKey,
        input.requestHash,
      );
    }
  }

  private async mapLoan(
    userId: string,
    row: {
      id: string;
      name: string;
      provider: string;
      principal: Prisma.Decimal;
      annualRate: Prisma.Decimal;
      termMonths: number;
      emiAmount: Prisma.Decimal;
      dueDay: number;
      startDate: Date;
      status: "ACTIVE" | "CLOSED";
      liabilityAccountId: string;
    },
  ): Promise<LoanRecord> {
    const [totals, paymentCount] = await Promise.all([
      this.prisma.transactionEntry.aggregate({
        where: { ledgerAccountId: row.liabilityAccountId },
        _sum: { debitAmount: true, creditAmount: true },
      }),
      this.prisma.ledgerTransaction.count({
        where: { userId, loanId: row.id, source: "LOAN_EMI_PAYMENT", countsAsEmi: true },
      }),
    ]);
    const outstanding = (totals._sum.creditAmount ?? new Prisma.Decimal(0))
      .minus(totals._sum.debitAmount ?? new Prisma.Decimal(0))
      .toDecimalPlaces(2);
    return {
      id: row.id,
      name: row.name,
      provider: row.provider,
      principal: row.principal.toFixed(2),
      annualRate: row.annualRate.toFixed(4),
      termMonths: row.termMonths,
      emiAmount: row.emiAmount.toFixed(2),
      dueDay: row.dueDay,
      startDate: dateOnly(row.startDate),
      status: outstanding.isZero() ? "CLOSED" : row.status,
      outstanding: outstanding.toFixed(2),
      paymentCount,
    };
  }

  private async existingWrite(
    tx: Prisma.TransactionClient,
    userId: string,
    key: string,
    hash: string,
  ) {
    const existing = await tx.ledgerTransaction.findFirst({
      where: { userId, idempotencyKey: key },
    });
    if (existing && existing.requestHash !== hash) throw this.idempotencyError();
    return existing;
  }

  private async lockLoanAndAccount(
    tx: Prisma.TransactionClient,
    userId: string,
    loanId: string,
    accountId: string,
  ) {
    const loan = await tx.loan.findFirst({ where: { id: loanId, userId } });
    if (!loan) throw new HttpError(404, "LOAN_NOT_FOUND", "The loan was not found.");
    const account = await tx.financialAccount.findFirst({
      where: { id: accountId, userId, accountType: { in: ["BANK", "CASH", "UPI"] } },
      select: { id: true, ledgerAccountId: true },
    });
    if (!account)
      throw new HttpError(
        404,
        "PAYMENT_ACCOUNT_NOT_FOUND",
        "Choose an owned bank, cash, or UPI account.",
      );
    const ids = [loan.liabilityAccountId, account.ledgerAccountId].sort();
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM ledger_accounts WHERE user_id = ${userId} AND id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`,
    );
    const totals = await tx.transactionEntry.aggregate({
      where: { ledgerAccountId: loan.liabilityAccountId },
      _sum: { debitAmount: true, creditAmount: true },
    });
    const outstanding = (totals._sum.creditAmount ?? new Prisma.Decimal(0)).minus(
      totals._sum.debitAmount ?? new Prisma.Decimal(0),
    );
    const bankTotals = await tx.transactionEntry.aggregate({
      where: { ledgerAccountId: account.ledgerAccountId },
      _sum: { debitAmount: true, creditAmount: true },
    });
    const currentFunds = (bankTotals._sum.debitAmount ?? new Prisma.Decimal(0)).minus(
      bankTotals._sum.creditAmount ?? new Prisma.Decimal(0),
    );
    if (outstanding.lte(0))
      throw new HttpError(409, "LOAN_CLOSED", "This loan has no outstanding balance.");
    return { loan, account, outstanding, currentFunds };
  }

  private async systemExpenseId(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<string> {
    const result = await tx.ledgerAccount.upsert({
      where: { userId_code: { userId, code: "SYS_GENERAL_EXPENSE" } },
      create: {
        userId,
        code: "SYS_GENERAL_EXPENSE",
        name: "General expenses",
        category: "EXPENSE",
        normalBalance: "DEBIT",
        isSystem: true,
      },
      update: {},
      select: { id: true },
    });
    return result.id;
  }

  private async refreshStatus(
    tx: Prisma.TransactionClient,
    loanId: string,
    outstanding: Prisma.Decimal,
  ) {
    if (outstanding.isZero())
      await tx.loan.update({ where: { id: loanId }, data: { status: "CLOSED" } });
  }

  private async writeLedger(
    tx: Prisma.TransactionClient,
    input: {
      userId: string;
      loanId: string;
      effectiveDate: string;
      description: string;
      source:
        | "LOAN_DISBURSEMENT"
        | "LOAN_OPENING_BALANCE"
        | "LOAN_EMI_PAYMENT"
        | "LOAN_PREPAYMENT";
      idempotencyKey: string;
      requestHash: string;
      entries: Array<{
        ledgerAccountId: string;
        debitAmount: string;
        creditAmount: string;
      }>;
      countsAsEmi?: boolean;
    },
  ) {
    const debits = input.entries.reduce(
      (total, entry) => total.plus(entry.debitAmount),
      new Prisma.Decimal(0),
    );
    const credits = input.entries.reduce(
      (total, entry) => total.plus(entry.creditAmount),
      new Prisma.Decimal(0),
    );
    if (!debits.equals(credits) || debits.isZero())
      throw new HttpError(
        422,
        "LEDGER_UNBALANCED",
        "Loan entry must balance before posting.",
      );
    const transaction = await tx.ledgerTransaction.create({
      data: {
        userId: input.userId,
        loanId: input.loanId,
        effectiveDate: new Date(`${input.effectiveDate}T00:00:00.000Z`),
        description: input.description,
        source: input.source,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        ...(input.countsAsEmi === undefined ? {} : { countsAsEmi: input.countsAsEmi }),
        entries: {
          create: input.entries.map((entry) => ({
            ledgerAccountId: entry.ledgerAccountId,
            debitAmount: new Prisma.Decimal(entry.debitAmount),
            creditAmount: new Prisma.Decimal(entry.creditAmount),
          })),
        },
      },
      select: { id: true },
    });
    await tx.auditLog.create({
      data: {
        userId: input.userId,
        entityType: "LEDGER_TRANSACTION",
        entityId: transaction.id,
        action: "TRANSACTION_POSTED",
        changes: {
          source: input.source,
          loanId: input.loanId,
          effectiveDate: input.effectiveDate,
          entries: input.entries,
        },
      },
    });
    return transaction;
  }

  private idempotencyError() {
    return new HttpError(
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "This idempotency key was already used for different data.",
    );
  }

  private async resolveDuplicateWrite(
    error: unknown,
    userId: string,
    key: string,
    requestHash: string,
  ): Promise<void> {
    if (!isUniqueConstraintError(error)) throw error;
    const existing = await this.prisma.ledgerTransaction.findFirst({
      where: { userId, idempotencyKey: key },
      select: { requestHash: true },
    });
    if (!existing) throw error;
    if (existing.requestHash !== requestHash) throw this.idempotencyError();
  }
}
