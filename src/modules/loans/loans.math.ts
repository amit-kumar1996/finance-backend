import { Prisma } from "../../generated/prisma/client.js";

export interface ScheduleLine {
  dueDate: string;
  emiAmount: string;
  principalAmount: string;
  interestAmount: string;
  closingBalance: string;
}

export const buildEmiEntries = (input: {
  liabilityAccountId: string;
  expenseAccountId: string;
  bankAccountId: string;
  principalAmount: string;
  interestAmount: string;
}): Array<{ ledgerAccountId: string; debitAmount: string; creditAmount: string }> => [
  ...(new Prisma.Decimal(input.principalAmount).isZero()
    ? []
    : [
        {
          ledgerAccountId: input.liabilityAccountId,
          debitAmount: input.principalAmount,
          creditAmount: "0.00",
        },
      ]),
  ...(new Prisma.Decimal(input.interestAmount).isZero()
    ? []
    : [
        {
          ledgerAccountId: input.expenseAccountId,
          debitAmount: input.interestAmount,
          creditAmount: "0.00",
        },
      ]),
  {
    ledgerAccountId: input.bankAccountId,
    debitAmount: "0.00",
    creditAmount: new Prisma.Decimal(input.principalAmount)
      .plus(input.interestAmount)
      .toFixed(2),
  },
];

const roundMoney = (value: Prisma.Decimal): Prisma.Decimal =>
  value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

export const calculateEmi = (
  principal: string,
  annualRate: string,
  termMonths: number,
): string => {
  const p = new Prisma.Decimal(principal);
  const monthlyRate = new Prisma.Decimal(annualRate).div(1200);
  if (monthlyRate.isZero()) return roundMoney(p.div(termMonths)).toFixed(2);
  const factor = new Prisma.Decimal(1).plus(monthlyRate).pow(termMonths);
  return roundMoney(p.times(monthlyRate).times(factor).div(factor.minus(1))).toFixed(2);
};

const dateString = (date: Date): string => date.toISOString().slice(0, 10);

const dueDateForMonth = (year: number, month: number, day: number): Date =>
  new Date(
    Date.UTC(
      year,
      month,
      Math.min(day, new Date(Date.UTC(year, month + 1, 0)).getUTCDate()),
    ),
  );

export const generateSchedule = (input: {
  outstanding: string;
  annualRate: string;
  emiAmount: string;
  dueDay: number;
  firstDueDate: string;
  remainingPayments: number;
}): ScheduleLine[] => {
  let balance = new Prisma.Decimal(input.outstanding);
  const rate = new Prisma.Decimal(input.annualRate).div(1200);
  const scheduledEmi = new Prisma.Decimal(input.emiAmount);
  const firstDate = new Date(`${input.firstDueDate}T00:00:00.000Z`);
  const lines: ScheduleLine[] = [];
  for (let index = 0; index < input.remainingPayments && balance.gt(0); index += 1) {
    const due = dueDateForMonth(
      firstDate.getUTCFullYear(),
      firstDate.getUTCMonth() + index,
      input.dueDay,
    );
    const interest = roundMoney(balance.times(rate));
    const principal = roundMoney(
      Prisma.Decimal.min(balance, scheduledEmi.minus(interest)),
    );
    const emi = roundMoney(principal.plus(interest));
    balance = roundMoney(balance.minus(principal));
    lines.push({
      dueDate: dateString(due),
      emiAmount: emi.toFixed(2),
      principalAmount: principal.toFixed(2),
      interestAmount: interest.toFixed(2),
      closingBalance: balance.toFixed(2),
    });
  }
  return lines;
};

export const paymentSplit = (input: {
  amount: string;
  principalAmount: string;
  interestAmount: string;
  outstanding: string;
}): { amount: string; principalAmount: string; interestAmount: string } | null => {
  const amount = roundMoney(new Prisma.Decimal(input.amount));
  const principal = roundMoney(new Prisma.Decimal(input.principalAmount));
  const interest = roundMoney(new Prisma.Decimal(input.interestAmount));
  const outstanding = roundMoney(new Prisma.Decimal(input.outstanding));
  if (!principal.plus(interest).equals(amount) || principal.gt(outstanding)) return null;
  return {
    amount: amount.toFixed(2),
    principalAmount: principal.toFixed(2),
    interestAmount: interest.toFixed(2),
  };
};
