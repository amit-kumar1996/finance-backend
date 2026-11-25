import { createHash } from "node:crypto";
import { Prisma } from "../../generated/prisma/client.js";
import { HttpError } from "../../lib/http-error.js";
import { formatMoney, parseMoney } from "../accounts/money.js";
import { calculateEmi, generateSchedule, paymentSplit } from "./loans.math.js";
import type {
  LoanInput,
  LoanPaymentInput,
  LoanPrepaymentInput,
  LoansRepository,
} from "./loans.types.js";

const fingerprint = (input: unknown): string =>
  createHash("sha256").update(JSON.stringify(input)).digest("hex");

export class LoansService {
  constructor(private readonly repository: LoansRepository) {}

  async list(userId: string) {
    const loans = await this.repository.listLoans(userId);
    return loans.map((loan) => {
      const remainingPayments = Math.max(1, loan.termMonths - loan.paymentCount);
      const firstDue = this.firstDueDate(loan.startDate, loan.dueDay, loan.paymentCount);
      const schedule = generateSchedule({
        outstanding: loan.outstanding,
        annualRate: loan.annualRate,
        emiAmount: loan.emiAmount,
        dueDay: loan.dueDay,
        firstDueDate: firstDue,
        remainingPayments,
      });
      return { ...loan, schedule, nextDueDate: schedule[0]?.dueDate ?? null };
    });
  }

  async create(userId: string, idempotencyKey: string, input: LoanInput) {
    const principal = formatMoney(parseMoney(input.principal));
    const annualRate = new Prisma.Decimal(input.annualRate).toDecimalPlaces(4).toFixed(4);
    const emiAmount = calculateEmi(principal, annualRate, input.termMonths);
    if (input.setupMode === "DISBURSEMENT" && !input.fundingAccountId) {
      throw new HttpError(
        400,
        "FUNDING_ACCOUNT_REQUIRED",
        "Choose the account receiving the loan.",
      );
    }
    if (input.setupMode === "EXISTING_BALANCE" && input.fundingAccountId) {
      throw new HttpError(
        400,
        "FUNDING_ACCOUNT_UNEXPECTED",
        "An existing loan does not change an account balance.",
      );
    }
    const normalized = {
      name: input.name.trim(),
      provider: input.provider.trim(),
      principal,
      annualRate,
      termMonths: input.termMonths,
      dueDay: input.dueDay,
      startDate: input.startDate,
      emiAmount,
    };
    const requestHash = fingerprint({
      ...normalized,
      setupMode: input.setupMode,
      fundingAccountId: input.fundingAccountId ?? null,
    });
    const id = await this.repository.createLoan({
      userId,
      idempotencyKey,
      requestHash,
      loan: normalized,
      setupMode: input.setupMode,
      fundingAccountId: input.fundingAccountId ?? null,
    });
    const loan = await this.repository.findLoan(userId, id);
    if (!loan) throw new Error("Created loan could not be loaded.");
    return loan;
  }

  async payment(
    userId: string,
    loanId: string,
    idempotencyKey: string,
    input: LoanPaymentInput,
  ) {
    const loan = await this.requireLoan(userId, loanId);
    const split = paymentSplit({
      amount: formatMoney(parseMoney(input.amount)),
      principalAmount: formatMoney(parseMoney(input.principalAmount, true)),
      interestAmount: formatMoney(parseMoney(input.interestAmount, true)),
      outstanding: loan.outstanding,
    });
    if (!split)
      throw new HttpError(
        400,
        "PAYMENT_SPLIT_INVALID",
        "Payment must equal principal plus interest, and principal cannot exceed the outstanding balance.",
      );
    const requestHash = fingerprint({ loanId, ...input, ...split });
    await this.repository.postPayment({
      userId,
      loanId,
      idempotencyKey,
      requestHash,
      effectiveDate: input.effectiveDate,
      accountId: input.accountId,
      ...split,
      countsAsEmi: input.countsAsEmi,
      description: input.note.trim() || `${loan.name} EMI payment`,
    });
  }

  async prepayment(
    userId: string,
    loanId: string,
    idempotencyKey: string,
    input: LoanPrepaymentInput,
  ) {
    const loan = await this.requireLoan(userId, loanId);
    const amount = formatMoney(parseMoney(input.amount));
    if (new Prisma.Decimal(amount).gt(loan.outstanding)) {
      throw new HttpError(
        400,
        "PREPAYMENT_EXCEEDS_BALANCE",
        "Prepayment cannot exceed the outstanding loan balance.",
      );
    }
    const requestHash = fingerprint({ loanId, ...input, amount });
    await this.repository.postPrepayment({
      userId,
      loanId,
      idempotencyKey,
      requestHash,
      effectiveDate: input.effectiveDate,
      accountId: input.accountId,
      amount,
      description: input.note.trim() || `${loan.name} principal prepayment`,
    });
  }

  private async requireLoan(userId: string, loanId: string) {
    const loan = await this.repository.findLoan(userId, loanId);
    if (!loan) throw new HttpError(404, "LOAN_NOT_FOUND", "The loan was not found.");
    if (loan.status === "CLOSED" || new Prisma.Decimal(loan.outstanding).isZero()) {
      throw new HttpError(409, "LOAN_CLOSED", "This loan has no outstanding balance.");
    }
    return loan;
  }

  private firstDueDate(startDate: string, dueDay: number, paymentCount: number): string {
    const start = new Date(`${startDate}T00:00:00.000Z`);
    const due = (year: number, month: number) => {
      const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      return new Date(Date.UTC(year, month, Math.min(dueDay, lastDay)));
    };
    const target = new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + paymentCount + 1, 1),
    );
    const candidate = due(target.getUTCFullYear(), target.getUTCMonth());
    return candidate.toISOString().slice(0, 10);
  }
}
