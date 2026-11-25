import { Prisma } from "../../generated/prisma/client.js";
import type { InvestmentsService } from "../investments/investments.service.js";
import type { LoansService } from "../loans/loans.service.js";
import type {
  MonthSummary,
  NetWorthHistoryPoint,
  NetWorthRepository,
} from "./net-worth.types.js";

const todayInKolkata = (): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (part: "year" | "month" | "day") =>
    parts.find((entry) => entry.type === part)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
};
const monthsBefore = (date: string, count: number): string => {
  const [year = "0", month = "1"] = date.split("-");
  const value = new Date(Date.UTC(Number(year), Number(month) - 1 - count, 1));
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-01`;
};
const addCurrentPoint = (
  history: NetWorthHistoryPoint[],
  position: {
    asOfDate: string;
    totalAssets: string;
    totalLiabilities: string;
    netWorth: string;
  },
) =>
  history.at(-1)?.date === position.asOfDate
    ? history
    : [
        ...history,
        {
          date: position.asOfDate,
          assets: position.totalAssets,
          liabilities: position.totalLiabilities,
          netWorth: position.netWorth,
        },
      ];
const latestPointPerMonth = (history: NetWorthHistoryPoint[]) => {
  const byMonth = new Map<string, NetWorthHistoryPoint>();
  for (const point of history) byMonth.set(point.date.slice(0, 7), point);
  return [...byMonth.values()];
};
const sum = (values: string[]) =>
  values
    .reduce((total, value) => total.plus(value), new Prisma.Decimal(0))
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
    .toFixed(2);

export class NetWorthService {
  constructor(
    private readonly repository: NetWorthRepository,
    private readonly loans: LoansService,
    private readonly investments: InvestmentsService,
  ) {}

  async dashboard(userId: string) {
    const today = todayInKolkata();
    const month = today.slice(0, 7);
    const year = Number(today.slice(0, 4));
    const [position, monthlyRows, history, loanRows, investments] = await Promise.all([
      this.repository.getPosition(userId, today),
      this.repository.listMonthlySummaries(userId, year),
      this.repository.listSnapshots(userId, monthsBefore(today, 5), today),
      this.loans.list(userId),
      this.investments.list(userId),
    ]);
    const currentMonth: MonthSummary = monthlyRows.find((row) => row.month === month) ?? {
      month,
      income: "0.00",
      expenses: "0.00",
      invested: "0.00",
      cashFlow: "0.00",
    };
    const assetValue = (bucket: string) =>
      sum(
        position.assetBreakdown
          .filter(
            (item) => item.bucket === bucket || item.bucket.startsWith(`${bucket}:`),
          )
          .map((item) => item.value),
      );
    const liabilityValue = (bucket: string) =>
      sum(
        position.liabilityBreakdown
          .filter((item) => item.bucket === bucket)
          .map((item) => item.value),
      );
    const upcoming = loanRows
      .filter((loan) => loan.status === "ACTIVE" && loan.nextDueDate)
      .map((loan) => ({
        name: `${loan.name} EMI`,
        dueDate: loan.nextDueDate!,
        amount: loan.schedule[0]?.emiAmount ?? loan.emiAmount,
      }))
      .sort((left, right) => left.dueDate.localeCompare(right.dueDate))
      .slice(0, 3);
    const priceFreshness = investments
      .filter((investment) =>
        ["NPS", "MUTUAL_FUND", "STOCK"].includes(investment.investmentType),
      )
      .map((investment) => ({
        id: investment.id,
        name: investment.name,
        source: investment.priceSource,
        date: investment.priceDate,
        stale: investment.stale,
      }));
    return {
      asOfDate: today,
      position,
      whereMoneyStands: {
        cash: assetValue("cash"),
        investments: assetValue("investment"),
        receivables: assetValue("receivable"),
        loans: liabilityValue("loan"),
        creditCards: liabilityValue("creditCard"),
        payables: liabilityValue("peoplePayable"),
      },
      month: currentMonth,
      history: latestPointPerMonth(addCurrentPoint(history, position)).slice(-6),
      upcoming,
      priceFreshness,
    };
  }

  async netWorth(userId: string) {
    const today = todayInKolkata();
    const month = today.slice(0, 7);
    const [position, history, investments] = await Promise.all([
      this.repository.getPosition(userId, today),
      this.repository.listSnapshots(userId, monthsBefore(today, 11), today),
      this.investments.list(userId),
    ]);
    const prior = [...history].reverse().find((item) => item.date.slice(0, 7) < month);
    const changeThisMonth = prior
      ? new Prisma.Decimal(position.netWorth)
          .minus(prior.netWorth)
          .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
          .toFixed(2)
      : null;
    return {
      position,
      changeThisMonth,
      history: latestPointPerMonth(addCurrentPoint(history, position)),
      priceFreshness: investments
        .filter((investment) =>
          ["NPS", "MUTUAL_FUND", "STOCK"].includes(investment.investmentType),
        )
        .map((investment) => ({
          id: investment.id,
          name: investment.name,
          source: investment.priceSource,
          date: investment.priceDate,
          stale: investment.stale,
        })),
    };
  }

  async reports(userId: string, year: number) {
    const today = todayInKolkata();
    const position = await this.repository.getPosition(userId, today);
    const [monthly, history] = await Promise.all([
      this.repository.listMonthlySummaries(userId, year),
      this.repository.listSnapshots(
        userId,
        `${year}-01-01`,
        today.startsWith(String(year)) ? today : `${year}-12-31`,
      ),
    ]);
    return {
      year,
      asOfDate: today,
      position,
      monthly,
      history: latestPointPerMonth(addCurrentPoint(history, position)).filter((point) =>
        point.date.startsWith(String(year)),
      ),
    };
  }

  async snapshot(userId: string, date = todayInKolkata()): Promise<void> {
    const position = await this.repository.getPosition(userId, date);
    await this.repository.saveSnapshot(userId, position);
  }
}

export { todayInKolkata };
