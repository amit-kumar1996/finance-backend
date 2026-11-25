export const financialAccountTypes = ["BANK", "CASH", "UPI", "CREDIT_CARD"] as const;
export type FinancialAccountType = (typeof financialAccountTypes)[number];

export type LedgerTransactionSource =
  | "OPENING_BALANCE"
  | "TRANSFER"
  | "EXPENSE"
  | "CREDIT_CARD_PURCHASE"
  | "CREDIT_CARD_PAYMENT"
  | "REVERSAL"
  | "PERSON_GIVE"
  | "PERSON_RECEIVE"
  | "PERSON_BORROW"
  | "PERSON_REPAY"
  | "LOAN_DISBURSEMENT"
  | "LOAN_OPENING_BALANCE"
  | "LOAN_EMI_PAYMENT"
  | "LOAN_PREPAYMENT"
  | "INVESTMENT_BUY"
  | "INVESTMENT_SELL"
  | "INVESTMENT_CONTRIBUTION"
  | "INVESTMENT_WITHDRAWAL"
  | "INVESTMENT_VALUATION";

export interface AccountSummary {
  id: string;
  name: string;
  accountType: FinancialAccountType;
  institutionName: string | null;
  balance: string;
  createdAt: Date;
}

export interface AccountReference {
  id: string;
  userId: string;
  name: string;
  accountType: FinancialAccountType;
  ledgerAccountId: string;
  ledgerNormalBalance: "DEBIT" | "CREDIT";
}

export interface TransactionEntryRecord {
  ledgerAccountId: string;
  debitAmount: string;
  creditAmount: string;
}

export interface LedgerTransactionRecord {
  id: string;
  userId: string;
  effectiveDate: string;
  description: string;
  source: LedgerTransactionSource;
  reversalOfId: string | null;
  reversedById: string | null;
  entries: TransactionEntryRecord[];
}

export interface IdempotentLedgerTransaction extends LedgerTransactionRecord {
  requestHash: string;
}

export interface CreateAccountRepositoryInput {
  userId: string;
  name: string;
  accountType: FinancialAccountType;
  institutionName: string | null;
  openingBalance: string;
  effectiveDate: string;
  idempotencyKey: string;
  requestHash: string;
}

export interface IdempotentResource {
  id: string;
  requestHash: string;
}

export interface PostTransactionRepositoryInput {
  userId: string;
  effectiveDate: string;
  description: string;
  source: LedgerTransactionSource;
  idempotencyKey: string;
  requestHash: string;
  entries: TransactionEntryRecord[];
  reversalOfId?: string;
  activePersonId?: string;
}

export interface ReplaceExpenseRepositoryInput {
  userId: string;
  originalTransactionId: string;
  reversalIdempotencyKey: string;
  replacementIdempotencyKey: string;
  reversalRequestHash: string;
  requestHash: string;
  effectiveDate: string;
  description: string;
  amount: string;
}

export interface ReplaceExpenseRepositoryResult {
  reversal: LedgerTransactionRecord;
  transaction: LedgerTransactionRecord;
}

export interface AccountsRepository {
  listAccounts(userId: string): Promise<AccountSummary[]>;
  getDefaultExpenseAccount(userId: string): Promise<AccountSummary | null>;
  setDefaultExpenseAccount(
    userId: string,
    accountId: string | null,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<void>;
  getAccount(userId: string, accountId: string): Promise<AccountReference | null>;
  getAccountSummary(userId: string, accountId: string): Promise<AccountSummary | null>;
  findAccountByIdempotencyKey(
    userId: string,
    idempotencyKey: string,
  ): Promise<IdempotentResource | null>;
  createAccount(input: CreateAccountRepositoryInput): Promise<string>;
  getSystemLedgerAccountId(
    userId: string,
    code: "OPENING_EQUITY" | "GENERAL_EXPENSE",
  ): Promise<string>;
  findTransactionByIdempotencyKey(
    userId: string,
    idempotencyKey: string,
  ): Promise<IdempotentLedgerTransaction | null>;
  findTransaction(
    userId: string,
    transactionId: string,
  ): Promise<LedgerTransactionRecord | null>;
  postTransaction(
    input: PostTransactionRepositoryInput,
  ): Promise<LedgerTransactionRecord>;
  replaceExpense(
    input: ReplaceExpenseRepositoryInput,
  ): Promise<ReplaceExpenseRepositoryResult>;
}
