import type { PrismaClient } from "../../generated/prisma/client.js";
import { Prisma } from "../../generated/prisma/client.js";
import type {
  ExpenseFilters,
  ExpensePeriodTotal,
  ExpenseRecord,
  ExpenseSummary,
  ExpensesRepository,
} from "./expenses.types.js";

const dateAtUtc = (value: string): Date => new Date(`${value}T00:00:00.000Z`);
const dateString = (value: Date): string => value.toISOString().slice(0, 10);

export const getMonthBounds = (month: string): { from: string; to: string } => {
  const [yearText = "0", monthText = "1"] = month.split("-");
  const year = Number.parseInt(yearText, 10);
  const monthNumber = Number.parseInt(monthText, 10);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return {
    from: `${yearText}-${monthText}-01`,
    to: `${yearText}-${monthText}-${String(lastDay).padStart(2, "0")}`,
  };
};

const dateBounds = (from: string, to: string) => ({
  gte: dateAtUtc(from),
  lte: dateAtUtc(to),
});

export const getPreviousDate = (date: string): string => {
  const value = dateAtUtc(date);
  value.setUTCDate(value.getUTCDate() - 1);
  return dateString(value);
};

export const getPreviousMonthBounds = (month: string): { from: string; to: string } => {
  const [yearText = "0", monthText = "1"] = month.split("-");
  const previousMonth = new Date(
    Date.UTC(Number.parseInt(yearText, 10), Number.parseInt(monthText, 10) - 2, 1),
  );
  return getMonthBounds(
    `${previousMonth.getUTCFullYear()}-${String(previousMonth.getUTCMonth() + 1).padStart(2, "0")}`,
  );
};

const monthTotal = (
  period: string,
  total: Prisma.Decimal,
  previousPeriod: string,
  previousTotal: Prisma.Decimal,
): ExpensePeriodTotal => ({
  period,
  total: total.toFixed(2),
  previousPeriod,
  previousTotal: previousTotal.toFixed(2),
  difference: total.minus(previousTotal).toFixed(2),
});

export class PrismaExpensesRepository implements ExpensesRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listExpenses(userId: string, filters: ExpenseFilters): Promise<ExpenseRecord[]> {
    const from = filters.from;
    const to = filters.to;
    const month = filters.month ? getMonthBounds(filters.month) : undefined;
    const effectiveDate: { gte?: Date; lte?: Date } = {};
    if (from) effectiveDate.gte = dateAtUtc(from);
    if (to) effectiveDate.lte = dateAtUtc(to);
    if (month) {
      const monthRange = dateBounds(month.from, month.to);
      if (!effectiveDate.gte || monthRange.gte > effectiveDate.gte)
        effectiveDate.gte = monthRange.gte;
      if (!effectiveDate.lte || monthRange.lte < effectiveDate.lte)
        effectiveDate.lte = monthRange.lte;
    }
    const rows = await this.prisma.ledgerTransaction.findMany({
      where: {
        userId,
        source: "EXPENSE",
        reversedBy: { is: null },
        ...(filters.search ? { description: { contains: filters.search } } : {}),
        ...(Object.keys(effectiveDate).length ? { effectiveDate } : {}),
      },
      select: {
        id: true,
        effectiveDate: true,
        description: true,
        entries: {
          select: {
            debitAmount: true,
            creditAmount: true,
            ledgerAccount: {
              select: {
                category: true,
                financialAccount: { select: { id: true, name: true } },
              },
            },
          },
        },
      },
      orderBy: [{ effectiveDate: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    });
    return rows.flatMap((row) => {
      const expenseEntry = row.entries.find(
        (entry) => entry.ledgerAccount.category === "EXPENSE",
      );
      const paymentEntry = row.entries.find(
        (entry) => entry.ledgerAccount.financialAccount !== null,
      );
      const account = paymentEntry?.ledgerAccount.financialAccount;
      if (!expenseEntry || !account) return [];
      return [
        {
          id: row.id,
          effectiveDate: dateString(row.effectiveDate),
          description: row.description,
          amount: expenseEntry.debitAmount.toFixed(2),
          accountId: account.id,
          accountName: account.name,
        },
      ];
    });
  }

  async getSummary(userId: string, date: string): Promise<ExpenseSummary> {
    const dayTotal = await this.totalBetween(userId, date, date);
    const previousDate = getPreviousDate(date);
    const previousDayTotal = await this.totalBetween(userId, previousDate, previousDate);

    const month = date.slice(0, 7);
    const currentMonthBounds = getMonthBounds(month);
    const previousMonth = getPreviousMonthBounds(month);
    const currentMonthTotal = await this.totalBetween(
      userId,
      currentMonthBounds.from,
      currentMonthBounds.to,
    );
    const previousMonthTotal = await this.totalBetween(
      userId,
      previousMonth.from,
      previousMonth.to,
    );

    const year = date.slice(0, 4);
    const currentYearTotal = await this.totalBetween(
      userId,
      `${year}-01-01`,
      `${year}-12-31`,
    );
    const previousYear = String(Number.parseInt(year, 10) - 1).padStart(4, "0");
    const previousYearTotal = await this.totalBetween(
      userId,
      `${previousYear}-01-01`,
      `${previousYear}-12-31`,
    );
    return {
      date,
      daily: {
        period: date,
        total: dayTotal.toFixed(2),
        previousTotal: previousDayTotal.toFixed(2),
        difference: dayTotal.minus(previousDayTotal).toFixed(2),
      },
      monthly: monthTotal(
        month,
        currentMonthTotal,
        previousMonth.from.slice(0, 7),
        previousMonthTotal,
      ),
      yearly: monthTotal(year, currentYearTotal, previousYear, previousYearTotal),
    };
  }

  private async totalBetween(
    userId: string,
    from: string,
    to: string,
  ): Promise<Prisma.Decimal> {
    const result = await this.prisma.transactionEntry.aggregate({
      where: {
        ledgerAccount: { category: "EXPENSE" },
        transaction: {
          userId,
          source: "EXPENSE",
          reversedBy: { is: null },
          effectiveDate: dateBounds(from, to),
        },
      },
      _sum: { debitAmount: true },
    });
    return result._sum?.debitAmount ?? new Prisma.Decimal(0);
  }
}
