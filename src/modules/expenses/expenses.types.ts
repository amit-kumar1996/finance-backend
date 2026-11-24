export interface ExpenseFilters {
  search?: string;
  from?: string;
  to?: string;
  month?: string;
}

export interface ExpenseRecord {
  id: string;
  effectiveDate: string;
  description: string;
  amount: string;
  accountId: string;
  accountName: string;
}

export interface ExpensePeriodTotal {
  period: string;
  total: string;
  previousPeriod: string;
  previousTotal: string;
  difference: string;
}

export interface ExpenseSummary {
  date: string;
  daily: {
    period: string;
    total: string;
    previousTotal: string;
    difference: string;
  };
  monthly: ExpensePeriodTotal;
  yearly: ExpensePeriodTotal;
}

export interface ExpensesRepository {
  listExpenses(userId: string, filters: ExpenseFilters): Promise<ExpenseRecord[]>;
  getSummary(userId: string, date: string): Promise<ExpenseSummary>;
}
