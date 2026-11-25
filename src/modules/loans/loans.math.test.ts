import { describe, expect, it } from "vitest";
import { Prisma } from "../../generated/prisma/client.js";
import {
  buildEmiEntries,
  calculateEmi,
  generateSchedule,
  paymentSplit,
} from "./loans.math.js";

describe("loan calculations", () => {
  it("posts a ₹9,000 EMI as ₹7,000 principal and ₹2,000 interest", () => {
    const entries = buildEmiEntries({
      liabilityAccountId: "loan-liability",
      expenseAccountId: "interest-expense",
      bankAccountId: "bank",
      principalAmount: "7000.00",
      interestAmount: "2000.00",
    });
    expect(entries).toEqual([
      { ledgerAccountId: "loan-liability", debitAmount: "7000.00", creditAmount: "0.00" },
      {
        ledgerAccountId: "interest-expense",
        debitAmount: "2000.00",
        creditAmount: "0.00",
      },
      { ledgerAccountId: "bank", debitAmount: "0.00", creditAmount: "9000.00" },
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
  });

  it("calculates EMI using decimal arithmetic and supports zero interest", () => {
    expect(calculateEmi("100000.00", "0.0000", 10)).toBe("10000.00");
    expect(calculateEmi("100000.00", "12.0000", 12)).toBe("8884.88");
  });

  it("rounds schedule interest to paise and caps due dates at month end", () => {
    const schedule = generateSchedule({
      outstanding: "1000.00",
      annualRate: "12.0000",
      emiAmount: "1000.00",
      dueDay: 31,
      firstDueDate: "2024-02-29",
      remainingPayments: 2,
    });
    expect(schedule.map((line) => line.dueDate)).toEqual(["2024-02-29", "2024-03-31"]);
    expect(schedule[0]).toMatchObject({
      interestAmount: "10.00",
      principalAmount: "990.00",
      closingBalance: "10.00",
    });
    expect(schedule[1]?.closingBalance).toBe("0.00");
  });

  it("requires payment total to equal the principal and interest split", () => {
    expect(
      paymentSplit({
        amount: "9000",
        principalAmount: "7000",
        interestAmount: "2000",
        outstanding: "50000",
      }),
    ).toEqual({
      amount: "9000.00",
      principalAmount: "7000.00",
      interestAmount: "2000.00",
    });
    expect(
      paymentSplit({
        amount: "9000",
        principalAmount: "7000",
        interestAmount: "1000",
        outstanding: "50000",
      }),
    ).toBeNull();
    expect(
      paymentSplit({
        amount: "9000",
        principalAmount: "50001",
        interestAmount: "0",
        outstanding: "50000",
      }),
    ).toBeNull();
  });
});
