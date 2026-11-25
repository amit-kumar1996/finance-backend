import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { Prisma } from "../../generated/prisma/client.js";
import { HttpError } from "../../lib/http-error.js";
import { assertBalancedEntries } from "./money.js";
import type {
  AccountReference,
  AccountSummary,
  AccountsRepository,
  CreateAccountRepositoryInput,
  FinancialAccountType,
  IdempotentLedgerTransaction,
  IdempotentResource,
  LedgerTransactionRecord,
  PostTransactionRepositoryInput,
  ReplaceExpenseRepositoryInput,
  ReplaceExpenseRepositoryResult,
} from "./accounts.types.js";

const toDate = (date: string): Date => new Date(`${date}T00:00:00.000Z`);
const toDateString = (date: Date): string => date.toISOString().slice(0, 10);

const mapTransaction = (row: {
  id: string;
  userId: string;
  effectiveDate: Date;
  description: string;
  source: LedgerTransactionRecord["source"];
  reversalOfId: string | null;
  reversedBy: { id: string } | null;
  entries: Array<{
    ledgerAccountId: string;
    debitAmount: Prisma.Decimal;
    creditAmount: Prisma.Decimal;
  }>;
}): LedgerTransactionRecord => ({
  id: row.id,
  userId: row.userId,
  effectiveDate: toDateString(row.effectiveDate),
  description: row.description,
  source: row.source,
  reversalOfId: row.reversalOfId,
  reversedById: row.reversedBy?.id ?? null,
  entries: row.entries.map((entry) => ({
    ledgerAccountId: entry.ledgerAccountId,
    debitAmount: entry.debitAmount.toFixed(2),
    creditAmount: entry.creditAmount.toFixed(2),
  })),
});

const transactionInclude = {
  entries: {
    select: {
      ledgerAccountId: true,
      debitAmount: true,
      creditAmount: true,
    },
  },
  reversedBy: { select: { id: true } },
} as const;

const ledgerCategoryFor = (type: FinancialAccountType) =>
  type === "CREDIT_CARD" ? "LIABILITY" : "ASSET";
const normalBalanceFor = (type: FinancialAccountType) =>
  type === "CREDIT_CARD" ? "CREDIT" : "DEBIT";

const isUniqueConstraintError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "P2002";

export class PrismaAccountsRepository implements AccountsRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listAccounts(userId: string): Promise<AccountSummary[]> {
    const accounts = await this.prisma.financialAccount.findMany({
      where: { userId },
      include: {
        ledgerAccount: { select: { id: true, normalBalance: true } },
      },
      orderBy: [{ accountType: "asc" }, { name: "asc" }, { createdAt: "asc" }],
    });
    if (accounts.length === 0) return [];

    const sums = await this.prisma.transactionEntry.groupBy({
      by: ["ledgerAccountId"],
      where: {
        ledgerAccountId: { in: accounts.map((account) => account.ledgerAccountId) },
      },
      _sum: { debitAmount: true, creditAmount: true },
    });
    const balanceByLedgerAccount = new Map(
      sums.map((sum) => [
        sum.ledgerAccountId,
        {
          debits: sum._sum.debitAmount ?? new Prisma.Decimal(0),
          credits: sum._sum.creditAmount ?? new Prisma.Decimal(0),
        },
      ]),
    );

    return accounts.map((account) => {
      const totals = balanceByLedgerAccount.get(account.ledgerAccountId);
      const debits = totals?.debits ?? new Prisma.Decimal(0);
      const credits = totals?.credits ?? new Prisma.Decimal(0);
      const balance =
        account.ledgerAccount.normalBalance === "DEBIT"
          ? debits.minus(credits)
          : credits.minus(debits);
      return {
        id: account.id,
        name: account.name,
        accountType: account.accountType,
        institutionName: account.institutionName,
        balance: balance.toFixed(2),
        createdAt: account.createdAt,
      };
    });
  }

  async getDefaultExpenseAccount(userId: string): Promise<AccountSummary | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { defaultExpenseAccountId: true },
    });
    if (!user?.defaultExpenseAccountId) return null;
    return this.getAccountSummary(userId, user.defaultExpenseAccountId);
  }

  async setDefaultExpenseAccount(
    userId: string,
    accountId: string | null,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const existing = await tx.idempotencyRecord.findFirst({
          where: { userId, key: idempotencyKey },
          select: { requestHash: true },
        });
        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new HttpError(
              409,
              "IDEMPOTENCY_KEY_REUSED",
              "This idempotency key was already used for different data.",
            );
          }
          return;
        }
        if (accountId) {
          const account = await tx.financialAccount.findFirst({
            where: {
              id: accountId,
              userId,
              accountType: { in: ["BANK", "CASH", "UPI"] },
            },
            select: { id: true },
          });
          if (!account) {
            throw new HttpError(
              404,
              "ACCOUNT_NOT_FOUND",
              "Choose a bank, cash, or UPI account owned by this user.",
            );
          }
        }
        const current = await tx.user.findUnique({
          where: { id: userId },
          select: { defaultExpenseAccountId: true },
        });
        if (!current)
          throw new HttpError(404, "USER_NOT_FOUND", "The user was not found.");
        await tx.user.update({
          where: { id: userId },
          data: { defaultExpenseAccountId: accountId },
        });
        await tx.auditLog.create({
          data: {
            userId,
            entityType: "USER_PREFERENCE",
            entityId: userId,
            action: "DEFAULT_EXPENSE_ACCOUNT_CHANGED",
            changes: {
              previousAccountId: current.defaultExpenseAccountId,
              accountId,
            },
          },
        });
        await tx.idempotencyRecord.create({
          data: {
            userId,
            key: idempotencyKey,
            requestHash,
            resourceType: "USER_PREFERENCE",
            resourceId: userId,
          },
        });
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const existing = await this.prisma.idempotencyRecord.findFirst({
        where: { userId, key: idempotencyKey },
        select: { requestHash: true },
      });
      if (!existing || existing.requestHash !== requestHash) {
        throw new HttpError(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "This idempotency key was already used for different data.",
        );
      }
    }
  }

  async getAccount(userId: string, accountId: string): Promise<AccountReference | null> {
    const account = await this.prisma.financialAccount.findFirst({
      where: { id: accountId, userId },
      include: { ledgerAccount: { select: { id: true, normalBalance: true } } },
    });
    if (!account) return null;
    return {
      id: account.id,
      userId: account.userId,
      name: account.name,
      accountType: account.accountType,
      ledgerAccountId: account.ledgerAccountId,
      ledgerNormalBalance: account.ledgerAccount.normalBalance,
    };
  }

  async getAccountSummary(
    userId: string,
    accountId: string,
  ): Promise<AccountSummary | null> {
    const account = await this.getAccount(userId, accountId);
    if (!account) return null;
    const summary = (await this.listAccounts(userId)).find(
      (item) => item.id === accountId,
    );
    return summary ?? null;
  }

  async findAccountByIdempotencyKey(
    userId: string,
    idempotencyKey: string,
  ): Promise<IdempotentResource | null> {
    return this.prisma.financialAccount.findFirst({
      where: { userId, idempotencyKey },
      select: { id: true, requestHash: true },
    });
  }

  async createAccount(input: CreateAccountRepositoryInput): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      const id = randomBytes(12).toString("base64url");
      const ledgerAccountId = randomBytes(12).toString("base64url");
      const type = input.accountType;
      const accountName = input.name;
      const ledgerAccount = await tx.ledgerAccount.create({
        data: {
          id: ledgerAccountId,
          userId: input.userId,
          code: `FIN_${id}`,
          name: accountName,
          category: ledgerCategoryFor(type),
          normalBalance: normalBalanceFor(type),
          isSystem: false,
        },
      });
      const account = await tx.financialAccount.create({
        data: {
          id,
          userId: input.userId,
          name: accountName,
          accountType: type,
          institutionName: input.institutionName,
          ledgerAccountId: ledgerAccount.id,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
        },
      });
      await tx.auditLog.create({
        data: {
          userId: input.userId,
          entityType: "FINANCIAL_ACCOUNT",
          entityId: account.id,
          action: "ACCOUNT_CREATED",
          changes: {
            name: account.name,
            accountType: account.accountType,
            institutionName: account.institutionName,
          },
        },
      });

      const openingBalance = new Prisma.Decimal(input.openingBalance);
      if (openingBalance.gt(0)) {
        const equityAccount = await tx.ledgerAccount.upsert({
          where: { userId_code: { userId: input.userId, code: "SYS_OPENING_EQUITY" } },
          create: {
            userId: input.userId,
            code: "SYS_OPENING_EQUITY",
            name: "Opening balance equity",
            category: "EQUITY",
            normalBalance: "CREDIT",
            isSystem: true,
          },
          update: {},
        });
        const isCreditCard = type === "CREDIT_CARD";
        const openingEntries = isCreditCard
          ? [
              {
                ledgerAccountId: equityAccount.id,
                debitAmount: openingBalance,
                creditAmount: new Prisma.Decimal(0),
              },
              {
                ledgerAccountId: ledgerAccount.id,
                debitAmount: new Prisma.Decimal(0),
                creditAmount: openingBalance,
              },
            ]
          : [
              {
                ledgerAccountId: ledgerAccount.id,
                debitAmount: openingBalance,
                creditAmount: new Prisma.Decimal(0),
              },
              {
                ledgerAccountId: equityAccount.id,
                debitAmount: new Prisma.Decimal(0),
                creditAmount: openingBalance,
              },
            ];
        const openingTransaction = await tx.ledgerTransaction.create({
          data: {
            userId: input.userId,
            effectiveDate: toDate(input.effectiveDate),
            description: `Opening balance: ${account.name}`,
            source: "OPENING_BALANCE",
            idempotencyKey: `opening:${account.id}`,
            requestHash: createHash("sha256")
              .update(
                JSON.stringify({
                  accountId: account.id,
                  amount: openingBalance.toFixed(2),
                }),
              )
              .digest("hex"),
            entries: {
              create: openingEntries.map((entry) => ({
                ledgerAccountId: entry.ledgerAccountId,
                debitAmount: entry.debitAmount,
                creditAmount: entry.creditAmount,
              })),
            },
          },
        });
        await tx.auditLog.create({
          data: {
            userId: input.userId,
            entityType: "LEDGER_TRANSACTION",
            entityId: openingTransaction.id,
            action: "OPENING_BALANCE_POSTED",
            changes: {
              accountId: account.id,
              amount: openingBalance.toFixed(2),
              accountType: type,
            },
          },
        });
      }
      return account.id;
    });
  }

  async getSystemLedgerAccountId(
    userId: string,
    code: "OPENING_EQUITY" | "GENERAL_EXPENSE",
  ): Promise<string> {
    const definitions = {
      OPENING_EQUITY: {
        code: "SYS_OPENING_EQUITY",
        name: "Opening balance equity",
        category: "EQUITY" as const,
        normalBalance: "CREDIT" as const,
      },
      GENERAL_EXPENSE: {
        code: "SYS_GENERAL_EXPENSE",
        name: "General expenses",
        category: "EXPENSE" as const,
        normalBalance: "DEBIT" as const,
      },
    };
    const definition = definitions[code];
    const account = await this.prisma.ledgerAccount.upsert({
      where: { userId_code: { userId, code: definition.code } },
      create: { userId, ...definition, isSystem: true },
      update: {},
      select: { id: true },
    });
    return account.id;
  }

  async findTransactionByIdempotencyKey(
    userId: string,
    idempotencyKey: string,
  ): Promise<IdempotentLedgerTransaction | null> {
    const row = await this.prisma.ledgerTransaction.findFirst({
      where: { userId, idempotencyKey },
      include: transactionInclude,
    });
    return row ? { ...mapTransaction(row), requestHash: row.requestHash } : null;
  }

  async findTransaction(
    userId: string,
    transactionId: string,
  ): Promise<LedgerTransactionRecord | null> {
    const row = await this.prisma.ledgerTransaction.findFirst({
      where: { id: transactionId, userId },
      include: transactionInclude,
    });
    return row ? mapTransaction(row) : null;
  }

  async postTransaction(
    input: PostTransactionRepositoryInput,
  ): Promise<LedgerTransactionRecord> {
    return this.prisma.$transaction(
      async (tx) => {
        const existing = await tx.ledgerTransaction.findFirst({
          where: { userId: input.userId, idempotencyKey: input.idempotencyKey },
          include: transactionInclude,
        });
        if (existing) {
          if (existing.requestHash !== input.requestHash) {
            throw new HttpError(
              409,
              "IDEMPOTENCY_KEY_REUSED",
              "This idempotency key was already used for different data.",
            );
          }
          return mapTransaction(existing);
        }

        const ledgerAccountIds = [
          ...new Set(input.entries.map((entry) => entry.ledgerAccountId)),
        ];
        const ownedAccountCount = await tx.ledgerAccount.count({
          where: { id: { in: ledgerAccountIds }, userId: input.userId },
        });
        if (ownedAccountCount !== ledgerAccountIds.length) {
          throw new HttpError(
            404,
            "LEDGER_ACCOUNT_NOT_FOUND",
            "A ledger account was not found.",
          );
        }

        const orderedLedgerAccountIds = [...ledgerAccountIds].sort();
        const lockedLedgerAccounts = await tx.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`SELECT id FROM ledger_accounts
          WHERE user_id = ${input.userId}
            AND id IN (${Prisma.join(orderedLedgerAccountIds)})
          ORDER BY id FOR UPDATE`,
        );
        if (lockedLedgerAccounts.length !== orderedLedgerAccountIds.length) {
          throw new HttpError(
            404,
            "LEDGER_ACCOUNT_NOT_FOUND",
            "A ledger account was not found.",
          );
        }

        if (input.activePersonId) {
          const activePerson = await tx.person.findFirst({
            where: { id: input.activePersonId, userId: input.userId, archivedAt: null },
            select: { receivableAccountId: true, payableAccountId: true },
          });
          if (
            !activePerson ||
            ![activePerson.receivableAccountId, activePerson.payableAccountId]
              .filter((id): id is string => id !== null)
              .some((id) => orderedLedgerAccountIds.includes(id))
          ) {
            throw new HttpError(404, "PERSON_NOT_FOUND", "The person was not found.");
          }
        }

        if (input.source !== "REVERSAL") {
          const ledgerAccounts = await tx.ledgerAccount.findMany({
            where: { id: { in: orderedLedgerAccountIds }, userId: input.userId },
            select: {
              id: true,
              normalBalance: true,
              financialAccount: { select: { id: true } },
              personReceivable: { select: { id: true } },
              personPayable: { select: { id: true } },
            },
          });
          const totals = await tx.transactionEntry.groupBy({
            by: ["ledgerAccountId"],
            where: { ledgerAccountId: { in: orderedLedgerAccountIds } },
            _sum: { debitAmount: true, creditAmount: true },
          });
          const totalByLedgerAccount = new Map(
            totals.map((total) => [
              total.ledgerAccountId,
              {
                debits: total._sum.debitAmount ?? new Prisma.Decimal(0),
                credits: total._sum.creditAmount ?? new Prisma.Decimal(0),
              },
            ]),
          );
          for (const account of ledgerAccounts) {
            if (
              !account.financialAccount &&
              !account.personReceivable &&
              !account.personPayable
            )
              continue;
            const totalsForAccount = totalByLedgerAccount.get(account.id);
            const debits = totalsForAccount?.debits ?? new Prisma.Decimal(0);
            const credits = totalsForAccount?.credits ?? new Prisma.Decimal(0);
            const currentBalance =
              account.normalBalance === "DEBIT"
                ? debits.minus(credits)
                : credits.minus(debits);
            const change = input.entries
              .filter((entry) => entry.ledgerAccountId === account.id)
              .reduce((sum, entry) => {
                const debit = new Prisma.Decimal(entry.debitAmount);
                const credit = new Prisma.Decimal(entry.creditAmount);
                return sum.plus(
                  account.normalBalance === "DEBIT"
                    ? debit.minus(credit)
                    : credit.minus(debit),
                );
              }, new Prisma.Decimal(0));
            if (change.lt(0) && currentBalance.plus(change).lt(0)) {
              throw new HttpError(
                409,
                "INSUFFICIENT_FUNDS",
                "The account does not have enough balance for this posting.",
              );
            }
          }
        }

        if (input.reversalOfId) {
          const original = await tx.ledgerTransaction.findFirst({
            where: { id: input.reversalOfId, userId: input.userId },
            include: { reversedBy: { select: { id: true } } },
          });
          if (!original) {
            throw new HttpError(
              404,
              "TRANSACTION_NOT_FOUND",
              "The transaction was not found.",
            );
          }
          if (original.reversedBy) {
            throw new HttpError(
              409,
              "TRANSACTION_ALREADY_REVERSED",
              "This transaction has already been reversed.",
            );
          }
        }

        const transaction = await tx.ledgerTransaction.create({
          data: {
            userId: input.userId,
            effectiveDate: toDate(input.effectiveDate),
            description: input.description,
            source: input.source,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
            ...(input.reversalOfId ? { reversalOfId: input.reversalOfId } : {}),
            entries: {
              create: input.entries.map((entry) => ({
                ledgerAccountId: entry.ledgerAccountId,
                debitAmount: new Prisma.Decimal(entry.debitAmount),
                creditAmount: new Prisma.Decimal(entry.creditAmount),
              })),
            },
          },
          include: transactionInclude,
        });
        await tx.auditLog.create({
          data: {
            userId: input.userId,
            entityType: "LEDGER_TRANSACTION",
            entityId: transaction.id,
            action:
              input.source === "REVERSAL" ? "TRANSACTION_REVERSED" : "TRANSACTION_POSTED",
            changes: {
              source: input.source,
              effectiveDate: input.effectiveDate,
              description: input.description,
              entries: input.entries.map((entry) => ({
                ledgerAccountId: entry.ledgerAccountId,
                debitAmount: entry.debitAmount,
                creditAmount: entry.creditAmount,
              })),
              ...(input.reversalOfId ? { reversalOfId: input.reversalOfId } : {}),
            },
          },
        });
        return mapTransaction(transaction);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  async replaceExpense(
    input: ReplaceExpenseRepositoryInput,
  ): Promise<ReplaceExpenseRepositoryResult> {
    return this.prisma.$transaction(
      async (tx) => {
        const priorReplacement = await tx.ledgerTransaction.findFirst({
          where: {
            userId: input.userId,
            idempotencyKey: input.replacementIdempotencyKey,
          },
          include: transactionInclude,
        });
        if (priorReplacement) {
          if (priorReplacement.requestHash !== input.requestHash) {
            throw new HttpError(
              409,
              "IDEMPOTENCY_KEY_REUSED",
              "This idempotency key was already used for different data.",
            );
          }
          const priorReversal = await tx.ledgerTransaction.findFirst({
            where: {
              userId: input.userId,
              reversalOfId: input.originalTransactionId,
              idempotencyKey: input.reversalIdempotencyKey,
            },
            include: transactionInclude,
          });
          if (!priorReversal)
            throw new Error("Expense replacement reversal was not found.");
          return {
            reversal: mapTransaction(priorReversal),
            transaction: mapTransaction(priorReplacement),
          };
        }

        let original = await tx.ledgerTransaction.findFirst({
          where: {
            id: input.originalTransactionId,
            userId: input.userId,
            source: "EXPENSE",
          },
          include: { ...transactionInclude },
        });
        if (!original) {
          throw new HttpError(404, "EXPENSE_NOT_FOUND", "The expense was not found.");
        }
        if (original.reversedBy) {
          throw new HttpError(
            409,
            "EXPENSE_ALREADY_REVERSED",
            "This expense was already reversed.",
          );
        }

        const originalLedgerIds = original.entries.map((entry) => entry.ledgerAccountId);
        const sourceAccount = await tx.financialAccount.findFirst({
          where: {
            userId: input.userId,
            ledgerAccountId: { in: originalLedgerIds },
          },
          select: { id: true, ledgerAccountId: true, accountType: true },
        });
        if (!sourceAccount) {
          throw new HttpError(
            409,
            "EXPENSE_ACCOUNT_MISSING",
            "The linked spending account was not found.",
          );
        }
        const expenseLedger = await tx.ledgerAccount.upsert({
          where: { userId_code: { userId: input.userId, code: "SYS_GENERAL_EXPENSE" } },
          create: {
            userId: input.userId,
            code: "SYS_GENERAL_EXPENSE",
            name: "General expenses",
            category: "EXPENSE",
            normalBalance: "DEBIT",
            isSystem: true,
          },
          update: {},
          select: { id: true },
        });
        const amount = new Prisma.Decimal(input.amount);
        const replacementEntries = [
          {
            ledgerAccountId: expenseLedger.id,
            debitAmount: amount,
            creditAmount: new Prisma.Decimal(0),
          },
          {
            ledgerAccountId: sourceAccount.ledgerAccountId,
            debitAmount: new Prisma.Decimal(0),
            creditAmount: amount,
          },
        ];
        const reversalEntries = original.entries.map((entry) => ({
          ledgerAccountId: entry.ledgerAccountId,
          debitAmount: entry.creditAmount,
          creditAmount: entry.debitAmount,
        }));
        assertBalancedEntries(
          replacementEntries.map((entry) => ({
            ledgerAccountId: entry.ledgerAccountId,
            debitAmount: entry.debitAmount.toFixed(2),
            creditAmount: entry.creditAmount.toFixed(2),
          })),
        );
        assertBalancedEntries(
          reversalEntries.map((entry) => ({
            ledgerAccountId: entry.ledgerAccountId,
            debitAmount: entry.debitAmount.toFixed(2),
            creditAmount: entry.creditAmount.toFixed(2),
          })),
        );

        const ledgerAccountIds = [
          ...new Set([
            ...originalLedgerIds,
            expenseLedger.id,
            sourceAccount.ledgerAccountId,
          ]),
        ].sort();
        const ownedCount = await tx.ledgerAccount.count({
          where: { userId: input.userId, id: { in: ledgerAccountIds } },
        });
        if (ownedCount !== ledgerAccountIds.length) {
          throw new HttpError(
            404,
            "LEDGER_ACCOUNT_NOT_FOUND",
            "A ledger account was not found.",
          );
        }
        const locked = await tx.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`SELECT id FROM ledger_accounts
          WHERE user_id = ${input.userId}
            AND id IN (${Prisma.join(ledgerAccountIds)})
          ORDER BY id FOR UPDATE`,
        );
        if (locked.length !== ledgerAccountIds.length) {
          throw new HttpError(
            404,
            "LEDGER_ACCOUNT_NOT_FOUND",
            "A ledger account was not found.",
          );
        }
        original = await tx.ledgerTransaction.findFirst({
          where: {
            id: input.originalTransactionId,
            userId: input.userId,
            source: "EXPENSE",
          },
          include: transactionInclude,
        });
        if (!original)
          throw new HttpError(404, "EXPENSE_NOT_FOUND", "The expense was not found.");
        if (original.reversedBy) {
          throw new HttpError(
            409,
            "EXPENSE_ALREADY_REVERSED",
            "This expense was already reversed.",
          );
        }

        const account = await tx.ledgerAccount.findUnique({
          where: { id: sourceAccount.ledgerAccountId },
          select: {
            normalBalance: true,
            financialAccount: { select: { id: true, accountType: true } },
          },
        });
        if (!account?.financialAccount) {
          throw new HttpError(
            404,
            "EXPENSE_ACCOUNT_MISSING",
            "The linked spending account was not found.",
          );
        }
        const sums = await tx.transactionEntry.groupBy({
          by: ["ledgerAccountId"],
          where: { ledgerAccountId: { in: ledgerAccountIds } },
          _sum: { debitAmount: true, creditAmount: true },
        });
        const currentTotals = new Map(
          sums.map((sum) => [
            sum.ledgerAccountId,
            {
              debits: sum._sum.debitAmount ?? new Prisma.Decimal(0),
              credits: sum._sum.creditAmount ?? new Prisma.Decimal(0),
            },
          ]),
        );
        const current = currentTotals.get(sourceAccount.ledgerAccountId);
        const currentBalance = (current?.debits ?? new Prisma.Decimal(0)).minus(
          current?.credits ?? new Prisma.Decimal(0),
        );
        const change = [...reversalEntries, ...replacementEntries]
          .filter((entry) => entry.ledgerAccountId === sourceAccount.ledgerAccountId)
          .reduce(
            (sum, entry) => sum.plus(entry.debitAmount).minus(entry.creditAmount),
            new Prisma.Decimal(0),
          );
        if (
          account.financialAccount.accountType !== "CREDIT_CARD" &&
          change.lt(0) &&
          currentBalance.plus(change).lt(0)
        ) {
          throw new HttpError(
            409,
            "INSUFFICIENT_FUNDS",
            "The account does not have enough balance for the edited expense.",
          );
        }

        const reversal = await tx.ledgerTransaction.create({
          data: {
            userId: input.userId,
            effectiveDate: original.effectiveDate,
            description: `Reversal: Expense edited — ${original.description}`,
            source: "REVERSAL",
            idempotencyKey: input.reversalIdempotencyKey,
            requestHash: input.reversalRequestHash,
            reversalOfId: original.id,
            entries: { create: reversalEntries },
          },
          include: transactionInclude,
        });
        const transaction = await tx.ledgerTransaction.create({
          data: {
            userId: input.userId,
            effectiveDate: toDate(input.effectiveDate),
            description: input.description,
            source: "EXPENSE",
            idempotencyKey: input.replacementIdempotencyKey,
            requestHash: input.requestHash,
            entries: { create: replacementEntries },
          },
          include: transactionInclude,
        });
        await tx.auditLog.createMany({
          data: [
            {
              userId: input.userId,
              entityType: "LEDGER_TRANSACTION",
              entityId: reversal.id,
              action: "TRANSACTION_REVERSED",
              changes: { source: "REVERSAL", reversalOfId: original.id },
            },
            {
              userId: input.userId,
              entityType: "LEDGER_TRANSACTION",
              entityId: transaction.id,
              action: "EXPENSE_EDITED",
              changes: {
                effectiveDate: input.effectiveDate,
                description: input.description,
                amount: input.amount,
                replacesTransactionId: original.id,
              },
            },
          ],
        });
        return {
          reversal: mapTransaction(reversal),
          transaction: mapTransaction(transaction),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }
}
