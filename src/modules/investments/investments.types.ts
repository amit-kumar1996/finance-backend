export type InvestmentType = "NPS" | "MUTUAL_FUND" | "STOCK" | "FD" | "PPF" | "EPF";
export type InvestmentActivityType =
  "BUY" | "SELL" | "CONTRIBUTION" | "WITHDRAWAL" | "VALUATION";
export type PriceSource = "AMFI" | "MANUAL" | "PROVIDER";

export interface MarketDataQuote {
  symbol: string;
  price: string;
  date: string;
}
export interface MarketDataAdapter {
  readonly source: Exclude<PriceSource, "MANUAL">;
  fetchPrices(): Promise<Map<string, MarketDataQuote>>;
}

export interface InvestmentActivityInput {
  effectiveDate: string;
  accountId: string;
  units: string;
  unitPrice: string;
  note: string;
}

export interface ContributionInput {
  effectiveDate: string;
  accountId: string;
  amount: string;
  note: string;
}

export interface InvestmentRecord {
  id: string;
  investmentType: InvestmentType;
  name: string;
  provider: string | null;
  symbol: string | null;
  annualRate: string | null;
  maturityDate: string | null;
  units: string;
  invested: string;
  currentValue: string;
  realizedPl: string;
  unrealizedPl: string;
  xirr: string | null;
  price: string | null;
  priceSource: PriceSource | null;
  priceDate: string | null;
  stale: boolean;
  activities: Array<{
    id: string;
    type: InvestmentActivityType;
    effectiveDate: string;
    units: string | null;
    unitPrice: string | null;
    amount: string;
    costBasisAmount: string | null;
    note: string | null;
  }>;
}

export interface InvestmentsRepository {
  list(userId: string, type?: InvestmentType): Promise<InvestmentRecord[]>;
  create(
    userId: string,
    idempotencyKey: string,
    input: {
      investmentType: InvestmentType;
      name: string;
      provider: string | null;
      symbol: string | null;
      annualRate: string | null;
      maturityDate: string | null;
    },
    requestHash: string,
  ): Promise<string>;
  transact(
    userId: string,
    idempotencyKey: string,
    requestHash: string,
    input: {
      investmentId: string;
      activityType: "BUY" | "SELL" | "CONTRIBUTION" | "WITHDRAWAL";
      effectiveDate: string;
      accountId: string;
      amount: string;
      units: string | null;
      unitPrice: string | null;
      costBasisAmount: string | null;
      note: string;
    },
  ): Promise<void>;
  setPrice(
    userId: string,
    investmentId: string,
    idempotencyKey: string,
    input: {
      effectiveDate: string;
      unitPrice: string;
      source: PriceSource;
    },
  ): Promise<void>;
  setValuation(
    userId: string,
    investmentId: string,
    idempotencyKey: string,
    input: {
      effectiveDate: string;
      currentValue: string;
    },
  ): Promise<void>;
}
