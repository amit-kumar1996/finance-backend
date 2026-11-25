import { describe, expect, it } from "vitest";
import {
  calculateBorrowIntoBankPosition,
  calculateNetWorthPosition,
} from "./net-worth.math.js";

describe("ledger-derived net worth", () => {
  it("keeps net worth unchanged when borrowed money is deposited into a bank", () => {
    const position = calculateBorrowIntoBankPosition("50000.00");
    expect(position).toMatchObject({
      totalAssets: "50000.00",
      totalLiabilities: "50000.00",
      netWorth: "0.00",
      debtToAssetRatio: "100.0",
    });
  });

  it("uses normal balances and Decimal sums across all asset and liability accounts", () => {
    const position = calculateNetWorthPosition(
      [
        {
          id: "bank-a",
          name: "Bank A",
          category: "ASSET",
          normalBalance: "DEBIT",
          debits: "10000.00",
          credits: "500.00",
          bucket: "cash",
          label: "Bank, cash and UPI",
        },
        {
          id: "receivable",
          name: "Given to person",
          category: "ASSET",
          normalBalance: "DEBIT",
          debits: "2000.00",
          credits: "0.00",
          bucket: "receivable",
          label: "Receivables",
        },
        {
          id: "card",
          name: "Card",
          category: "LIABILITY",
          normalBalance: "CREDIT",
          debits: "100.00",
          credits: "1100.00",
          bucket: "creditCard",
          label: "Credit card",
        },
        {
          id: "equity",
          name: "Opening equity",
          category: "EQUITY",
          normalBalance: "CREDIT",
          debits: "0.00",
          credits: "50000.00",
          bucket: null,
          label: "Equity",
        },
      ],
      "2026-11-25",
    );
    expect(position).toMatchObject({
      totalAssets: "11500.00",
      totalLiabilities: "1000.00",
      netWorth: "10500.00",
      debtToAssetRatio: "8.7",
    });
  });
});
