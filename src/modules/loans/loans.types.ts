export type LoanSetupMode = "DISBURSEMENT" | "EXISTING_BALANCE";

export interface LoanInput {
  name: string;
  provider: string;
  principal: string;
  annualRate: string;
  termMonths: number;
  dueDay: number;
  startDate: string;
  setupMode: LoanSetupMode;
  fundingAccountId?: string | null;
}

export interface LoanPaymentInput {
  effectiveDate: string;
  accountId: string;
  amount: string;
  principalAmount: string;
  interestAmount: string;
  countsAsEmi: boolean;
  note: string;
}

export interface LoanPrepaymentInput {
  effectiveDate: string;
  accountId: string;
  amount: string;
  note: string;
}

export interface LoanRecord {
  id: string;
  name: string;
  provider: string;
  principal: string;
  annualRate: string;
  termMonths: number;
  emiAmount: string;
  dueDay: number;
  startDate: string;
  status: "ACTIVE" | "CLOSED";
  outstanding: string;
  paymentCount: number;
}

export interface LoansRepository {
  listLoans(userId: string): Promise<LoanRecord[]>;
  createLoan(input: {
    userId: string;
    idempotencyKey: string;
    requestHash: string;
    loan: Omit<LoanInput, "setupMode" | "fundingAccountId"> & { emiAmount: string };
    setupMode: LoanSetupMode;
    fundingAccountId: string | null;
  }): Promise<string>;
  findLoan(userId: string, loanId: string): Promise<LoanRecord | null>;
  postPayment(input: {
    userId: string;
    loanId: string;
    idempotencyKey: string;
    requestHash: string;
    effectiveDate: string;
    accountId: string;
    amount: string;
    principalAmount: string;
    interestAmount: string;
    countsAsEmi: boolean;
    description: string;
  }): Promise<void>;
  postPrepayment(input: {
    userId: string;
    loanId: string;
    idempotencyKey: string;
    requestHash: string;
    effectiveDate: string;
    accountId: string;
    amount: string;
    description: string;
  }): Promise<void>;
}
