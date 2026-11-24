import { HttpError } from "../../lib/http-error.js";
import type { AccountsService } from "../accounts/accounts.service.js";
import type {
  ExpenseFilters,
  ExpenseRecord,
  ExpenseSummary,
  ExpensesRepository,
} from "./expenses.types.js";

export class ExpensesService {
  constructor(
    private readonly repository: ExpensesRepository,
    private readonly accounts: AccountsService,
  ) {}

  listExpenses(userId: string, filters: ExpenseFilters): Promise<ExpenseRecord[]> {
    if (filters.from && filters.to && filters.from > filters.to) {
      throw new HttpError(
        400,
        "DATE_RANGE_INVALID",
        "The start date must be before the end date.",
      );
    }
    return this.repository.listExpenses(userId, filters);
  }

  getSummary(userId: string, date: string): Promise<ExpenseSummary> {
    return this.repository.getSummary(userId, date);
  }

  async createExpense(
    userId: string,
    idempotencyKey: string,
    input: { effectiveDate: string; amount: string; description: string },
  ) {
    const transaction = await this.accounts.expenseUsingDefault(
      userId,
      idempotencyKey,
      input,
    );
    return { transaction };
  }

  async editExpense(
    userId: string,
    idempotencyKey: string,
    expenseId: string,
    input: { effectiveDate: string; amount: string; description: string },
  ) {
    return this.accounts.editExpense(userId, idempotencyKey, expenseId, input);
  }

  async deleteExpense(userId: string, idempotencyKey: string, expenseId: string) {
    const transaction = await this.accounts.deleteExpense(
      userId,
      idempotencyKey,
      expenseId,
    );
    return { transaction };
  }
}
