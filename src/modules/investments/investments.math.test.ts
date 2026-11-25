import { describe, expect, it } from "vitest";
import { Prisma } from "../../generated/prisma/client.js";
import {
  buildPurchaseEntries,
  buildSaleEntries,
  calculateFifo,
  calculateTradeAmount,
  calculateXirr,
} from "./investments.math.js";

describe("investment calculations and ledger entries", () => {
  it("posts a ₹10,000 fund purchase to an investment asset, not expenses", () => {
    const entries = buildPurchaseEntries("fund-asset", "bank", "10000.00");
    expect(entries).toEqual([
      { ledgerAccountId: "fund-asset", debitAmount: "10000.00", creditAmount: "0.00" },
      { ledgerAccountId: "bank", debitAmount: "0.00", creditAmount: "10000.00" },
    ]);
    const debits = entries.reduce(
      (sum, entry) => sum.plus(entry.debitAmount),
      new Prisma.Decimal(0),
    );
    const credits = entries.reduce(
      (sum, entry) => sum.plus(entry.creditAmount),
      new Prisma.Decimal(0),
    );
    expect(debits.equals(credits)).toBe(true);
    expect(entries.some((entry) => entry.ledgerAccountId.includes("expense"))).toBe(
      false,
    );
    expect(calculateTradeAmount("100.00000000", "100.000000")).toBe("10000.00");
  });

  it("uses FIFO cost basis and computes realized profit after multiple buys and a partial sell", () => {
    const fifo = calculateFifo([
      {
        id: "buy-1",
        type: "BUY",
        effectiveDate: "2025-01-01",
        units: "10",
        amount: "10000.00",
      },
      {
        id: "buy-2",
        type: "BUY",
        effectiveDate: "2025-02-01",
        units: "5",
        amount: "6000.00",
      },
      {
        id: "sell-1",
        type: "SELL",
        effectiveDate: "2025-03-01",
        units: "12",
        amount: "15600.00",
      },
    ]);
    expect(fifo).toMatchObject({
      units: "3.00000000",
      costBasis: "3600.00",
      realizedPl: "3200.00",
    });
    expect(fifo.sales.get("sell-1")).toBe("12400.00");
    const entries = buildSaleEntries({
      assetId: "stock-asset",
      cashId: "bank",
      valuationEquityId: "valuation-equity",
      realizedGainId: "realized-gain",
      realizedLossId: "realized-loss",
      proceeds: "15600.00",
      carryingValue: "15600.00",
      costBasis: "12400.00",
    });
    const debits = entries.reduce(
      (sum, entry) => sum.plus(entry.debitAmount),
      new Prisma.Decimal(0),
    );
    const credits = entries.reduce(
      (sum, entry) => sum.plus(entry.creditAmount),
      new Prisma.Decimal(0),
    );
    expect(debits.equals(credits)).toBe(true);
  });

  it("calculates XIRR for irregular cash flows with Decimal amounts", () => {
    expect(
      calculateXirr([
        { date: "2024-01-01", amount: "-10000.00" },
        { date: "2025-01-01", amount: "11000.00" },
      ]),
    ).toBe("9.97");
  });
});
