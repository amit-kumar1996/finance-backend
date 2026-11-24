import { randomBytes } from "node:crypto";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { Prisma } from "../../generated/prisma/client.js";
import { HttpError } from "../../lib/http-error.js";
import type { LedgerTransactionSource } from "../accounts/accounts.types.js";
import type {
  IdempotentPersonResource,
  PeopleRepository,
  PersonMovement,
  PersonMutationInput,
  PersonRecord,
  PersonStatement,
  PersonStatementRow,
  PersonSummary,
} from "./people.types.js";

const movementBySource: Partial<Record<LedgerTransactionSource, PersonMovement>> = {
  PERSON_GIVE: "GIVE",
  PERSON_RECEIVE: "RECEIVE",
  PERSON_BORROW: "BORROW",
  PERSON_REPAY: "REPAY",
};

const toDateString = (date: Date): string => date.toISOString().slice(0, 10);

const transactionSources: LedgerTransactionSource[] = [
  "PERSON_GIVE",
  "PERSON_RECEIVE",
  "PERSON_BORROW",
  "PERSON_REPAY",
  "REVERSAL",
];

type PersonWithAccounts = Prisma.PersonGetPayload<{
  include: {
    receivableAccount: { select: { id: true } };
    payableAccount: { select: { id: true } };
  };
}>;

export class PrismaPeopleRepository implements PeopleRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listPeople(userId: string): Promise<PersonSummary[]> {
    const people = await this.prisma.person.findMany({
      where: { userId, archivedAt: null },
      include: {
        receivableAccount: { select: { id: true } },
        payableAccount: { select: { id: true } },
      },
      orderBy: [{ name: "asc" }, { createdAt: "asc" }],
    });
    return Promise.all(people.map((person) => this.summarize(person)));
  }

  async getPerson(
    userId: string,
    personId: string,
    includeArchived = false,
  ): Promise<PersonRecord | null> {
    const person = await this.prisma.person.findFirst({
      where: { userId, id: personId, ...(includeArchived ? {} : { archivedAt: null }) },
      include: {
        receivableAccount: { select: { id: true } },
        payableAccount: { select: { id: true } },
      },
    });
    return person ? this.summarize(person) : null;
  }

  async getStatement(userId: string, personId: string): Promise<PersonStatement | null> {
    const person = await this.prisma.person.findFirst({
      where: { userId, id: personId },
      include: {
        receivableAccount: { select: { id: true } },
        payableAccount: { select: { id: true } },
      },
    });
    if (!person) return null;
    const transactions = await this.prisma.ledgerTransaction.findMany({
      where: {
        userId,
        source: { in: transactionSources },
        entries: {
          some: {
            ledgerAccountId: {
              in: [person.receivableAccountId, person.payableAccountId],
            },
          },
        },
      },
      select: {
        id: true,
        effectiveDate: true,
        createdAt: true,
        description: true,
        source: true,
        reversalOfId: true,
        entries: {
          where: {
            ledgerAccountId: {
              in: [person.receivableAccountId, person.payableAccountId],
            },
          },
          select: { ledgerAccountId: true, debitAmount: true, creditAmount: true },
        },
      },
      orderBy: [{ effectiveDate: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    });
    let runningNetBalance = new Prisma.Decimal(0);
    const statementRows: PersonStatementRow[] = transactions.map((transaction) => {
      let netDelta = new Prisma.Decimal(0);
      for (const entry of transaction.entries) {
        const debit = entry.debitAmount;
        const credit = entry.creditAmount;
        const entryDelta =
          entry.ledgerAccountId === person.receivableAccountId
            ? debit.minus(credit)
            : credit.minus(debit);
        netDelta = netDelta.plus(
          entry.ledgerAccountId === person.receivableAccountId
            ? entryDelta
            : entryDelta.negated(),
        );
      }
      runningNetBalance = runningNetBalance.plus(netDelta);
      return {
        id: transaction.id,
        effectiveDate: toDateString(transaction.effectiveDate),
        description: transaction.description,
        movement:
          transaction.source === "REVERSAL"
            ? "REVERSAL"
            : movementBySource[transaction.source]!,
        amount: netDelta.abs().toFixed(2),
        netEffect: netDelta.gte(0) ? "INCREASED" : "DECREASED",
        runningNetBalance: runningNetBalance.toFixed(2),
        reversalOfId: transaction.reversalOfId,
      };
    });
    return {
      person: await this.summarize(person),
      transactions: statementRows.reverse(),
    };
  }

  findIdempotencyRecord(
    userId: string,
    key: string,
  ): Promise<IdempotentPersonResource | null> {
    return this.prisma.idempotencyRecord.findFirst({
      where: { userId, key },
      select: { resourceId: true, requestHash: true },
    });
  }

  createPerson(input: PersonMutationInput): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.idempotencyRecord.findFirst({
        where: { userId: input.userId, key: input.idempotencyKey },
      });
      if (existing) return this.requireMatchingRecord(existing, input.requestHash);
      const personId = randomBytes(12).toString("base64url");
      const receivableAccount = await tx.ledgerAccount.create({
        data: {
          userId: input.userId,
          code: `PERSON_REC_${personId}`,
          name: `${input.name} receivable`,
          category: "ASSET",
          normalBalance: "DEBIT",
          isSystem: false,
        },
      });
      const payableAccount = await tx.ledgerAccount.create({
        data: {
          userId: input.userId,
          code: `PERSON_PAY_${personId}`,
          name: `${input.name} payable`,
          category: "LIABILITY",
          normalBalance: "CREDIT",
          isSystem: false,
        },
      });
      const person = await tx.person.create({
        data: {
          id: personId,
          userId: input.userId,
          name: input.name,
          notes: input.notes,
          receivableAccountId: receivableAccount.id,
          payableAccountId: payableAccount.id,
        },
      });
      await tx.auditLog.create({
        data: {
          userId: input.userId,
          entityType: "PERSON",
          entityId: person.id,
          action: "PERSON_CREATED",
          changes: { name: person.name, notes: person.notes },
        },
      });
      await this.recordIdempotency(tx, input, "PERSON", person.id);
      return person.id;
    });
  }

  updatePerson(input: PersonMutationInput): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.idempotencyRecord.findFirst({
        where: { userId: input.userId, key: input.idempotencyKey },
      });
      if (existing) return this.requireMatchingRecord(existing, input.requestHash);
      const current = await tx.person.findFirst({
        where: { id: input.personId ?? "", userId: input.userId, archivedAt: null },
      });
      if (!current) throw this.personNotFound();
      const person = await tx.person.update({
        where: { id: current.id },
        data: { name: input.name, notes: input.notes },
      });
      await tx.ledgerAccount.update({
        where: { id: current.receivableAccountId },
        data: { name: `${input.name} receivable` },
      });
      await tx.ledgerAccount.update({
        where: { id: current.payableAccountId },
        data: { name: `${input.name} payable` },
      });
      await tx.auditLog.create({
        data: {
          userId: input.userId,
          entityType: "PERSON",
          entityId: person.id,
          action: "PERSON_UPDATED",
          changes: { name: person.name, notes: person.notes },
        },
      });
      await this.recordIdempotency(tx, input, "PERSON", person.id);
      return person.id;
    });
  }

  archivePerson(input: Omit<PersonMutationInput, "name" | "notes">): Promise<string> {
    return this.prisma.$transaction(
      async (tx) => {
        const existing = await tx.idempotencyRecord.findFirst({
          where: { userId: input.userId, key: input.idempotencyKey },
        });
        if (existing) return this.requireMatchingRecord(existing, input.requestHash);
        const person = await tx.person.findFirst({
          where: { id: input.personId ?? "", userId: input.userId, archivedAt: null },
        });
        if (!person) throw this.personNotFound();
        const accountIds = [person.receivableAccountId, person.payableAccountId].sort();
        await tx.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`SELECT id FROM ledger_accounts
          WHERE user_id = ${input.userId} AND id IN (${Prisma.join(accountIds)})
          ORDER BY id FOR UPDATE`,
        );
        const sums = await tx.transactionEntry.groupBy({
          by: ["ledgerAccountId"],
          where: { ledgerAccountId: { in: accountIds } },
          _sum: { debitAmount: true, creditAmount: true },
        });
        const balanceFor = (accountId: string, normal: "DEBIT" | "CREDIT") => {
          const item = sums.find((sum) => sum.ledgerAccountId === accountId);
          const debits = item?._sum.debitAmount ?? new Prisma.Decimal(0);
          const credits = item?._sum.creditAmount ?? new Prisma.Decimal(0);
          return normal === "DEBIT" ? debits.minus(credits) : credits.minus(debits);
        };
        if (
          !balanceFor(person.receivableAccountId, "DEBIT").isZero() ||
          !balanceFor(person.payableAccountId, "CREDIT").isZero()
        ) {
          throw new HttpError(
            409,
            "PERSON_HAS_OPEN_BALANCE",
            "Settle this person's balance before archiving them.",
          );
        }
        await tx.person.update({
          where: { id: person.id },
          data: { archivedAt: new Date() },
        });
        await tx.auditLog.create({
          data: {
            userId: input.userId,
            entityType: "PERSON",
            entityId: person.id,
            action: "PERSON_ARCHIVED",
            changes: { archivedAt: new Date().toISOString() },
          },
        });
        await this.recordIdempotency(tx, input, "PERSON", person.id);
        return person.id;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  private async summarize(person: PersonWithAccounts): Promise<PersonRecord> {
    const transactions = await this.prisma.ledgerTransaction.findMany({
      where: {
        userId: person.userId,
        source: { in: transactionSources },
        entries: {
          some: {
            ledgerAccountId: {
              in: [person.receivableAccountId, person.payableAccountId],
            },
          },
        },
      },
      select: {
        id: true,
        source: true,
        reversalOfId: true,
        entries: {
          where: {
            ledgerAccountId: {
              in: [person.receivableAccountId, person.payableAccountId],
            },
          },
          select: { ledgerAccountId: true, debitAmount: true, creditAmount: true },
        },
      },
    });
    const transactionById = new Map(
      transactions.map((transaction) => [transaction.id, transaction]),
    );
    const totals = {
      given: new Prisma.Decimal(0),
      received: new Prisma.Decimal(0),
      borrowed: new Prisma.Decimal(0),
      repaid: new Prisma.Decimal(0),
      receivable: new Prisma.Decimal(0),
      payable: new Prisma.Decimal(0),
    };
    for (const transaction of transactions) {
      let receivableDelta = new Prisma.Decimal(0);
      let payableDelta = new Prisma.Decimal(0);
      for (const entry of transaction.entries) {
        const delta = entry.debitAmount.minus(entry.creditAmount);
        if (entry.ledgerAccountId === person.receivableAccountId) {
          receivableDelta = receivableDelta.plus(delta);
        } else {
          payableDelta = payableDelta.minus(delta);
        }
      }
      totals.receivable = totals.receivable.plus(receivableDelta);
      totals.payable = totals.payable.plus(payableDelta);
      const original =
        transaction.source === "REVERSAL" && transaction.reversalOfId
          ? transactionById.get(transaction.reversalOfId)
          : undefined;
      const movement = original
        ? movementBySource[original.source]
        : movementBySource[transaction.source];
      if (movement) {
        const sign = original ? -1 : 1;
        const target = {
          GIVE: "given",
          RECEIVE: "received",
          BORROW: "borrowed",
          REPAY: "repaid",
        }[movement] as "given" | "received" | "borrowed" | "repaid";
        totals[target] = totals[target].plus(
          receivableDelta.abs().plus(payableDelta.abs()).mul(sign),
        );
      }
    }
    const net = totals.receivable.minus(totals.payable);
    const hasGiven =
      !totals.given.isZero() || !totals.received.isZero() || !totals.receivable.isZero();
    const hasBorrowed =
      !totals.borrowed.isZero() || !totals.repaid.isZero() || !totals.payable.isZero();
    const type =
      hasGiven && hasBorrowed
        ? "Both"
        : hasBorrowed
          ? "Borrowed"
          : hasGiven
            ? "Given"
            : "—";
    const givenOrBorrowed = totals.given.plus(totals.borrowed);
    const receivedOrRepaid = totals.received.plus(totals.repaid);
    return {
      id: person.id,
      name: person.name,
      notes: person.notes,
      createdAt: person.createdAt,
      archivedAt: person.archivedAt,
      receivableLedgerAccountId: person.receivableAccountId,
      payableLedgerAccountId: person.payableAccountId,
      givenTotal: totals.given.toFixed(2),
      receivedTotal: totals.received.toFixed(2),
      borrowedTotal: totals.borrowed.toFixed(2),
      repaidTotal: totals.repaid.toFixed(2),
      receivableBalance: totals.receivable.toFixed(2),
      payableBalance: totals.payable.toFixed(2),
      netBalance: net.toFixed(2),
      type,
      givenOrBorrowed: givenOrBorrowed.toFixed(2),
      receivedOrRepaid: receivedOrRepaid.toFixed(2),
    };
  }

  private async recordIdempotency(
    tx: Prisma.TransactionClient,
    input: Pick<PersonMutationInput, "userId" | "idempotencyKey" | "requestHash">,
    resourceType: string,
    resourceId: string,
  ): Promise<void> {
    await tx.idempotencyRecord.create({
      data: {
        userId: input.userId,
        key: input.idempotencyKey,
        requestHash: input.requestHash,
        resourceType,
        resourceId,
      },
    });
  }

  private requireMatchingRecord(
    existing: { resourceId: string; requestHash: string },
    requestHash: string,
  ): string {
    if (existing.requestHash !== requestHash) {
      throw new HttpError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "This idempotency key was already used for different data.",
      );
    }
    return existing.resourceId;
  }

  private personNotFound(): HttpError {
    return new HttpError(404, "PERSON_NOT_FOUND", "The person was not found.");
  }
}
