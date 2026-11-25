import { randomBytes } from "node:crypto";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { Prisma } from "../../generated/prisma/client.js";
import { HttpError } from "../../lib/http-error.js";
import type {
  IdempotentPersonResource,
  PeopleRepository,
  PersonMovement,
  PersonMovementInput,
  PersonMovementRecord,
  PersonMutationInput,
  PersonRecord,
  PersonStatement,
  PersonStatementRow,
  PersonSummary,
} from "./people.types.js";

const toDateString = (date: Date): string => date.toISOString().slice(0, 10);
const movementDelta = (movement: PersonMovement, amount: Prisma.Decimal) => {
  switch (movement) {
    case "GIVE":
      return amount;
    case "RECEIVE":
      return amount.negated();
    case "BORROW":
      return amount.negated();
    case "REPAY":
      return amount;
  }
};

type PersonRow = Prisma.PersonGetPayload<Record<string, never>>;

export class PrismaPeopleRepository implements PeopleRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listPeople(userId: string): Promise<PersonSummary[]> {
    const people = await this.prisma.person.findMany({
      where: { userId, archivedAt: null },
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
    });
    return person ? this.summarize(person) : null;
  }

  async getStatement(userId: string, personId: string): Promise<PersonStatement | null> {
    const person = await this.prisma.person.findFirst({ where: { userId, id: personId } });
    if (!person) return null;
    const transactions = await this.prisma.personTransaction.findMany({
      where: { userId, personId },
      orderBy: [{ effectiveDate: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    });
    let runningNetBalance = new Prisma.Decimal(0);
    const statementRows: PersonStatementRow[] = transactions.map((transaction) => {
      const amount = transaction.amount;
      const netDelta = movementDelta(transaction.movement, amount);
      runningNetBalance = runningNetBalance.plus(netDelta);
      return {
        id: transaction.id,
        effectiveDate: toDateString(transaction.effectiveDate),
        description: transaction.note?.trim()
          ? `${transaction.movement}: ${person.name} — ${transaction.note.trim()}`
          : `${transaction.movement}: ${person.name}`,
        movement: transaction.movement,
        paymentMethod: transaction.paymentMethod,
        amount: amount.toFixed(2),
        netEffect: netDelta.gte(0) ? "INCREASED" : "DECREASED",
        runningNetBalance: runningNetBalance.toFixed(2),
        reversalOfId: null,
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

  findMovementByIdempotency(
    userId: string,
    key: string,
  ): Promise<PersonMovementRecord | null> {
    return this.prisma.personTransaction.findFirst({
      where: { userId, idempotencyKey: key },
      select: { id: true, requestHash: true },
    });
  }

  async createMovement(
    input: PersonMovementInput & { requestHash: string },
  ): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      const person = await tx.person.findFirst({
        where: { id: input.personId, userId: input.userId, archivedAt: null },
        select: { id: true },
      });
      if (!person) throw this.personNotFound();
      const transaction = await tx.personTransaction.create({
        data: {
          userId: input.userId,
          personId: input.personId,
          movement: input.movement,
          paymentMethod: input.paymentMethod,
          effectiveDate: new Date(`${input.effectiveDate}T00:00:00.000Z`),
          amount: new Prisma.Decimal(input.amount),
          note: input.note?.trim() || null,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
        },
      });
      await tx.auditLog.create({
        data: {
          userId: input.userId,
          entityType: "PERSON_TRANSACTION",
          entityId: transaction.id,
          action: "PERSON_MOVEMENT_CREATED",
          changes: {
            personId: input.personId,
            movement: input.movement,
            paymentMethod: input.paymentMethod,
            effectiveDate: input.effectiveDate,
            amount: input.amount,
            note: input.note?.trim() || null,
          },
        },
      });
      return transaction.id;
    });
  }

  createPerson(input: PersonMutationInput): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.idempotencyRecord.findFirst({
        where: { userId: input.userId, key: input.idempotencyKey },
      });
      if (existing) return this.requireMatchingRecord(existing, input.requestHash);
      const person = await tx.person.create({
        data: {
          id: randomBytes(12).toString("base64url"),
          userId: input.userId,
          name: input.name,
          notes: input.notes,
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
        const transactions = await tx.personTransaction.findMany({
          where: { userId: input.userId, personId: person.id },
          select: { movement: true, amount: true },
        });
        const balances = transactions.reduce(
          (total, transaction) => {
            if (transaction.movement === "GIVE") {
              total.receivable = total.receivable.plus(transaction.amount);
            } else if (transaction.movement === "RECEIVE") {
              total.receivable = total.receivable.minus(transaction.amount);
            } else if (transaction.movement === "BORROW") {
              total.payable = total.payable.plus(transaction.amount);
            } else {
              total.payable = total.payable.minus(transaction.amount);
            }
            return total;
          },
          { receivable: new Prisma.Decimal(0), payable: new Prisma.Decimal(0) },
        );
        if (!balances.receivable.isZero() || !balances.payable.isZero()) {
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

  private async summarize(person: PersonRow): Promise<PersonRecord> {
    const transactions = (await this.prisma.personTransaction.findMany({
      where: { userId: person.userId, personId: person.id },
      select: { movement: true, amount: true },
      orderBy: [{ effectiveDate: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    })) as Array<{ movement: PersonMovement; amount: Prisma.Decimal }>;
    const totals = {
      given: new Prisma.Decimal(0),
      received: new Prisma.Decimal(0),
      borrowed: new Prisma.Decimal(0),
      repaid: new Prisma.Decimal(0),
      receivable: new Prisma.Decimal(0),
      payable: new Prisma.Decimal(0),
    };
    for (const transaction of transactions) {
      switch (transaction.movement) {
        case "GIVE":
          totals.given = totals.given.plus(transaction.amount);
          totals.receivable = totals.receivable.plus(transaction.amount);
          break;
        case "RECEIVE":
          totals.received = totals.received.plus(transaction.amount);
          totals.receivable = totals.receivable.minus(transaction.amount);
          break;
        case "BORROW":
          totals.borrowed = totals.borrowed.plus(transaction.amount);
          totals.payable = totals.payable.plus(transaction.amount);
          break;
        case "REPAY":
          totals.repaid = totals.repaid.plus(transaction.amount);
          totals.payable = totals.payable.minus(transaction.amount);
          break;
      }
    }
    const net = totals.receivable.minus(totals.payable);
    const hasGiven = transactions.some(
      ({ movement }) => movement === "GIVE" || movement === "RECEIVE",
    );
    const hasBorrowed = transactions.some(
      ({ movement }) => movement === "BORROW" || movement === "REPAY",
    );
    const type = hasGiven && hasBorrowed
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
