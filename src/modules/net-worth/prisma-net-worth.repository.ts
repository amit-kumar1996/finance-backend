import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import {
  calculateNetWorthPosition,
  type LedgerBalanceInput,
  type NetWorthPosition,
} from "./net-worth.math.js";
import type {
  MonthSummary,
  NetWorthHistoryPoint,
  NetWorthRepository,
} from "./net-worth.types.js";

const asDate = (date: string) => new Date(`${date}T00:00:00.000Z`);
const dateOnly = (date: Date) => date.toISOString().slice(0, 10);
const money = (value: Prisma.Decimal) =>
  value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toFixed(2);
const zero = () => new Prisma.Decimal(0);
const monthKey = (date: Date) => dateOnly(date).slice(0, 7);

const investmentLabel = (type: string): string =>
  ({
    NPS: "NPS",
    MUTUAL_FUND: "Mutual funds",
    STOCK: "Stocks",
    FD: "FD",
    PPF: "PPF",
    EPF: "EPF",
  })[type] ?? "Investments";

export class PrismaNetWorthRepository implements NetWorthRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async getPosition(userId: string, asOfDate: string): Promise<NetWorthPosition> {
    const accounts = await this.prisma.ledgerAccount.findMany({
      where: { userId },
      include: {
        financialAccount: { select: { accountType: true } },
        investment: { select: { investmentType: true } },
        personReceivable: { select: { id: true } },
        personPayable: { select: { id: true } },
        loan: { select: { name: true } },
      },
      orderBy: { name: "asc" },
    });
    if (accounts.length === 0) return calculateNetWorthPosition([], asOfDate);
    const totals = await this.prisma.transactionEntry.groupBy({
      by: ["ledgerAccountId"],
      where: {
        ledgerAccountId: { in: accounts.map((account) => account.id) },
        transaction: { is: { userId, effectiveDate: { lte: asDate(asOfDate) } } },
      },
      _sum: { debitAmount: true, creditAmount: true },
    });
    const totalMap = new Map(totals.map((row) => [row.ledgerAccountId, row._sum]));
    const ledgerInputs: LedgerBalanceInput[] = accounts.map((account) => {
      const sum = totalMap.get(account.id);
      let bucket: string | null = null;
      let label = account.name;
      if (account.category === "ASSET") {
        if (
          account.financialAccount &&
          account.financialAccount.accountType !== "CREDIT_CARD"
        ) {
          bucket = "cash";
          label = "Bank, cash and UPI";
        } else if (account.investment) {
          bucket = `investment:${account.investment.investmentType}`;
          label = investmentLabel(account.investment.investmentType);
        } else if (account.personReceivable) {
          bucket = "receivable";
          label = "Receivables";
        } else {
          bucket = "otherAssets";
        }
      } else if (account.category === "LIABILITY") {
        if (account.loan) {
          bucket = "loan";
          label = account.loan.name;
        } else if (account.financialAccount?.accountType === "CREDIT_CARD") {
          bucket = "creditCard";
        } else if (account.personPayable) {
          bucket = "peoplePayable";
          label = "Borrowed from people";
        } else {
          bucket = "otherLiabilities";
        }
      }
      return {
        id: account.id,
        name: account.name,
        category: account.category,
        normalBalance: account.normalBalance,
        debits: sum?.debitAmount?.toFixed(2) ?? "0.00",
        credits: sum?.creditAmount?.toFixed(2) ?? "0.00",
        bucket,
        label,
      };
    });
    return calculateNetWorthPosition(ledgerInputs, asOfDate);
  }

  async saveSnapshot(userId: string, position: NetWorthPosition): Promise<void> {
    const date = asDate(position.asOfDate);
    const assetBreakdown = position.assetBreakdown as unknown as Prisma.InputJsonValue;
    const liabilityBreakdown =
      position.liabilityBreakdown as unknown as Prisma.InputJsonValue;
    await this.prisma.netWorthSnapshot.upsert({
      where: { userId_snapshotDate: { userId, snapshotDate: date } },
      create: {
        userId,
        snapshotDate: date,
        totalAssets: new Prisma.Decimal(position.totalAssets),
        totalLiabilities: new Prisma.Decimal(position.totalLiabilities),
        netWorth: new Prisma.Decimal(position.netWorth),
        assetBreakdown,
        liabilityBreakdown,
      },
      update: {
        totalAssets: new Prisma.Decimal(position.totalAssets),
        totalLiabilities: new Prisma.Decimal(position.totalLiabilities),
        netWorth: new Prisma.Decimal(position.netWorth),
        assetBreakdown,
        liabilityBreakdown,
      },
    });
  }

  async listSnapshots(
    userId: string,
    fromDate: string,
    toDate: string,
  ): Promise<NetWorthHistoryPoint[]> {
    const rows = await this.prisma.netWorthSnapshot.findMany({
      where: { userId, snapshotDate: { gte: asDate(fromDate), lte: asDate(toDate) } },
      orderBy: { snapshotDate: "asc" },
    });
    return rows.map((row) => ({
      date: dateOnly(row.snapshotDate),
      assets: row.totalAssets.toFixed(2),
      liabilities: row.totalLiabilities.toFixed(2),
      netWorth: row.netWorth.toFixed(2),
    }));
  }

  async listMonthlySummaries(userId: string, year: number): Promise<MonthSummary[]> {
    const from = asDate(`${year}-01-01`);
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const to = asDate(year === Number(today.slice(0, 4)) ? today : `${year}-12-31`);
    const transactions = await this.prisma.ledgerTransaction.findMany({
      where: { userId, effectiveDate: { gte: from, lte: to } },
      select: {
        effectiveDate: true,
        entries: {
          select: {
            debitAmount: true,
            creditAmount: true,
            ledgerAccount: { select: { category: true } },
          },
        },
      },
    });
    const activities = await this.prisma.investmentActivity.findMany({
      where: {
        userId,
        effectiveDate: { gte: from, lte: to },
        activityType: { in: ["BUY", "CONTRIBUTION"] },
      },
      select: { effectiveDate: true, amount: true },
    });
    const byMonth = new Map<
      string,
      { income: Prisma.Decimal; expenses: Prisma.Decimal; invested: Prisma.Decimal }
    >();
    for (let month = 1; month <= 12; month += 1) {
      const key = `${year}-${String(month).padStart(2, "0")}`;
      byMonth.set(key, { income: zero(), expenses: zero(), invested: zero() });
    }
    for (const transaction of transactions) {
      const month = byMonth.get(monthKey(transaction.effectiveDate));
      if (!month) continue;
      for (const entry of transaction.entries) {
        if (entry.ledgerAccount.category === "INCOME") {
          month.income = month.income.plus(entry.creditAmount).minus(entry.debitAmount);
        } else if (entry.ledgerAccount.category === "EXPENSE") {
          month.expenses = month.expenses
            .plus(entry.debitAmount)
            .minus(entry.creditAmount);
        }
      }
    }
    for (const activity of activities) {
      const month = byMonth.get(monthKey(activity.effectiveDate));
      if (month) month.invested = month.invested.plus(activity.amount);
    }
    return [...byMonth.entries()].map(([month, totals]) => ({
      month,
      income: money(totals.income),
      expenses: money(totals.expenses),
      invested: money(totals.invested),
      cashFlow: money(totals.income.minus(totals.expenses).minus(totals.invested)),
    }));
  }
}
