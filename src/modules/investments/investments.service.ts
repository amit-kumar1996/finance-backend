import { createHash } from "node:crypto";
import { Prisma } from "../../generated/prisma/client.js";
import { HttpError } from "../../lib/http-error.js";
import { formatMoney, parseMoney } from "../accounts/money.js";
import { calculateTradeAmount } from "./investments.math.js";
import type {
  ContributionInput,
  InvestmentActivityInput,
  InvestmentType,
  InvestmentsRepository,
  MarketDataAdapter,
  PriceSource,
} from "./investments.types.js";

const fingerprint = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const marketTypes: InvestmentType[] = ["NPS", "MUTUAL_FUND", "STOCK"];
const fixedTypes: InvestmentType[] = ["FD", "PPF", "EPF"];

export class InvestmentsService {
  constructor(
    private readonly repository: InvestmentsRepository,
    private readonly amfiAdapter: MarketDataAdapter,
  ) {}

  list(userId: string, type?: InvestmentType) {
    return this.repository.list(userId, type);
  }

  async create(
    userId: string,
    idempotencyKey: string,
    input: {
      investmentType: InvestmentType;
      name: string;
      provider?: string;
      symbol?: string;
      annualRate?: string;
      maturityDate?: string | null;
    },
  ) {
    const symbol = input.symbol?.trim() || null;
    if (
      (input.investmentType === "STOCK" || input.investmentType === "MUTUAL_FUND") &&
      !symbol
    ) {
      throw new HttpError(
        400,
        "INVESTMENT_SYMBOL_REQUIRED",
        "Stocks need a market symbol and mutual funds need their AMFI scheme code.",
      );
    }
    const annualRate = input.annualRate
      ? new Prisma.Decimal(input.annualRate)
          .toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP)
          .toFixed(4)
      : null;
    const normalized = {
      investmentType: input.investmentType,
      name: input.name.trim(),
      provider: input.provider?.trim() || null,
      symbol,
      annualRate,
      maturityDate: input.maturityDate ?? null,
    };
    const requestHash = fingerprint(normalized);
    return this.repository.create(userId, idempotencyKey, normalized, requestHash);
  }

  async trade(
    userId: string,
    investmentId: string,
    idempotencyKey: string,
    activityType: "BUY" | "SELL",
    input: InvestmentActivityInput,
  ) {
    const investment = await this.requireInvestment(userId, investmentId);
    if (!marketTypes.includes(investment.investmentType)) {
      throw new HttpError(
        400,
        "MARKET_INVESTMENT_REQUIRED",
        "Buy and sell trades require an NPS, mutual fund, or stock holding.",
      );
    }
    const units = new Prisma.Decimal(input.units);
    const unitPrice = new Prisma.Decimal(input.unitPrice);
    if (units.lte(0) || unitPrice.lte(0)) {
      throw new HttpError(
        400,
        "TRADE_AMOUNT_INVALID",
        "Units and unit price must be greater than zero.",
      );
    }
    const amount = calculateTradeAmount(input.units, input.unitPrice);
    if (new Prisma.Decimal(amount).lte(0))
      throw new HttpError(
        400,
        "TRADE_AMOUNT_INVALID",
        "Trade value must be at least one paisa.",
      );
    const request = { investmentId, activityType, ...input, amount };
    await this.repository.transact(userId, idempotencyKey, fingerprint(request), {
      investmentId,
      activityType,
      effectiveDate: input.effectiveDate,
      accountId: input.accountId,
      amount,
      units: units.toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP).toFixed(8),
      unitPrice: unitPrice.toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP).toFixed(8),
      costBasisAmount: null,
      note: input.note.trim(),
    });
  }

  async cashActivity(
    userId: string,
    investmentId: string,
    idempotencyKey: string,
    activityType: "CONTRIBUTION" | "WITHDRAWAL",
    input: ContributionInput,
  ) {
    const investment = await this.requireInvestment(userId, investmentId);
    if (!fixedTypes.includes(investment.investmentType)) {
      throw new HttpError(
        400,
        "FIXED_INVESTMENT_REQUIRED",
        "Contributions and withdrawals are for FD, PPF, and EPF. Use units and NAV for NPS investments.",
      );
    }
    const amount = formatMoney(parseMoney(input.amount));
    const request = { investmentId, activityType, ...input, amount };
    await this.repository.transact(userId, idempotencyKey, fingerprint(request), {
      investmentId,
      activityType,
      effectiveDate: input.effectiveDate,
      accountId: input.accountId,
      amount,
      units: null,
      unitPrice: null,
      costBasisAmount: null,
      note: input.note.trim(),
    });
  }

  async updatePrice(
    userId: string,
    investmentId: string,
    idempotencyKey: string,
    input: { effectiveDate: string; unitPrice: string; source: PriceSource },
  ) {
    const investment = await this.requireInvestment(userId, investmentId);
    if (input.source === "AMFI" && investment.investmentType !== "MUTUAL_FUND") {
      throw new HttpError(
        400,
        "AMFI_MUTUAL_FUND_REQUIRED",
        "AMFI NAV updates are only valid for mutual funds.",
      );
    }
    const price = new Prisma.Decimal(input.unitPrice);
    if (price.lte(0))
      throw new HttpError(400, "PRICE_INVALID", "Unit price must be greater than zero.");
    await this.repository.setPrice(userId, investmentId, idempotencyKey, {
      ...input,
      unitPrice: price.toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP).toFixed(8),
    });
  }

  async updateValuation(
    userId: string,
    investmentId: string,
    idempotencyKey: string,
    input: { effectiveDate: string; currentValue: string },
  ) {
    await this.requireInvestment(userId, investmentId);
    const currentValue = formatMoney(parseMoney(input.currentValue, true));
    await this.repository.setValuation(userId, investmentId, idempotencyKey, {
      ...input,
      currentValue,
    });
  }

  async syncAmfi(userId: string) {
    let navByScheme: Awaited<ReturnType<MarketDataAdapter["fetchPrices"]>>;
    try {
      navByScheme = await this.amfiAdapter.fetchPrices();
    } catch (cause) {
      throw new HttpError(
        502,
        "AMFI_NAV_UNAVAILABLE",
        cause instanceof Error ? cause.message : "AMFI NAV data could not be downloaded.",
      );
    }
    const investments = await this.repository.list(userId, "MUTUAL_FUND");
    let updated = 0;
    let manualOverrides = 0;
    const missing: string[] = [];
    const sourceDates = new Set<string>();
    for (const investment of investments) {
      if (!investment.symbol) continue;
      const quote = navByScheme.get(investment.symbol);
      if (!quote) {
        missing.push(investment.id);
        continue;
      }
      sourceDates.add(quote.date);
      if (investment.priceSource === "MANUAL" && investment.priceDate === quote.date) {
        manualOverrides += 1;
        continue;
      }
      const key = `${this.amfiAdapter.source}:${investment.id}:${quote.date}:${fingerprint(quote.price).slice(0, 12)}`;
      await this.updatePrice(userId, investment.id, key, {
        effectiveDate: quote.date,
        unitPrice: quote.price,
        source: this.amfiAdapter.source,
      });
      updated += 1;
    }
    return {
      updated,
      manualOverrides,
      missing,
      sourceDates: [...sourceDates].sort(),
      source: this.amfiAdapter.source,
    };
  }

  private async requireInvestment(userId: string, investmentId: string) {
    const investment = (await this.repository.list(userId)).find(
      (row) => row.id === investmentId,
    );
    if (!investment)
      throw new HttpError(404, "INVESTMENT_NOT_FOUND", "The investment was not found.");
    return investment;
  }
}
