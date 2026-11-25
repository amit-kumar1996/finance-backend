import { Prisma } from "../../generated/prisma/client.js";

export interface FifoActivity {
  id: string;
  type: "BUY" | "SELL" | "CONTRIBUTION" | "WITHDRAWAL";
  effectiveDate: string;
  units: string | null;
  amount: string;
}

export interface FifoResult {
  units: string;
  costBasis: string;
  realizedPl: string;
  sales: Map<string, string>;
}

const roundMoney = (value: Prisma.Decimal): Prisma.Decimal =>
  value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

export type JournalEntry = {
  ledgerAccountId: string;
  debitAmount: string;
  creditAmount: string;
};

export const buildPurchaseEntries = (
  assetId: string,
  cashId: string,
  amount: string,
): JournalEntry[] => [
  { ledgerAccountId: assetId, debitAmount: amount, creditAmount: "0.00" },
  { ledgerAccountId: cashId, debitAmount: "0.00", creditAmount: amount },
];

export const buildValuationEntries = (
  assetId: string,
  revaluationEquityId: string,
  delta: string,
): JournalEntry[] => {
  const change = new Prisma.Decimal(delta);
  if (change.isZero()) return [];
  return change.gt(0)
    ? [
        {
          ledgerAccountId: assetId,
          debitAmount: change.toFixed(2),
          creditAmount: "0.00",
        },
        {
          ledgerAccountId: revaluationEquityId,
          debitAmount: "0.00",
          creditAmount: change.toFixed(2),
        },
      ]
    : [
        {
          ledgerAccountId: revaluationEquityId,
          debitAmount: change.abs().toFixed(2),
          creditAmount: "0.00",
        },
        {
          ledgerAccountId: assetId,
          debitAmount: "0.00",
          creditAmount: change.abs().toFixed(2),
        },
      ];
};

export const buildSaleEntries = (input: {
  assetId: string;
  cashId: string;
  valuationEquityId: string;
  realizedGainId: string;
  realizedLossId: string;
  proceeds: string;
  carryingValue: string;
  costBasis: string;
}): JournalEntry[] => {
  const proceeds = new Prisma.Decimal(input.proceeds);
  const carrying = new Prisma.Decimal(input.carryingValue);
  const cost = new Prisma.Decimal(input.costBasis);
  const marketDelta = proceeds.minus(carrying);
  const priorUnrealized = carrying.minus(cost);
  return [
    {
      ledgerAccountId: input.cashId,
      debitAmount: proceeds.toFixed(2),
      creditAmount: "0.00",
    },
    {
      ledgerAccountId: input.assetId,
      debitAmount: "0.00",
      creditAmount: carrying.toFixed(2),
    },
    ...(marketDelta.gt(0)
      ? [
          {
            ledgerAccountId: input.realizedGainId,
            debitAmount: "0.00",
            creditAmount: marketDelta.toFixed(2),
          },
        ]
      : marketDelta.lt(0)
        ? [
            {
              ledgerAccountId: input.realizedLossId,
              debitAmount: marketDelta.abs().toFixed(2),
              creditAmount: "0.00",
            },
          ]
        : []),
    ...(priorUnrealized.gt(0)
      ? [
          {
            ledgerAccountId: input.valuationEquityId,
            debitAmount: priorUnrealized.toFixed(2),
            creditAmount: "0.00",
          },
          {
            ledgerAccountId: input.realizedGainId,
            debitAmount: "0.00",
            creditAmount: priorUnrealized.toFixed(2),
          },
        ]
      : priorUnrealized.lt(0)
        ? [
            {
              ledgerAccountId: input.valuationEquityId,
              debitAmount: "0.00",
              creditAmount: priorUnrealized.abs().toFixed(2),
            },
            {
              ledgerAccountId: input.realizedLossId,
              debitAmount: priorUnrealized.abs().toFixed(2),
              creditAmount: "0.00",
            },
          ]
        : []),
  ];
};

export const calculateTradeAmount = (units: string, unitPrice: string): string =>
  roundMoney(new Prisma.Decimal(units).times(unitPrice)).toFixed(2);

export const calculateFifo = (activities: FifoActivity[]): FifoResult => {
  const ordered = [...activities].sort((left, right) =>
    left.effectiveDate.localeCompare(right.effectiveDate),
  );
  const lots: Array<{ units: Prisma.Decimal; cost: Prisma.Decimal }> = [];
  const sales = new Map<string, string>();
  let realizedPl = new Prisma.Decimal(0);
  let contributed = new Prisma.Decimal(0);
  let withdrawn = new Prisma.Decimal(0);

  for (const activity of ordered) {
    const amount = new Prisma.Decimal(activity.amount);
    if (activity.type === "BUY" || activity.type === "CONTRIBUTION") {
      if (activity.type === "BUY") {
        if (!activity.units || new Prisma.Decimal(activity.units).lte(0)) continue;
        lots.push({ units: new Prisma.Decimal(activity.units), cost: amount });
      } else {
        contributed = contributed.plus(amount);
      }
      continue;
    }
    if (activity.type === "WITHDRAWAL") {
      withdrawn = withdrawn.plus(amount);
      continue;
    }
    if (!activity.units) continue;
    let toSell = new Prisma.Decimal(activity.units);
    let cost = new Prisma.Decimal(0);
    for (const lot of lots) {
      if (toSell.isZero()) break;
      if (lot.units.isZero()) continue;
      const used = Prisma.Decimal.min(toSell, lot.units);
      const costUsed = used.equals(lot.units)
        ? lot.cost
        : roundMoney(lot.cost.times(used).div(lot.units));
      lot.units = lot.units.minus(used);
      lot.cost = lot.cost.minus(costUsed);
      toSell = toSell.minus(used);
      cost = cost.plus(costUsed);
    }
    if (!toSell.isZero()) throw new RangeError("Sale units exceed available units.");
    const saleCost = roundMoney(cost);
    sales.set(activity.id, saleCost.toFixed(2));
    realizedPl = realizedPl.plus(amount.minus(saleCost));
  }
  const openUnits = lots.reduce((sum, lot) => sum.plus(lot.units), new Prisma.Decimal(0));
  const marketCost = lots.reduce((sum, lot) => sum.plus(lot.cost), new Prisma.Decimal(0));
  return {
    units: openUnits.toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP).toFixed(8),
    costBasis: roundMoney(marketCost.plus(contributed).minus(withdrawn)).toFixed(2),
    realizedPl: roundMoney(realizedPl).toFixed(2),
    sales,
  };
};

export const calculateXirr = (
  cashFlows: Array<{ date: string; amount: string }>,
): string | null => {
  if (cashFlows.length < 2) return null;
  const hasPositive = cashFlows.some(({ amount }) => new Prisma.Decimal(amount).gt(0));
  const hasNegative = cashFlows.some(({ amount }) => new Prisma.Decimal(amount).lt(0));
  if (!hasPositive || !hasNegative) return null;
  const firstDate = Math.min(
    ...cashFlows.map(({ date }) => Date.parse(`${date}T00:00:00.000Z`)),
  );
  const datedFlows = cashFlows.map(({ date, amount }) => ({
    years: new Prisma.Decimal(Date.parse(`${date}T00:00:00.000Z`) - firstDate)
      .div(86_400_000)
      .div(365),
    amount: new Prisma.Decimal(amount),
  }));
  const npv = (rate: Prisma.Decimal): Prisma.Decimal => {
    const base = new Prisma.Decimal(1).plus(rate);
    if (base.lte(0)) return new Prisma.Decimal(Infinity);
    return datedFlows.reduce(
      (sum, flow) => sum.plus(flow.amount.div(base.pow(flow.years))),
      new Prisma.Decimal(0),
    );
  };

  let low = new Prisma.Decimal("-0.99999999");
  let high = new Prisma.Decimal(1);
  const lowValue = npv(low);
  let highValue = npv(high);
  const sameSign = (left: Prisma.Decimal, right: Prisma.Decimal): boolean =>
    left.isNegative() === right.isNegative() && !left.isZero() && !right.isZero();
  for (let tries = 0; sameSign(lowValue, highValue) && tries < 24; tries += 1) {
    high = high.times(2).plus(1);
    highValue = npv(high);
  }
  if (sameSign(lowValue, highValue)) return null;
  if (lowValue.isZero()) return low.times(100).toDecimalPlaces(2).toFixed(2);
  if (highValue.isZero()) return high.times(100).toDecimalPlaces(2).toFixed(2);
  for (let iteration = 0; iteration < 120; iteration += 1) {
    const midpoint = low.plus(high).div(2);
    const value = npv(midpoint);
    if (value.abs().lt("0.00000001")) {
      return midpoint
        .times(100)
        .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
        .toFixed(2);
    }
    if (value.isNegative() === lowValue.isNegative()) low = midpoint;
    else high = midpoint;
  }
  return low
    .plus(high)
    .div(2)
    .times(100)
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
    .toFixed(2);
};
