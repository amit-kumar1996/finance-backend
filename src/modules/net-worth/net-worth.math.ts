import { Prisma } from "../../generated/prisma/client.js";

export interface LedgerBalanceInput {
  id: string;
  name: string;
  category: "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";
  normalBalance: "DEBIT" | "CREDIT";
  debits: string;
  credits: string;
  bucket: string | null;
  label: string;
}

export interface NetWorthItem {
  id: string;
  label: string;
  bucket: string;
  value: string;
}

export interface NetWorthPosition {
  asOfDate: string;
  totalAssets: string;
  totalLiabilities: string;
  netWorth: string;
  debtToAssetRatio: string | null;
  assetBreakdown: NetWorthItem[];
  liabilityBreakdown: NetWorthItem[];
}

const zero = () => new Prisma.Decimal(0);
const money = (value: Prisma.Decimal) =>
  value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toFixed(2);

export const calculateNetWorthPosition = (
  accounts: LedgerBalanceInput[],
  asOfDate: string,
): NetWorthPosition => {
  const assets = new Map<
    string,
    { label: string; bucket: string; value: Prisma.Decimal }
  >();
  const liabilities = new Map<
    string,
    { label: string; bucket: string; value: Prisma.Decimal }
  >();
  for (const account of accounts) {
    if (account.category !== "ASSET" && account.category !== "LIABILITY") continue;
    const debit = new Prisma.Decimal(account.debits);
    const credit = new Prisma.Decimal(account.credits);
    const balance =
      account.normalBalance === "DEBIT" ? debit.minus(credit) : credit.minus(debit);
    const bucket =
      account.bucket ??
      (account.category === "ASSET" ? "otherAssets" : "otherLiabilities");
    const target = account.category === "ASSET" ? assets : liabilities;
    const key = `${bucket}:${account.label}`;
    const existing = target.get(key);
    if (existing) existing.value = existing.value.plus(balance);
    else target.set(key, { label: account.label, bucket, value: balance });
  }
  const toItems = (source: typeof assets): NetWorthItem[] =>
    [...source.entries()]
      .filter(([, item]) => !item.value.isZero())
      .map(([id, item]) => ({
        id,
        label: item.label,
        bucket: item.bucket,
        value: money(item.value),
      }))
      .sort((left, right) => left.label.localeCompare(right.label));
  const assetBreakdown = toItems(assets);
  const liabilityBreakdown = toItems(liabilities);
  const totalAssets = assetBreakdown.reduce((sum, item) => sum.plus(item.value), zero());
  const totalLiabilities = liabilityBreakdown.reduce(
    (sum, item) => sum.plus(item.value),
    zero(),
  );
  const netWorth = totalAssets.minus(totalLiabilities);
  return {
    asOfDate,
    totalAssets: money(totalAssets),
    totalLiabilities: money(totalLiabilities),
    netWorth: money(netWorth),
    debtToAssetRatio: totalAssets.isZero()
      ? null
      : totalLiabilities
          .div(totalAssets)
          .times(100)
          .toDecimalPlaces(1, Prisma.Decimal.ROUND_HALF_UP)
          .toFixed(1),
    assetBreakdown,
    liabilityBreakdown,
  };
};

export const calculateBorrowIntoBankPosition = (amount: string) =>
  calculateNetWorthPosition(
    [
      {
        id: "bank",
        name: "Bank",
        category: "ASSET",
        normalBalance: "DEBIT",
        debits: amount,
        credits: "0.00",
        bucket: "cash",
        label: "Bank, cash and UPI",
      },
      {
        id: "loan",
        name: "Loan",
        category: "LIABILITY",
        normalBalance: "CREDIT",
        debits: "0.00",
        credits: amount,
        bucket: "loan",
        label: "Loan",
      },
    ],
    "2026-01-01",
  );
