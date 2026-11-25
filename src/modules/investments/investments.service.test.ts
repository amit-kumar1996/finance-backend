import { describe, expect, it, vi } from "vitest";
import { InvestmentsService } from "./investments.service.js";
import type { InvestmentRecord, InvestmentsRepository, MarketDataAdapter } from "./investments.types.js";

const manualFund: InvestmentRecord = {
  id: "fund-1", investmentType: "MUTUAL_FUND", name: "Index fund", provider: null, symbol: "100001",
  annualRate: null, maturityDate: null, units: "10.00000000", invested: "1000.00", currentValue: "1100.00",
  realizedPl: "0.00", unrealizedPl: "100.00", xirr: "10.00", price: "110.00000000", priceSource: "MANUAL",
  priceDate: "2026-11-25", stale: false, activities: [],
};

describe("scheduled market refresh respects manual prices", () => {
  it("preserves a manual quote for the same effective date", async () => {
    const repository = {
      list: vi.fn(async () => [manualFund]),
      setPrice: vi.fn(async () => undefined),
    } as unknown as InvestmentsRepository;
    const adapter: MarketDataAdapter = {
      source: "AMFI",
      fetchPrices: async () => new Map([["100001", { symbol: "100001", price: "109.5000", date: "2026-11-25" }]]),
    };
    const service = new InvestmentsService(repository, adapter);

    const result = await service.syncAmfi("user-1");

    expect(result).toMatchObject({ updated: 0, manualOverrides: 1, source: "AMFI" });
    expect(repository.setPrice).not.toHaveBeenCalled();
  });
});
