import { Prisma } from "../../generated/prisma/client.js";
import { HttpError } from "../../lib/http-error.js";

const inputMoneyPattern = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const maxMoney = new Prisma.Decimal("9999999999999999.99");

export const parseMoney = (input: string, allowZero = false): Prisma.Decimal => {
  if (!inputMoneyPattern.test(input)) {
    throw new HttpError(
      400,
      "AMOUNT_INVALID",
      "Amount must be a non-negative decimal string.",
    );
  }
  const [whole = "", fraction = ""] = input.split(".");
  if (whole.length > 16) {
    throw new HttpError(400, "AMOUNT_INVALID", "Amount must fit within DECIMAL(18,2).");
  }
  if (fraction.length > 4) {
    throw new HttpError(
      400,
      "AMOUNT_INVALID",
      "Amount may have at most four fractional digits before rounding.",
    );
  }

  const rounded = new Prisma.Decimal(input).toDecimalPlaces(
    2,
    Prisma.Decimal.ROUND_HALF_UP,
  );
  if ((!allowZero && rounded.lte(0)) || rounded.gt(maxMoney)) {
    throw new HttpError(
      400,
      "AMOUNT_INVALID",
      "Amount must be positive and fit within DECIMAL(18,2).",
    );
  }
  return rounded;
};

export const formatMoney = (amount: Prisma.Decimal): string => amount.toFixed(2);

export const assertBalancedEntries = (
  entries: Array<{ debitAmount: string; creditAmount: string }>,
): void => {
  const debits = entries.reduce(
    (sum, entry) => sum.plus(new Prisma.Decimal(entry.debitAmount)),
    new Prisma.Decimal(0),
  );
  const credits = entries.reduce(
    (sum, entry) => sum.plus(new Prisma.Decimal(entry.creditAmount)),
    new Prisma.Decimal(0),
  );
  const validSides = entries.every((entry) => {
    const debit = new Prisma.Decimal(entry.debitAmount);
    const credit = new Prisma.Decimal(entry.creditAmount);
    return (debit.gt(0) && credit.isZero()) || (credit.gt(0) && debit.isZero());
  });

  if (entries.length < 2 || !validSides || !debits.equals(credits)) {
    throw new HttpError(
      422,
      "LEDGER_UNBALANCED",
      "Every ledger transaction must have equal debits and credits.",
    );
  }
};
