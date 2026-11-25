import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { HttpError } from "../../lib/http-error.js";
import {
  calculateFifo,
  calculateTradeAmount,
  calculateXirr,
  buildPurchaseEntries,
  buildSaleEntries,
  buildValuationEntries,
  type JournalEntry,
} from "./investments.math.js";
import type {
  InvestmentRecord,
  InvestmentType,
  InvestmentsRepository,
  PriceSource,
} from "./investments.types.js";

const dateOnly = (date: Date): string => date.toISOString().slice(0, 10);
const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const keyHash = (userId: string, key: string, purpose: string): string =>
  `${purpose}_${createHash("sha256").update(`${userId}:${key}`).digest("hex").slice(0, 40)}`;
const roundMoney = (amount: Prisma.Decimal): Prisma.Decimal =>
  amount.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
const isUniqueError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "P2002";

export class PrismaInvestmentsRepository implements InvestmentsRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async list(userId: string, type?: InvestmentType): Promise<InvestmentRecord[]> {
    const investments = await this.prisma.investment.findMany({
      where: { userId, ...(type ? { investmentType: type } : {}) },
      include: {
        activities: { orderBy: [{ effectiveDate: "asc" }, { createdAt: "asc" }] },
        prices: { orderBy: [{ effectiveDate: "desc" }, { createdAt: "desc" }], take: 1 },
        valuations: {
          orderBy: [{ effectiveDate: "desc" }, { createdAt: "desc" }],
          take: 1,
        },
      },
      orderBy: [{ investmentType: "asc" }, { name: "asc" }],
    });
    return investments.map((investment) => {
      const fifo = calculateFifo(
        investment.activities.map((activity) => ({
          id: activity.id,
          type: activity.activityType as "BUY" | "SELL" | "CONTRIBUTION" | "WITHDRAWAL",
          effectiveDate: dateOnly(activity.effectiveDate),
          units: activity.units?.toFixed(8) ?? null,
          amount: activity.amount.toFixed(2),
        })),
      );
      const latestPrice = investment.prices[0];
      const latestValuation = investment.valuations[0];
      const marketType = ["NPS", "MUTUAL_FUND", "STOCK"].includes(
        investment.investmentType,
      );
      const fallbackActivity =
        marketType && !latestPrice
          ? [...investment.activities].reverse().find((activity) => activity.unitPrice)
          : undefined;
      const effectivePrice = latestPrice?.unitPrice ?? fallbackActivity?.unitPrice;
      const unitPrice = effectivePrice?.toFixed(8) ?? null;
      const currentValue = marketType
        ? effectivePrice
          ? roundMoney(new Prisma.Decimal(fifo.units).times(effectivePrice)).toFixed(2)
          : fifo.costBasis
        : (latestValuation?.currentValue.toFixed(2) ?? fifo.costBasis);
      const asOf = marketType
        ? (latestPrice?.effectiveDate ?? fallbackActivity?.effectiveDate)
        : latestValuation?.effectiveDate;
      const fallbackDate = fallbackActivity?.effectiveDate;
      const priceDate = asOf
        ? dateOnly(asOf)
        : fallbackDate
          ? dateOnly(fallbackDate)
          : null;
      const price = unitPrice ?? fallbackActivity?.unitPrice?.toFixed(8) ?? null;
      const priceSource =
        latestPrice?.source ??
        (fallbackActivity ? "MANUAL" : latestValuation ? "MANUAL" : null);
      const invested = fifo.costBasis;
      const today = this.todayInKolkata();
      const flows = investment.activities.map((activity) => ({
        date: dateOnly(activity.effectiveDate),
        amount: ["BUY", "CONTRIBUTION"].includes(activity.activityType)
          ? activity.amount.negated().toFixed(2)
          : activity.amount.toFixed(2),
      }));
      if (new Prisma.Decimal(currentValue).gt(0))
        flows.push({ date: today, amount: currentValue });
      const ageLimit = marketType ? 5 : 365;
      const stale = Boolean(priceDate && this.dayDifference(priceDate, today) > ageLimit);
      return {
        id: investment.id,
        investmentType: investment.investmentType,
        name: investment.name,
        provider: investment.provider,
        symbol: investment.symbol,
        annualRate: investment.annualRate?.toFixed(4) ?? null,
        maturityDate: investment.maturityDate ? dateOnly(investment.maturityDate) : null,
        units: fifo.units,
        invested,
        currentValue,
        realizedPl: fifo.realizedPl,
        unrealizedPl: roundMoney(
          new Prisma.Decimal(currentValue).minus(invested),
        ).toFixed(2),
        xirr: investment.activities.length ? this.xirr(flows) : null,
        price,
        priceSource,
        priceDate,
        stale,
        activities: investment.activities
          .slice()
          .reverse()
          .map((activity) => ({
            id: activity.id,
            type: activity.activityType,
            effectiveDate: dateOnly(activity.effectiveDate),
            units: activity.units?.toFixed(8) ?? null,
            unitPrice: activity.unitPrice?.toFixed(8) ?? null,
            amount: activity.amount.toFixed(2),
            costBasisAmount: activity.costBasisAmount?.toFixed(2) ?? null,
            note: activity.note,
          })),
      };
    });
  }

  async create(
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
  ): Promise<string> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const prior = await tx.investment.findFirst({
          where: { userId, idempotencyKey },
        });
        if (prior) {
          if (prior.requestHash !== requestHash) throw this.idempotencyError();
          return prior.id;
        }
        const investmentId = `INV_${randomUUID().replaceAll("-", "")}`;
        const ledgerAccount = await tx.ledgerAccount.create({
          data: {
            userId,
            code: investmentId,
            name: input.name,
            category: "ASSET",
            normalBalance: "DEBIT",
          },
          select: { id: true },
        });
        const investment = await tx.investment.create({
          data: {
            userId,
            investmentType: input.investmentType,
            name: input.name,
            provider: input.provider,
            symbol: input.symbol,
            annualRate: input.annualRate ? new Prisma.Decimal(input.annualRate) : null,
            maturityDate: input.maturityDate
              ? new Date(`${input.maturityDate}T00:00:00.000Z`)
              : null,
            ledgerAccountId: ledgerAccount.id,
            idempotencyKey,
            requestHash,
          },
          select: { id: true },
        });
        await tx.auditLog.create({
          data: {
            userId,
            entityType: "INVESTMENT",
            entityId: investment.id,
            action: "INVESTMENT_CREATED",
            changes: input,
          },
        });
        return investment.id;
      });
    } catch (error) {
      if (!isUniqueError(error)) throw error;
      const raced = await this.prisma.investment.findFirst({
        where: { userId, idempotencyKey },
      });
      if (!raced) throw error;
      if (raced.requestHash !== requestHash) throw this.idempotencyError();
      return raced.id;
    }
  }

  async transact(
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
  ): Promise<void> {
    try {
      await this.prisma.$transaction(
        async (tx) => {
          const prior = await tx.investmentActivity.findFirst({
            where: { userId, idempotencyKey },
          });
          if (prior) {
            if (prior.requestHash !== requestHash) throw this.idempotencyError();
            return;
          }
          const investment = await tx.investment.findFirst({
            where: { id: input.investmentId, userId },
          });
          if (!investment)
            throw new HttpError(
              404,
              "INVESTMENT_NOT_FOUND",
              "The investment was not found.",
            );
          const account = await tx.financialAccount.findFirst({
            where: {
              id: input.accountId,
              userId,
              accountType: { in: ["BANK", "CASH", "UPI"] },
            },
            select: { ledgerAccountId: true },
          });
          if (!account)
            throw new HttpError(
              404,
              "PAYMENT_ACCOUNT_NOT_FOUND",
              "Choose an owned bank, cash, or UPI account.",
            );
          const lockedIds = [investment.ledgerAccountId, account.ledgerAccountId].sort();
          await tx.$queryRaw(
            Prisma.sql`SELECT id FROM ledger_accounts WHERE user_id = ${userId} AND id IN (${Prisma.join(lockedIds)}) ORDER BY id FOR UPDATE`,
          );
          const source = {
            BUY: "INVESTMENT_BUY",
            SELL: "INVESTMENT_SELL",
            CONTRIBUTION: "INVESTMENT_CONTRIBUTION",
            WITHDRAWAL: "INVESTMENT_WITHDRAWAL",
          } as const;
          let entries: JournalEntry[];
          let costBasisAmount = input.costBasisAmount;
          let purchasePriceSnapshot: {
            unitPrice: string;
            idempotencyKey: string;
          } | null = null;
          if (input.activityType === "BUY" || input.activityType === "CONTRIBUTION") {
            await this.assertAccountFunds(tx, account.ledgerAccountId, input.amount);
            entries = buildPurchaseEntries(
              investment.ledgerAccountId,
              account.ledgerAccountId,
              input.amount,
            );
            if (input.activityType === "BUY" && input.units && input.unitPrice) {
              const previousActivities = await tx.investmentActivity.findMany({
                where: {
                  userId,
                  investmentId: investment.id,
                  activityType: { in: ["BUY", "SELL"] },
                },
                orderBy: [{ effectiveDate: "asc" }, { createdAt: "asc" }],
              });
              const previousFifo = calculateFifo(
                previousActivities.map((activity) => ({
                  id: activity.id,
                  type: activity.activityType as "BUY" | "SELL",
                  effectiveDate: dateOnly(activity.effectiveDate),
                  units: activity.units?.toFixed(8) ?? null,
                  amount: activity.amount.toFixed(2),
                })),
              );
              const currentBook = await this.ledgerBalance(
                tx,
                investment.ledgerAccountId,
              );
              const marketValue = roundMoney(
                new Prisma.Decimal(previousFifo.units)
                  .plus(input.units)
                  .times(input.unitPrice),
              );
              const revaluation = marketValue.minus(currentBook.plus(input.amount));
              if (!revaluation.isZero()) {
                const valuationAccount = await this.systemAccount(
                  tx,
                  userId,
                  "SYS_INVESTMENT_VALUATION",
                  "Investment valuation reserve",
                  "EQUITY",
                  "CREDIT",
                );
                entries.push(
                  ...buildValuationEntries(
                    investment.ledgerAccountId,
                    valuationAccount,
                    revaluation.toFixed(2),
                  ),
                );
              }
              purchasePriceSnapshot = {
                unitPrice: input.unitPrice,
                idempotencyKey: keyHash(userId, idempotencyKey, "INV_TRADE_PRICE"),
              };
            }
          } else if (input.activityType === "SELL") {
            const activities = await tx.investmentActivity.findMany({
              where: {
                userId,
                investmentId: investment.id,
                activityType: { in: ["BUY", "SELL"] },
              },
              orderBy: [{ effectiveDate: "asc" }, { createdAt: "asc" }],
            });
            let fifo: ReturnType<typeof calculateFifo>;
            try {
              fifo = calculateFifo([
                ...activities.map((activity) => ({
                  id: activity.id,
                  type: activity.activityType as "BUY" | "SELL",
                  effectiveDate: dateOnly(activity.effectiveDate),
                  units: activity.units?.toFixed(8) ?? null,
                  amount: activity.amount.toFixed(2),
                })),
                {
                  id: "pending-sale",
                  type: "SELL",
                  effectiveDate: input.effectiveDate,
                  units: input.units,
                  amount: input.amount,
                },
              ]);
            } catch {
              throw new HttpError(
                409,
                "UNITS_EXCEED_HOLDING",
                "The sale exceeds the units currently held.",
              );
            }
            costBasisAmount = fifo.sales.get("pending-sale") ?? "0.00";
            const latestPrice = await tx.investmentPriceSnapshot.findFirst({
              where: {
                investmentId: investment.id,
                effectiveDate: { lte: new Date(`${input.effectiveDate}T00:00:00.000Z`) },
              },
              orderBy: [{ effectiveDate: "desc" }, { createdAt: "desc" }],
            });
            const carryingValue = latestPrice
              ? calculateTradeAmount(input.units!, latestPrice.unitPrice.toFixed(8))
              : costBasisAmount;
            const [valuationEquity, realizedGain, realizedLoss] = await Promise.all([
              this.systemAccount(
                tx,
                userId,
                "SYS_INVESTMENT_VALUATION",
                "Investment valuation reserve",
                "EQUITY",
                "CREDIT",
              ),
              this.systemAccount(
                tx,
                userId,
                "SYS_INVESTMENT_REALIZED_GAIN",
                "Realized investment gains",
                "INCOME",
                "CREDIT",
              ),
              this.systemAccount(
                tx,
                userId,
                "SYS_INVESTMENT_REALIZED_LOSS",
                "Realized investment losses",
                "EXPENSE",
                "DEBIT",
              ),
            ]);
            entries = buildSaleEntries({
              assetId: investment.ledgerAccountId,
              cashId: account.ledgerAccountId,
              valuationEquityId: valuationEquity,
              realizedGainId: realizedGain,
              realizedLossId: realizedLoss,
              proceeds: input.amount,
              carryingValue,
              costBasis: costBasisAmount,
            });
          } else {
            const assetBalance = await this.ledgerBalance(tx, investment.ledgerAccountId);
            if (new Prisma.Decimal(input.amount).gt(assetBalance))
              throw new HttpError(
                409,
                "WITHDRAWAL_EXCEEDS_VALUE",
                "Withdrawal cannot exceed the investment's recorded value.",
              );
            entries = [
              {
                ledgerAccountId: account.ledgerAccountId,
                debitAmount: input.amount,
                creditAmount: "0.00",
              },
              {
                ledgerAccountId: investment.ledgerAccountId,
                debitAmount: "0.00",
                creditAmount: input.amount,
              },
            ];
          }
          const transaction = await this.writeLedger(tx, {
            userId,
            investmentId: investment.id,
            effectiveDate: input.effectiveDate,
            description:
              input.note || `${investment.name} ${input.activityType.toLowerCase()}`,
            source: source[input.activityType],
            idempotencyKey,
            requestHash,
            entries,
          });
          await tx.investmentActivity.create({
            data: {
              userId,
              investmentId: investment.id,
              ledgerTransactionId: transaction.id,
              activityType: input.activityType,
              effectiveDate: new Date(`${input.effectiveDate}T00:00:00.000Z`),
              units: input.units ? new Prisma.Decimal(input.units) : null,
              unitPrice: input.unitPrice ? new Prisma.Decimal(input.unitPrice) : null,
              amount: new Prisma.Decimal(input.amount),
              costBasisAmount: costBasisAmount
                ? new Prisma.Decimal(costBasisAmount)
                : null,
              note: input.note || null,
              idempotencyKey,
              requestHash,
            },
          });
          if (purchasePriceSnapshot) {
            await tx.investmentPriceSnapshot.create({
              data: {
                investmentId: investment.id,
                effectiveDate: new Date(`${input.effectiveDate}T00:00:00.000Z`),
                unitPrice: new Prisma.Decimal(purchasePriceSnapshot.unitPrice),
                source: "MANUAL",
                idempotencyKey: purchasePriceSnapshot.idempotencyKey,
                requestHash,
              },
            });
          }
          await tx.auditLog.create({
            data: {
              userId,
              entityType: "INVESTMENT",
              entityId: investment.id,
              action: `INVESTMENT_${input.activityType}`,
              changes: { ...input, requestHash },
            },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      );
    } catch (error) {
      if (!isUniqueError(error)) throw error;
      const raced = await this.prisma.investmentActivity.findFirst({
        where: { userId, idempotencyKey },
        select: { requestHash: true },
      });
      if (!raced) throw error;
      if (raced.requestHash !== requestHash) throw this.idempotencyError();
    }
  }

  async setPrice(
    userId: string,
    investmentId: string,
    idempotencyKey: string,
    input: { effectiveDate: string; unitPrice: string; source: PriceSource },
  ): Promise<void> {
    const requestHash = hash({ investmentId, ...input });
    await this.prisma.$transaction(
      async (tx) => {
        const previous = await tx.investmentPriceSnapshot.findFirst({
          where: { investmentId, idempotencyKey },
        });
        if (previous) {
          const owned = await tx.investment.findFirst({
            where: { id: investmentId, userId },
            select: { id: true },
          });
          if (!owned)
            throw new HttpError(
              404,
              "INVESTMENT_NOT_FOUND",
              "The investment was not found.",
            );
          if (previous.requestHash !== requestHash) throw this.idempotencyError();
          return;
        }
        const investment = await tx.investment.findFirst({
          where: { id: investmentId, userId },
        });
        if (!investment)
          throw new HttpError(
            404,
            "INVESTMENT_NOT_FOUND",
            "The investment was not found.",
          );
        if (!["NPS", "MUTUAL_FUND", "STOCK"].includes(investment.investmentType))
          throw new HttpError(
            400,
            "MARKET_INVESTMENT_REQUIRED",
            "Only NPS, mutual funds, and stocks use unit prices.",
          );
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM ledger_accounts WHERE user_id = ${userId} AND id = ${investment.ledgerAccountId} FOR UPDATE`,
        );
        const activities = await tx.investmentActivity.findMany({
          where: { investmentId, userId, activityType: { in: ["BUY", "SELL"] } },
          orderBy: [{ effectiveDate: "asc" }, { createdAt: "asc" }],
        });
        const fifo = calculateFifo(
          activities.map((activity) => ({
            id: activity.id,
            type: activity.activityType as "BUY" | "SELL",
            effectiveDate: dateOnly(activity.effectiveDate),
            units: activity.units?.toFixed(8) ?? null,
            amount: activity.amount.toFixed(2),
          })),
        );
        const marketValue = roundMoney(
          new Prisma.Decimal(fifo.units).times(input.unitPrice),
        );
        const currentBook = await this.ledgerBalance(tx, investment.ledgerAccountId);
        const delta = marketValue.minus(currentBook);
        if (!delta.isZero()) {
          const valuationAccount = await this.systemAccount(
            tx,
            userId,
            "SYS_INVESTMENT_VALUATION",
            "Investment valuation reserve",
            "EQUITY",
            "CREDIT",
          );
          const entries = buildValuationEntries(
            investment.ledgerAccountId,
            valuationAccount,
            delta.toFixed(2),
          );
          await this.writeLedger(tx, {
            userId,
            investmentId,
            effectiveDate: input.effectiveDate,
            description: `${investment.name} market valuation`,
            source: "INVESTMENT_VALUATION",
            idempotencyKey: keyHash(userId, idempotencyKey, "INV_PRICE_POST"),
            requestHash,
            entries,
          });
        }
        await tx.investmentPriceSnapshot.create({
          data: {
            investmentId,
            effectiveDate: new Date(`${input.effectiveDate}T00:00:00.000Z`),
            unitPrice: new Prisma.Decimal(input.unitPrice),
            source: input.source,
            idempotencyKey,
            requestHash,
          },
        });
        await tx.auditLog.create({
          data: {
            userId,
            entityType: "INVESTMENT",
            entityId: investmentId,
            action: "INVESTMENT_PRICE_UPDATED",
            changes: input,
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  async setValuation(
    userId: string,
    investmentId: string,
    idempotencyKey: string,
    input: { effectiveDate: string; currentValue: string },
  ): Promise<void> {
    const requestHash = hash({ investmentId, ...input });
    await this.prisma.$transaction(
      async (tx) => {
        const previous = await tx.investmentValuation.findFirst({
          where: { investmentId, idempotencyKey },
        });
        if (previous) {
          const owned = await tx.investment.findFirst({
            where: { id: investmentId, userId },
            select: { id: true },
          });
          if (!owned)
            throw new HttpError(
              404,
              "INVESTMENT_NOT_FOUND",
              "The investment was not found.",
            );
          if (previous.requestHash !== requestHash) throw this.idempotencyError();
          return;
        }
        const investment = await tx.investment.findFirst({
          where: { id: investmentId, userId },
        });
        if (!investment)
          throw new HttpError(
            404,
            "INVESTMENT_NOT_FOUND",
            "The investment was not found.",
          );
        if (!["FD", "PPF", "EPF"].includes(investment.investmentType))
          throw new HttpError(
            400,
            "FIXED_INVESTMENT_REQUIRED",
            "Manual total valuations are for FD, PPF, and EPF.",
          );
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM ledger_accounts WHERE user_id = ${userId} AND id = ${investment.ledgerAccountId} FOR UPDATE`,
        );
        const currentBook = await this.ledgerBalance(tx, investment.ledgerAccountId);
        const delta = new Prisma.Decimal(input.currentValue).minus(currentBook);
        let transactionId: string | null = null;
        if (!delta.isZero()) {
          const valuationAccount = await this.systemAccount(
            tx,
            userId,
            "SYS_INVESTMENT_VALUATION",
            "Investment valuation reserve",
            "EQUITY",
            "CREDIT",
          );
          const transaction = await this.writeLedger(tx, {
            userId,
            investmentId,
            effectiveDate: input.effectiveDate,
            description: `${investment.name} manual valuation`,
            source: "INVESTMENT_VALUATION",
            idempotencyKey: keyHash(userId, idempotencyKey, "INV_VALUE_POST"),
            requestHash,
            entries: buildValuationEntries(
              investment.ledgerAccountId,
              valuationAccount,
              delta.toFixed(2),
            ),
          });
          transactionId = transaction.id;
        }
        await tx.investmentValuation.create({
          data: {
            investmentId,
            effectiveDate: new Date(`${input.effectiveDate}T00:00:00.000Z`),
            currentValue: new Prisma.Decimal(input.currentValue),
            ledgerTransactionId: transactionId,
            idempotencyKey,
            requestHash,
          },
        });
        await tx.auditLog.create({
          data: {
            userId,
            entityType: "INVESTMENT",
            entityId: investmentId,
            action: "INVESTMENT_VALUED",
            changes: input,
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  private async assertAccountFunds(
    tx: Prisma.TransactionClient,
    ledgerAccountId: string,
    amount: string,
  ): Promise<void> {
    const balance = await this.ledgerBalance(tx, ledgerAccountId);
    if (new Prisma.Decimal(amount).gt(balance))
      throw new HttpError(
        409,
        "INSUFFICIENT_FUNDS",
        "The selected account does not have enough balance.",
      );
  }

  private async ledgerBalance(
    tx: Prisma.TransactionClient,
    ledgerAccountId: string,
  ): Promise<Prisma.Decimal> {
    const totals = await tx.transactionEntry.aggregate({
      where: { ledgerAccountId },
      _sum: { debitAmount: true, creditAmount: true },
    });
    return (totals._sum.debitAmount ?? new Prisma.Decimal(0)).minus(
      totals._sum.creditAmount ?? new Prisma.Decimal(0),
    );
  }

  private async systemAccount(
    tx: Prisma.TransactionClient,
    userId: string,
    code: string,
    name: string,
    category: "EQUITY" | "INCOME" | "EXPENSE",
    normalBalance: "CREDIT" | "DEBIT",
  ): Promise<string> {
    const account = await tx.ledgerAccount.upsert({
      where: { userId_code: { userId, code } },
      create: { userId, code, name, category, normalBalance, isSystem: true },
      update: {},
      select: { id: true },
    });
    return account.id;
  }

  private async writeLedger(
    tx: Prisma.TransactionClient,
    input: {
      userId: string;
      investmentId: string;
      effectiveDate: string;
      description: string;
      source:
        | "INVESTMENT_BUY"
        | "INVESTMENT_SELL"
        | "INVESTMENT_CONTRIBUTION"
        | "INVESTMENT_WITHDRAWAL"
        | "INVESTMENT_VALUATION";
      idempotencyKey: string;
      requestHash: string;
      entries: JournalEntry[];
    },
  ) {
    const debits = input.entries.reduce(
      (sum, entry) => sum.plus(entry.debitAmount),
      new Prisma.Decimal(0),
    );
    const credits = input.entries.reduce(
      (sum, entry) => sum.plus(entry.creditAmount),
      new Prisma.Decimal(0),
    );
    const validSides = input.entries.every((entry) => {
      const debit = new Prisma.Decimal(entry.debitAmount);
      const credit = new Prisma.Decimal(entry.creditAmount);
      return (debit.gt(0) && credit.isZero()) || (credit.gt(0) && debit.isZero());
    });
    if (input.entries.length < 2 || !validSides || !debits.equals(credits))
      throw new HttpError(
        422,
        "LEDGER_UNBALANCED",
        "Investment ledger posting must have equal debits and credits.",
      );
    const accountIds = [...new Set(input.entries.map((entry) => entry.ledgerAccountId))];
    const count = await tx.ledgerAccount.count({
      where: { userId: input.userId, id: { in: accountIds } },
    });
    if (count !== accountIds.length)
      throw new HttpError(
        404,
        "LEDGER_ACCOUNT_NOT_FOUND",
        "A required ledger account was not found.",
      );
    const transaction = await tx.ledgerTransaction.create({
      data: {
        userId: input.userId,
        investmentId: input.investmentId,
        effectiveDate: new Date(`${input.effectiveDate}T00:00:00.000Z`),
        description: input.description,
        source: input.source,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        entries: {
          create: input.entries.map((entry) => ({
            ledgerAccountId: entry.ledgerAccountId,
            debitAmount: new Prisma.Decimal(entry.debitAmount),
            creditAmount: new Prisma.Decimal(entry.creditAmount),
          })),
        },
      },
      select: { id: true },
    });
    await tx.auditLog.create({
      data: {
        userId: input.userId,
        entityType: "LEDGER_TRANSACTION",
        entityId: transaction.id,
        action: "TRANSACTION_POSTED",
        changes: {
          source: input.source,
          investmentId: input.investmentId,
          effectiveDate: input.effectiveDate,
          entries: input.entries,
        },
      },
    });
    return transaction;
  }

  private xirr(flows: Array<{ date: string; amount: string }>): string | null {
    // Imported lazily to keep ledger persistence independent of return calculations.
    return calculateXirr(flows);
  }

  private todayInKolkata(): string {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const get = (type: "year" | "month" | "day") =>
      parts.find((part) => part.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  }

  private dayDifference(start: string, end: string): number {
    return Math.floor(
      (Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)) /
        86_400_000,
    );
  }

  private idempotencyError(): HttpError {
    return new HttpError(
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "This idempotency key was already used for different data.",
    );
  }
}
