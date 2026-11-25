import { createHash } from "node:crypto";
import { HttpError } from "../../lib/http-error.js";
import { assertBalancedEntries, formatMoney, parseMoney } from "./money.js";
import type {
  AccountReference,
  AccountSummary,
  AccountsRepository,
  FinancialAccountType,
  LedgerTransactionRecord,
  LedgerTransactionSource,
  PostTransactionRepositoryInput,
  ReplaceExpenseRepositoryResult,
  TransactionEntryRecord,
} from "./accounts.types.js";

const fingerprint = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const isUniqueConstraintError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "P2002";

const todayInKolkata = (): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const datePart = (type: "year" | "month" | "day") =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${datePart("year")}-${datePart("month")}-${datePart("day")}`;
};

export class AccountsService {
  constructor(private readonly repository: AccountsRepository) {}

  listAccounts(userId: string): Promise<AccountSummary[]> {
    return this.repository.listAccounts(userId);
  }

  async getDefaultExpenseAccount(userId: string): Promise<AccountSummary | null> {
    const configured = await this.repository.getDefaultExpenseAccount(userId);
    if (configured && configured.accountType !== "CREDIT_CARD") return configured;
    const accounts = await this.repository.listAccounts(userId);
    return accounts.find((account) => account.accountType !== "CREDIT_CARD") ?? null;
  }

  async setDefaultExpenseAccount(
    userId: string,
    idempotencyKey: string,
    accountId: string | null,
  ): Promise<AccountSummary | null> {
    const requestHash = fingerprint({ operation: "DEFAULT_EXPENSE_ACCOUNT", accountId });
    await this.repository.setDefaultExpenseAccount(
      userId,
      accountId,
      idempotencyKey,
      requestHash,
    );
    return this.getDefaultExpenseAccount(userId);
  }

  async expenseUsingDefault(
    userId: string,
    idempotencyKey: string,
    input: { effectiveDate: string; amount: string; description: string },
  ): Promise<LedgerTransactionRecord> {
    const amount = formatMoney(parseMoney(input.amount));
    const description = input.description.trim();
    const existing = await this.repository.findTransactionByIdempotencyKey(
      userId,
      idempotencyKey,
    );
    if (existing) {
      const existingAmount = existing.entries.reduce(
        (sum, entry) => sum.plus(entry.debitAmount),
        parseMoney("0", true),
      );
      if (
        existing.source !== "EXPENSE" ||
        existing.effectiveDate !== input.effectiveDate ||
        existing.description !== description ||
        !existingAmount.equals(amount)
      ) {
        throw new HttpError(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "This idempotency key was already used for different data.",
        );
      }
      return existing;
    }
    const account = await this.getDefaultExpenseAccount(userId);
    if (!account) {
      throw new HttpError(
        409,
        "DEFAULT_EXPENSE_ACCOUNT_REQUIRED",
        "Choose a default expense account on the Accounts page before adding expenses.",
      );
    }
    return this.expense(userId, idempotencyKey, {
      ...input,
      amount,
      description,
      accountId: account.id,
    });
  }

  async editExpense(
    userId: string,
    idempotencyKey: string,
    transactionId: string,
    input: { effectiveDate: string; amount: string; description: string },
  ): Promise<ReplaceExpenseRepositoryResult> {
    const amount = formatMoney(parseMoney(input.amount));
    const description = input.description.trim();
    const requestHash = fingerprint({
      operation: "EDIT_EXPENSE",
      transactionId,
      effectiveDate: input.effectiveDate,
      amount,
      description,
    });
    const keyDigest = createHash("sha256")
      .update(`${userId}:${idempotencyKey}`)
      .digest("hex")
      .slice(0, 40);
    return this.repository.replaceExpense({
      userId,
      originalTransactionId: transactionId,
      reversalIdempotencyKey: `EXP_EDIT_${keyDigest}_REV`,
      replacementIdempotencyKey: `EXP_EDIT_${keyDigest}_NEW`,
      reversalRequestHash: fingerprint({ requestHash, kind: "REVERSAL" }),
      requestHash,
      effectiveDate: input.effectiveDate,
      description,
      amount,
    });
  }

  async deleteExpense(
    userId: string,
    idempotencyKey: string,
    transactionId: string,
  ): Promise<LedgerTransactionRecord> {
    const transaction = await this.repository.findTransaction(userId, transactionId);
    if (!transaction)
      throw new HttpError(404, "EXPENSE_NOT_FOUND", "The expense was not found.");
    if (transaction.source !== "EXPENSE") {
      throw new HttpError(400, "EXPENSE_REQUIRED", "Only expenses can be deleted here.");
    }
    return this.reverse(userId, idempotencyKey, transactionId, {
      effectiveDate: transaction.effectiveDate,
      reason: "Expense deleted",
    });
  }

  async createAccount(
    userId: string,
    idempotencyKey: string,
    input: {
      name: string;
      accountType: FinancialAccountType;
      institutionName?: string | null;
      openingBalance: string;
      effectiveDate?: string;
    },
  ): Promise<AccountSummary> {
    const openingBalance = parseMoney(input.openingBalance, true);
    const effectiveDate = input.effectiveDate ?? todayInKolkata();
    const normalized = {
      name: input.name.trim(),
      accountType: input.accountType,
      institutionName: input.institutionName?.trim() || null,
      openingBalance: formatMoney(openingBalance),
      effectiveDate,
    };
    const requestHash = fingerprint(normalized);
    const previous = await this.repository.findAccountByIdempotencyKey(
      userId,
      idempotencyKey,
    );
    if (previous) {
      this.assertSameRequest(previous.requestHash, requestHash);
      const account = await this.repository.getAccountSummary(userId, previous.id);
      if (!account)
        throw new HttpError(404, "ACCOUNT_NOT_FOUND", "The account was not found.");
      return account;
    }

    try {
      const accountId = await this.repository.createAccount({
        userId,
        ...normalized,
        openingBalance: normalized.openingBalance,
        idempotencyKey,
        requestHash,
      });
      const account = await this.repository.getAccountSummary(userId, accountId);
      if (!account) throw new Error("Created account could not be read back.");
      return account;
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const raced = await this.repository.findAccountByIdempotencyKey(
        userId,
        idempotencyKey,
      );
      if (!raced) throw error;
      this.assertSameRequest(raced.requestHash, requestHash);
      const account = await this.repository.getAccountSummary(userId, raced.id);
      if (!account)
        throw new HttpError(404, "ACCOUNT_NOT_FOUND", "The account was not found.");
      return account;
    }
  }

  async transfer(
    userId: string,
    idempotencyKey: string,
    input: {
      fromAccountId: string;
      toAccountId: string;
      effectiveDate: string;
      amount: string;
      description: string;
    },
  ): Promise<LedgerTransactionRecord> {
    if (input.fromAccountId === input.toAccountId) {
      throw new HttpError(
        400,
        "TRANSFER_ACCOUNTS_INVALID",
        "Choose two different accounts for a transfer.",
      );
    }
    const source = await this.requireAccount(userId, input.fromAccountId);
    const destination = await this.requireAccount(userId, input.toAccountId);
    if (
      source.accountType === "CREDIT_CARD" ||
      destination.accountType === "CREDIT_CARD"
    ) {
      throw new HttpError(
        400,
        "TRANSFER_ACCOUNTS_INVALID",
        "Use a card payment for credit-card balances.",
      );
    }
    const amount = formatMoney(parseMoney(input.amount));
    return this.post(userId, idempotencyKey, "TRANSFER", {
      effectiveDate: input.effectiveDate,
      description: input.description,
      fromAccountId: source.id,
      toAccountId: destination.id,
      amount,
      entries: [
        this.entry(destination.ledgerAccountId, amount, "0.00"),
        this.entry(source.ledgerAccountId, "0.00", amount),
      ],
    });
  }

  async expense(
    userId: string,
    idempotencyKey: string,
    input: {
      accountId: string;
      effectiveDate: string;
      amount: string;
      description: string;
    },
  ): Promise<LedgerTransactionRecord> {
    const account = await this.requireAccount(userId, input.accountId);
    const amount = formatMoney(parseMoney(input.amount));
    const expenseAccountId = await this.repository.getSystemLedgerAccountId(
      userId,
      "GENERAL_EXPENSE",
    );
    return this.post(userId, idempotencyKey, "EXPENSE", {
      effectiveDate: input.effectiveDate,
      description: input.description,
      accountId: account.id,
      amount,
      entries: [
        this.entry(expenseAccountId, amount, "0.00"),
        this.entry(account.ledgerAccountId, "0.00", amount),
      ],
    });
  }

  async cardPurchase(
    userId: string,
    idempotencyKey: string,
    input: {
      creditCardAccountId: string;
      effectiveDate: string;
      amount: string;
      description: string;
    },
  ): Promise<LedgerTransactionRecord> {
    const card = await this.requireAccount(userId, input.creditCardAccountId);
    if (card.accountType !== "CREDIT_CARD") {
      throw new HttpError(400, "CREDIT_CARD_REQUIRED", "Choose a credit-card account.");
    }
    const amount = formatMoney(parseMoney(input.amount));
    const expenseAccountId = await this.repository.getSystemLedgerAccountId(
      userId,
      "GENERAL_EXPENSE",
    );
    return this.post(userId, idempotencyKey, "CREDIT_CARD_PURCHASE", {
      effectiveDate: input.effectiveDate,
      description: input.description,
      cardAccountId: card.id,
      amount,
      entries: [
        this.entry(expenseAccountId, amount, "0.00"),
        this.entry(card.ledgerAccountId, "0.00", amount),
      ],
    });
  }

  async cardPayment(
    userId: string,
    idempotencyKey: string,
    input: {
      creditCardAccountId: string;
      bankAccountId: string;
      effectiveDate: string;
      amount: string;
      description: string;
    },
  ): Promise<LedgerTransactionRecord> {
    const card = await this.requireAccount(userId, input.creditCardAccountId);
    const bank = await this.requireAssetAccount(userId, input.bankAccountId);
    if (card.accountType !== "CREDIT_CARD") {
      throw new HttpError(400, "CREDIT_CARD_REQUIRED", "Choose a credit-card account.");
    }
    const amount = formatMoney(parseMoney(input.amount));
    return this.post(userId, idempotencyKey, "CREDIT_CARD_PAYMENT", {
      effectiveDate: input.effectiveDate,
      description: input.description,
      cardAccountId: card.id,
      bankAccountId: bank.id,
      amount,
      entries: [
        this.entry(card.ledgerAccountId, amount, "0.00"),
        this.entry(bank.ledgerAccountId, "0.00", amount),
      ],
    });
  }

  async postPersonMovement(
    userId: string,
    idempotencyKey: string,
    input: {
      movement: "GIVE" | "RECEIVE" | "BORROW" | "REPAY";
      personLedgerAccountId: string;
      personId: string;
      accountId: string;
      effectiveDate: string;
      amount: string;
      description: string;
    },
  ): Promise<LedgerTransactionRecord> {
    const account = await this.requireAssetAccount(userId, input.accountId);
    const amount = formatMoney(parseMoney(input.amount));
    const sourceByMovement = {
      GIVE: "PERSON_GIVE",
      RECEIVE: "PERSON_RECEIVE",
      BORROW: "PERSON_BORROW",
      REPAY: "PERSON_REPAY",
    } as const;
    const debitAccountId =
      input.movement === "GIVE" || input.movement === "REPAY"
        ? input.personLedgerAccountId
        : account.ledgerAccountId;
    const creditAccountId =
      input.movement === "GIVE" || input.movement === "REPAY"
        ? account.ledgerAccountId
        : input.personLedgerAccountId;
    return this.post(userId, idempotencyKey, sourceByMovement[input.movement], {
      effectiveDate: input.effectiveDate,
      description: input.description,
      personLedgerAccountId: input.personLedgerAccountId,
      activePersonId: input.personId,
      accountId: account.id,
      movement: input.movement,
      amount,
      entries: [
        this.entry(debitAccountId, amount, "0.00"),
        this.entry(creditAccountId, "0.00", amount),
      ],
    });
  }

  async reverse(
    userId: string,
    idempotencyKey: string,
    transactionId: string,
    input: { effectiveDate: string; reason: string },
  ): Promise<LedgerTransactionRecord> {
    const original = await this.repository.findTransaction(userId, transactionId);
    if (!original)
      throw new HttpError(404, "TRANSACTION_NOT_FOUND", "The transaction was not found.");
    if (original.source === "REVERSAL") {
      throw new HttpError(
        400,
        "REVERSAL_NOT_ALLOWED",
        "A reversal transaction cannot be reversed.",
      );
    }
    const entries = original.entries.map((entry) =>
      this.entry(entry.ledgerAccountId, entry.creditAmount, entry.debitAmount),
    );
    return this.post(userId, idempotencyKey, "REVERSAL", {
      effectiveDate: input.effectiveDate,
      description: `Reversal: ${input.reason}`,
      originalTransactionId: original.id,
      reason: input.reason,
      entries,
      reversalOfId: original.id,
    });
  }

  private async post(
    userId: string,
    idempotencyKey: string,
    source: LedgerTransactionSource,
    input: {
      effectiveDate: string;
      description: string;
      entries: TransactionEntryRecord[];
      reversalOfId?: string;
      activePersonId?: string;
      [key: string]: unknown;
    },
  ): Promise<LedgerTransactionRecord> {
    assertBalancedEntries(input.entries);
    const requestHash = fingerprint({ source, ...input });
    const previous = await this.repository.findTransactionByIdempotencyKey(
      userId,
      idempotencyKey,
    );
    if (previous) {
      this.assertSameRequest(previous.requestHash, requestHash);
      return previous;
    }

    const transactionInput: PostTransactionRepositoryInput = {
      userId,
      effectiveDate: input.effectiveDate,
      description: input.description,
      source,
      idempotencyKey,
      requestHash,
      entries: input.entries,
      ...(input.reversalOfId ? { reversalOfId: input.reversalOfId } : {}),
      ...(input.activePersonId ? { activePersonId: input.activePersonId } : {}),
    };
    try {
      return await this.repository.postTransaction(transactionInput);
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const raced = await this.repository.findTransactionByIdempotencyKey(
        userId,
        idempotencyKey,
      );
      if (raced) {
        this.assertSameRequest(raced.requestHash, requestHash);
        return raced;
      }
      if (input.reversalOfId) {
        throw new HttpError(
          409,
          "TRANSACTION_ALREADY_REVERSED",
          "This transaction has already been reversed.",
        );
      }
      throw error;
    }
  }

  private async requireAccount(
    userId: string,
    accountId: string,
  ): Promise<AccountReference> {
    const account = await this.repository.getAccount(userId, accountId);
    if (!account)
      throw new HttpError(404, "ACCOUNT_NOT_FOUND", "The account was not found.");
    return account;
  }

  private async requireAssetAccount(
    userId: string,
    accountId: string,
  ): Promise<AccountReference> {
    const account = await this.requireAccount(userId, accountId);
    if (account.accountType === "CREDIT_CARD") {
      throw new HttpError(
        400,
        "ASSET_ACCOUNT_REQUIRED",
        "Choose a bank, cash, or UPI account.",
      );
    }
    return account;
  }

  private entry(
    ledgerAccountId: string,
    debitAmount: string,
    creditAmount: string,
  ): TransactionEntryRecord {
    return { ledgerAccountId, debitAmount, creditAmount };
  }

  private assertSameRequest(existingHash: string, requestHash: string): void {
    if (existingHash !== requestHash) {
      throw new HttpError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "This idempotency key was already used for different data.",
      );
    }
  }
}
