import { describe, expect, it } from "vitest";
import { HttpError } from "../../lib/http-error.js";
import { AccountsService } from "./accounts.service.js";
import { assertBalancedEntries, formatMoney, parseMoney } from "./money.js";
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
import { Prisma } from "../../generated/prisma/client.js";

interface StoredTransaction extends LedgerTransactionRecord {
  requestHash: string;
  idempotencyKey: string;
}

class MemoryAccountsRepository implements AccountsRepository {
  readonly accounts = new Map<
    string,
    AccountReference & { institutionName: string | null; createdAt: Date }
  >();
  readonly transactions = new Map<string, StoredTransaction>();
  readonly audits: Array<{ entityType: string; action: string; entityId: string }> = [];
  private readonly accountKeys = new Map<string, IdempotentResource>();
  private readonly transactionKeys = new Map<string, string>();
  private readonly systemAccounts = new Map<string, string>();
  private readonly personLedgerOwners = new Map<string, string>();
  private readonly defaultExpenseAccounts = new Map<string, string>();
  private nextId = 0;

  addPersonLedgerAccount(userId: string, ledgerAccountId: string): void {
    this.personLedgerOwners.set(ledgerAccountId, userId);
  }

  ledgerBalance(ledgerAccountId: string, normal: "DEBIT" | "CREDIT"): string {
    let debits = new Prisma.Decimal(0);
    let credits = new Prisma.Decimal(0);
    for (const transaction of this.transactions.values()) {
      for (const entry of transaction.entries) {
        if (entry.ledgerAccountId !== ledgerAccountId) continue;
        debits = debits.plus(entry.debitAmount);
        credits = credits.plus(entry.creditAmount);
      }
    }
    return (normal === "DEBIT" ? debits.minus(credits) : credits.minus(debits)).toFixed(
      2,
    );
  }

  async listAccounts(userId: string): Promise<AccountSummary[]> {
    return [...this.accounts.values()]
      .filter((account) => account.userId === userId)
      .map((account) => {
        let debit = new Prisma.Decimal(0);
        let credit = new Prisma.Decimal(0);
        for (const transaction of this.transactions.values()) {
          for (const entry of transaction.entries) {
            if (entry.ledgerAccountId !== account.ledgerAccountId) continue;
            debit = debit.plus(entry.debitAmount);
            credit = credit.plus(entry.creditAmount);
          }
        }
        const balance =
          account.ledgerNormalBalance === "DEBIT"
            ? debit.minus(credit)
            : credit.minus(debit);
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
    const accountId = this.defaultExpenseAccounts.get(userId);
    return accountId ? this.getAccountSummary(userId, accountId) : null;
  }

  async setDefaultExpenseAccount(
    userId: string,
    accountId: string | null,
    _idempotencyKey: string,
    _requestHash: string,
  ): Promise<void> {
    if (accountId) this.defaultExpenseAccounts.set(userId, accountId);
    else this.defaultExpenseAccounts.delete(userId);
  }

  async getAccount(userId: string, accountId: string): Promise<AccountReference | null> {
    const account = this.accounts.get(accountId);
    return account?.userId === userId ? account : null;
  }

  async getAccountSummary(
    userId: string,
    accountId: string,
  ): Promise<AccountSummary | null> {
    return (
      (await this.listAccounts(userId)).find((account) => account.id === accountId) ??
      null
    );
  }

  async findAccountByIdempotencyKey(userId: string, idempotencyKey: string) {
    return this.accountKeys.get(`${userId}:${idempotencyKey}`) ?? null;
  }

  async createAccount(input: CreateAccountRepositoryInput): Promise<string> {
    const id = `account-${++this.nextId}`;
    const ledgerAccountId = `ledger-${this.nextId}`;
    const normal = input.accountType === "CREDIT_CARD" ? "CREDIT" : "DEBIT";
    const account = {
      id,
      userId: input.userId,
      name: input.name,
      accountType: input.accountType,
      institutionName: input.institutionName,
      ledgerAccountId,
      ledgerNormalBalance: normal as "DEBIT" | "CREDIT",
      createdAt: new Date(),
    };
    this.accounts.set(id, account);
    this.accountKeys.set(`${input.userId}:${input.idempotencyKey}`, {
      id,
      requestHash: input.requestHash,
    });
    this.audits.push({
      entityType: "FINANCIAL_ACCOUNT",
      action: "ACCOUNT_CREATED",
      entityId: id,
    });

    const opening = new Prisma.Decimal(input.openingBalance);
    if (opening.gt(0)) {
      const equity = await this.getSystemLedgerAccountId(input.userId, "OPENING_EQUITY");
      const entries =
        input.accountType === "CREDIT_CARD"
          ? [
              {
                ledgerAccountId: equity,
                debitAmount: opening.toFixed(2),
                creditAmount: "0.00",
              },
              { ledgerAccountId, debitAmount: "0.00", creditAmount: opening.toFixed(2) },
            ]
          : [
              { ledgerAccountId, debitAmount: opening.toFixed(2), creditAmount: "0.00" },
              {
                ledgerAccountId: equity,
                debitAmount: "0.00",
                creditAmount: opening.toFixed(2),
              },
            ];
      const transactionId = `transaction-${++this.nextId}`;
      const transaction: StoredTransaction = {
        id: transactionId,
        userId: input.userId,
        effectiveDate: input.effectiveDate,
        description: `Opening balance: ${input.name}`,
        source: "OPENING_BALANCE",
        reversalOfId: null,
        reversedById: null,
        entries,
        requestHash: input.requestHash,
        idempotencyKey: `opening:${id}`,
      };
      this.transactions.set(transactionId, transaction);
      this.transactionKeys.set(
        `${input.userId}:${transaction.idempotencyKey}`,
        transactionId,
      );
      this.audits.push({
        entityType: "LEDGER_TRANSACTION",
        action: "OPENING_BALANCE_POSTED",
        entityId: transactionId,
      });
    }
    return id;
  }

  async getSystemLedgerAccountId(
    userId: string,
    code: "OPENING_EQUITY" | "GENERAL_EXPENSE",
  ) {
    const key = `${userId}:${code}`;
    let id = this.systemAccounts.get(key);
    if (!id) {
      id = `system-${++this.nextId}`;
      this.systemAccounts.set(key, id);
    }
    return id;
  }

  async findTransactionByIdempotencyKey(
    userId: string,
    idempotencyKey: string,
  ): Promise<IdempotentLedgerTransaction | null> {
    const id = this.transactionKeys.get(`${userId}:${idempotencyKey}`);
    if (!id) return null;
    const row = this.transactions.get(id);
    return row ? { ...row, entries: row.entries.map((entry) => ({ ...entry })) } : null;
  }

  async findTransaction(
    userId: string,
    transactionId: string,
  ): Promise<LedgerTransactionRecord | null> {
    const row = this.transactions.get(transactionId);
    return row?.userId === userId
      ? { ...row, entries: row.entries.map((entry) => ({ ...entry })) }
      : null;
  }

  async postTransaction(
    input: PostTransactionRepositoryInput,
  ): Promise<LedgerTransactionRecord> {
    const existing = await this.findTransactionByIdempotencyKey(
      input.userId,
      input.idempotencyKey,
    );
    if (existing) {
      if (existing.requestHash !== input.requestHash) {
        throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED", "Idempotency key reused.");
      }
      return existing;
    }
    assertBalancedEntries(input.entries);
    const ownedLedgerIds = new Set(
      [...this.accounts.values()]
        .filter((account) => account.userId === input.userId)
        .map((account) => account.ledgerAccountId),
    );
    for (const id of this.systemAccounts.values()) ownedLedgerIds.add(id);
    for (const [id, owner] of this.personLedgerOwners) {
      if (owner === input.userId) ownedLedgerIds.add(id);
    }
    if (input.entries.some((entry) => !ownedLedgerIds.has(entry.ledgerAccountId))) {
      throw new HttpError(
        404,
        "LEDGER_ACCOUNT_NOT_FOUND",
        "A ledger account was not found.",
      );
    }
    if (input.reversalOfId) {
      const original = this.transactions.get(input.reversalOfId);
      if (!original || original.userId !== input.userId) {
        throw new HttpError(
          404,
          "TRANSACTION_NOT_FOUND",
          "The transaction was not found.",
        );
      }
      if (original.reversedById) {
        throw new HttpError(409, "TRANSACTION_ALREADY_REVERSED", "Already reversed.");
      }
    }
    if (input.source !== "REVERSAL") {
      for (const account of this.accounts.values()) {
        if (account.userId !== input.userId) continue;
        const accountEntries = input.entries.filter(
          (entry) => entry.ledgerAccountId === account.ledgerAccountId,
        );
        if (accountEntries.length === 0) continue;
        let currentBalance = new Prisma.Decimal(0);
        for (const transaction of this.transactions.values()) {
          for (const entry of transaction.entries) {
            if (entry.ledgerAccountId !== account.ledgerAccountId) continue;
            currentBalance = currentBalance.plus(
              account.ledgerNormalBalance === "DEBIT"
                ? new Prisma.Decimal(entry.debitAmount).minus(entry.creditAmount)
                : new Prisma.Decimal(entry.creditAmount).minus(entry.debitAmount),
            );
          }
        }
        const change = accountEntries.reduce(
          (sum, entry) =>
            sum.plus(
              account.ledgerNormalBalance === "DEBIT"
                ? new Prisma.Decimal(entry.debitAmount).minus(entry.creditAmount)
                : new Prisma.Decimal(entry.creditAmount).minus(entry.debitAmount),
            ),
          new Prisma.Decimal(0),
        );
        if (change.lt(0) && currentBalance.plus(change).lt(0)) {
          throw new HttpError(
            409,
            "INSUFFICIENT_FUNDS",
            "The account does not have enough balance for this posting.",
          );
        }
      }
    }
    const id = `transaction-${++this.nextId}`;
    const row: StoredTransaction = {
      id,
      userId: input.userId,
      effectiveDate: input.effectiveDate,
      description: input.description,
      source: input.source,
      reversalOfId: input.reversalOfId ?? null,
      reversedById: null,
      entries: input.entries.map((entry) => ({ ...entry })),
      requestHash: input.requestHash,
      idempotencyKey: input.idempotencyKey,
    };
    this.transactions.set(id, row);
    this.transactionKeys.set(`${input.userId}:${input.idempotencyKey}`, id);
    if (input.reversalOfId) {
      const original = this.transactions.get(input.reversalOfId);
      if (original) original.reversedById = id;
    }
    this.audits.push({
      entityType: "LEDGER_TRANSACTION",
      action: input.source === "REVERSAL" ? "TRANSACTION_REVERSED" : "TRANSACTION_POSTED",
      entityId: id,
    });
    return { ...row, entries: row.entries.map((entry) => ({ ...entry })) };
  }

  async replaceExpense(
    _input: ReplaceExpenseRepositoryInput,
  ): Promise<ReplaceExpenseRepositoryResult> {
    throw new Error("Expense replacement is covered by the Prisma repository.");
  }
}

const newService = () => {
  const repository = new MemoryAccountsRepository();
  return { repository, service: new AccountsService(repository) };
};

const makeAccount = (
  service: AccountsService,
  userId: string,
  key: string,
  accountType: FinancialAccountType,
  openingBalance: string,
  name = key,
) =>
  service.createAccount(userId, key, {
    name,
    accountType,
    openingBalance,
    effectiveDate: "2026-11-24",
  });

describe("double-entry accounts and ledger", () => {
  it("posts a bank transfer without changing total net worth", async () => {
    const { repository, service } = newService();
    const bankA = await makeAccount(service, "user-a", "bank-a", "BANK", "10000.00");
    const bankB = await makeAccount(service, "user-a", "bank-b", "BANK", "0.00");

    const transaction = await service.transfer("user-a", "transfer-1", {
      fromAccountId: bankA.id,
      toAccountId: bankB.id,
      effectiveDate: "2026-11-24",
      amount: "5000.00",
      description: "Move between banks",
    });
    const accounts = await service.listAccounts("user-a");
    const total = accounts.reduce(
      (sum, account) => sum.plus(account.balance),
      new Prisma.Decimal(0),
    );

    expect(total.toFixed(2)).toBe("10000.00");
    expect(accounts.find((account) => account.id === bankA.id)?.balance).toBe("5000.00");
    expect(accounts.find((account) => account.id === bankB.id)?.balance).toBe("5000.00");
    expect(transaction.source).toBe("TRANSFER");
    expect(repository.audits.some((audit) => audit.entityId === transaction.id)).toBe(
      true,
    );
  });

  it("reduces the selected bank balance for an expense", async () => {
    const { service } = newService();
    const bank = await makeAccount(service, "user-a", "bank", "BANK", "2000.00");
    await service.expense("user-a", "expense-1", {
      accountId: bank.id,
      effectiveDate: "2026-11-24",
      amount: "1000.00",
      description: "Groceries",
    });
    expect(
      (await service.listAccounts("user-a")).find((account) => account.id === bank.id)
        ?.balance,
    ).toBe("1000.00");
  });

  it("posts a card expense as an expense and increases the selected card liability", async () => {
    const { service } = newService();
    const card = await makeAccount(service, "user-a", "card", "CREDIT_CARD", "0.00");

    const transaction = await service.expense("user-a", "card-expense-1", {
      accountId: card.id,
      effectiveDate: "2026-11-25",
      amount: "750.00",
      description: "Train ticket",
    });

    expect(transaction.source).toBe("EXPENSE");
    expect(
      (await service.listAccounts("user-a")).find((account) => account.id === card.id)
        ?.balance,
    ).toBe("750.00");
    expect(
      transaction.entries
        .reduce((total, entry) => total.plus(entry.debitAmount), new Prisma.Decimal(0))
        .toFixed(2),
    ).toBe("750.00");
    expect(
      transaction.entries
        .reduce((total, entry) => total.plus(entry.creditAmount), new Prisma.Decimal(0))
        .toFixed(2),
    ).toBe("750.00");
  });

  it("posts a three-field expense through the configured default spending account", async () => {
    const { service } = newService();
    const bank = await makeAccount(service, "user-a", "bank", "BANK", "1000.00");
    await service.setDefaultExpenseAccount("user-a", "default-account", bank.id);
    const transaction = await service.expenseUsingDefault("user-a", "expense-default", {
      effectiveDate: "2026-11-24",
      amount: "1000.00",
      description: "Groceries",
    });
    const secondBank = await makeAccount(service, "user-a", "bank-b", "BANK", "100.00");
    await service.setDefaultExpenseAccount("user-a", "change-default", secondBank.id);
    const retry = await service.expenseUsingDefault("user-a", "expense-default", {
      effectiveDate: "2026-11-24",
      amount: "1000.00",
      description: "Groceries",
    });
    expect(retry.id).toBe(transaction.id);
    expect(transaction.source).toBe("EXPENSE");
    expect(
      (await service.listAccounts("user-a")).find((account) => account.id === bank.id)
        ?.balance,
    ).toBe("0.00");
  });

  it("uses the first bank, cash, or UPI account when no expense default is configured", async () => {
    const { service } = newService();
    const card = await makeAccount(service, "user-a", "card", "CREDIT_CARD", "0.00");
    const bank = await makeAccount(service, "user-a", "bank", "BANK", "2500.00");

    const transaction = await service.expenseUsingDefault("user-a", "fallback-expense", {
      effectiveDate: "2026-11-25",
      amount: "500.00",
      description: "Groceries",
    });

    expect(transaction.source).toBe("EXPENSE");
    expect(
      (await service.listAccounts("user-a")).find((account) => account.id === bank.id)
        ?.balance,
    ).toBe("2000.00");
    expect(
      (await service.listAccounts("user-a")).find((account) => account.id === card.id)
        ?.balance,
    ).toBe("0.00");
    expect((await service.getDefaultExpenseAccount("user-a"))?.id).toBe(bank.id);
  });

  it("tracks money given and received as a per-person receivable", async () => {
    const { repository, service } = newService();
    const bank = await makeAccount(service, "user-a", "bank", "BANK", "10000.00");
    repository.addPersonLedgerAccount("user-a", "person-receivable");
    await service.postPersonMovement("user-a", "give-1", {
      movement: "GIVE",
      personId: "person-1",
      personLedgerAccountId: "person-receivable",
      accountId: bank.id,
      effectiveDate: "2026-11-24",
      amount: "10000.00",
      description: "GIVE: Alex",
    });
    await service.postPersonMovement("user-a", "receive-1", {
      movement: "RECEIVE",
      personId: "person-1",
      personLedgerAccountId: "person-receivable",
      accountId: bank.id,
      effectiveDate: "2026-11-24",
      amount: "2000.00",
      description: "RECEIVE: Alex",
    });

    expect(repository.ledgerBalance("person-receivable", "DEBIT")).toBe("8000.00");
    expect(
      (await service.listAccounts("user-a")).find((account) => account.id === bank.id)
        ?.balance,
    ).toBe("2000.00");
  });

  it("tracks money borrowed and repaid as a per-person liability", async () => {
    const { repository, service } = newService();
    const bank = await makeAccount(service, "user-a", "bank", "BANK", "0.00");
    repository.addPersonLedgerAccount("user-a", "person-payable");
    await service.postPersonMovement("user-a", "borrow-1", {
      movement: "BORROW",
      personId: "person-2",
      personLedgerAccountId: "person-payable",
      accountId: bank.id,
      effectiveDate: "2026-11-24",
      amount: "20000.00",
      description: "BORROW: Alex",
    });
    await service.postPersonMovement("user-a", "repay-1", {
      movement: "REPAY",
      personId: "person-2",
      personLedgerAccountId: "person-payable",
      accountId: bank.id,
      effectiveDate: "2026-11-24",
      amount: "5000.00",
      description: "REPAY: Alex",
    });

    expect(repository.ledgerBalance("person-payable", "CREDIT")).toBe("15000.00");
    expect(
      (await service.listAccounts("user-a")).find((account) => account.id === bank.id)
        ?.balance,
    ).toBe("15000.00");
  });

  it("rejects spending or card payments that exceed the posted account balance", async () => {
    const { service, repository } = newService();
    const bank = await makeAccount(service, "user-a", "bank", "BANK", "500.00");
    const card = await makeAccount(service, "user-a", "card", "CREDIT_CARD", "100.00");

    await expect(
      service.expense("user-a", "too-large-expense", {
        accountId: bank.id,
        effectiveDate: "2026-11-24",
        amount: "500.01",
        description: "Overdraw the bank account",
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_FUNDS" });
    await expect(
      service.cardPayment("user-a", "too-large-payment", {
        creditCardAccountId: card.id,
        bankAccountId: bank.id,
        effectiveDate: "2026-11-24",
        amount: "100.01",
        description: "Pay more than the card owes",
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_FUNDS" });
    expect(repository.transactions.size).toBe(2);
  });

  it("keeps decimal precision exact and rounds half up to paise", () => {
    expect(formatMoney(parseMoney("0.1").plus(parseMoney("0.2")))).toBe("0.30");
    expect(formatMoney(parseMoney("1.005"))).toBe("1.01");
    expect(formatMoney(parseMoney("9999999999999999.99"))).toBe("9999999999999999.99");
    expect(() => parseMoney("10000000000000000")).toThrow("DECIMAL(18,2)");
    expect(() => parseMoney("1.00001")).toThrow("four fractional digits");
    expect(() => parseMoney("0.004")).toThrow("positive");
  });

  it("keeps every generated posting balanced across a range of decimal amounts", async () => {
    const { repository, service } = newService();
    const bankA = await makeAccount(service, "user-a", "source", "BANK", "100000.00");
    const bankB = await makeAccount(service, "user-a", "destination", "UPI", "0.00");
    for (let index = 1; index <= 100; index += 1) {
      await service.transfer("user-a", `generated-${index}`, {
        fromAccountId: bankA.id,
        toAccountId: bankB.id,
        effectiveDate: "2026-11-24",
        amount: `${index}.37`,
        description: `Generated transfer ${index}`,
      });
    }
    for (const transaction of repository.transactions.values()) {
      assertBalancedEntries(transaction.entries);
      const debits = transaction.entries.reduce(
        (sum, entry) => sum.plus(entry.debitAmount),
        new Prisma.Decimal(0),
      );
      const credits = transaction.entries.reduce(
        (sum, entry) => sum.plus(entry.creditAmount),
        new Prisma.Decimal(0),
      );
      expect(debits.equals(credits)).toBe(true);
    }
  });

  it("posts credit-card purchases as expense plus liability and card payments without a second expense", async () => {
    const { service } = newService();
    const bank = await makeAccount(service, "user-a", "bank", "BANK", "15000.00");
    const card = await makeAccount(service, "user-a", "card", "CREDIT_CARD", "2000.00");
    await service.cardPurchase("user-a", "purchase-1", {
      creditCardAccountId: card.id,
      effectiveDate: "2026-11-24",
      amount: "10000.00",
      description: "Card purchase",
    });
    expect(
      (await service.listAccounts("user-a")).find((account) => account.id === card.id)
        ?.balance,
    ).toBe("12000.00");

    await service.cardPayment("user-a", "payment-1", {
      creditCardAccountId: card.id,
      bankAccountId: bank.id,
      effectiveDate: "2026-11-24",
      amount: "10000.00",
      description: "Pay card bill",
    });
    const accounts = await service.listAccounts("user-a");
    expect(accounts.find((account) => account.id === card.id)?.balance).toBe("2000.00");
    expect(accounts.find((account) => account.id === bank.id)?.balance).toBe("5000.00");
  });

  it("reverses a posted transaction with opposite entries and prevents a second reversal", async () => {
    const { service } = newService();
    const bank = await makeAccount(service, "user-a", "bank", "BANK", "5000.00");
    const expense = await service.expense("user-a", "expense-1", {
      accountId: bank.id,
      effectiveDate: "2026-11-24",
      amount: "700.00",
      description: "Incorrect entry",
    });
    const reversal = await service.reverse("user-a", "reversal-1", expense.id, {
      effectiveDate: "2026-11-24",
      reason: "Entered twice",
    });
    expect(reversal.reversalOfId).toBe(expense.id);
    expect(reversal.entries[0]?.debitAmount).toBe(expense.entries[0]?.creditAmount);
    const duplicateReversal = await service.reverse("user-a", "reversal-1", expense.id, {
      effectiveDate: "2026-11-24",
      reason: "Entered twice",
    });
    expect(duplicateReversal.id).toBe(reversal.id);
    expect(
      (await service.listAccounts("user-a")).find((account) => account.id === bank.id)
        ?.balance,
    ).toBe("5000.00");
    await expect(
      service.reverse("user-a", "reversal-2", expense.id, {
        effectiveDate: "2026-11-24",
        reason: "Again",
      }),
    ).rejects.toMatchObject({ code: "TRANSACTION_ALREADY_REVERSED" });
  });

  it("ignores a duplicate idempotency key and rejects reusing it for different data", async () => {
    const { service, repository } = newService();
    const bank = await makeAccount(service, "user-a", "bank", "BANK", "3000.00");
    const input = {
      accountId: bank.id,
      effectiveDate: "2026-11-24",
      amount: "500.00",
      description: "Same request",
    };
    const first = await service.expense("user-a", "same-key", input);
    const retry = await service.expense("user-a", "same-key", input);
    expect(retry.id).toBe(first.id);
    expect(
      (await service.listAccounts("user-a")).find((account) => account.id === bank.id)
        ?.balance,
    ).toBe("2500.00");
    expect(repository.transactions.size).toBe(2);
    await expect(
      service.expense("user-a", "same-key", { ...input, amount: "400.00" }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("scopes financial accounts and transactions to their owner", async () => {
    const { service } = newService();
    const account = await makeAccount(service, "user-a", "bank", "BANK", "100.00");
    await expect(
      service.expense("user-b", "foreign-expense", {
        accountId: account.id,
        effectiveDate: "2026-11-24",
        amount: "1.00",
        description: "Cross-user attempt",
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
  });
});
