import type { NetWorthPosition } from "./net-worth.math.js";

export interface MonthSummary {
  month: string;
  income: string;
  expenses: string;
  invested: string;
  cashFlow: string;
}

export interface NetWorthHistoryPoint {
  date: string;
  assets: string;
  liabilities: string;
  netWorth: string;
}

export interface PriceFreshnessItem {
  id: string;
  name: string;
  source: string | null;
  date: string | null;
  stale: boolean;
}

export interface NetWorthRepository {
  getPosition(userId: string, asOfDate: string): Promise<NetWorthPosition>;
  saveSnapshot(userId: string, position: NetWorthPosition): Promise<void>;
  listSnapshots(
    userId: string,
    fromDate: string,
    toDate: string,
  ): Promise<NetWorthHistoryPoint[]>;
  listMonthlySummaries(userId: string, year: number): Promise<MonthSummary[]>;
}
