import { createHash } from "node:crypto";
import { HttpError } from "../../lib/http-error.js";
import type { AccountsService } from "../accounts/accounts.service.js";
import type {
  IdempotentPersonResource,
  PeopleRepository,
  PersonMovementInput,
  PersonMovementResult,
  PersonRecord,
  PersonStatement,
  PersonSummary,
} from "./people.types.js";

const hashRequest = (input: unknown): string =>
  createHash("sha256").update(JSON.stringify(input)).digest("hex");

const isUniqueConstraintError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "P2002";

export class PeopleService {
  constructor(
    private readonly repository: PeopleRepository,
    private readonly accounts: AccountsService,
  ) {}

  listPeople(userId: string): Promise<PersonSummary[]> {
    return this.repository.listPeople(userId);
  }

  async getPerson(userId: string, personId: string): Promise<PersonSummary> {
    const person = await this.repository.getPerson(userId, personId);
    if (!person) throw this.personNotFound();
    return this.publicPerson(person);
  }

  async getStatement(userId: string, personId: string): Promise<PersonStatement> {
    const statement = await this.repository.getStatement(userId, personId);
    if (!statement) throw this.personNotFound();
    return statement;
  }

  async createPerson(
    userId: string,
    idempotencyKey: string,
    input: { name: string; notes?: string | null },
  ): Promise<PersonSummary> {
    const normalized = { name: input.name.trim(), notes: input.notes?.trim() || null };
    const requestHash = hashRequest({ operation: "CREATE_PERSON", ...normalized });
    const existing = await this.findIdempotent(userId, idempotencyKey, requestHash);
    if (existing) return this.personForResource(userId, existing.resourceId);
    try {
      const id = await this.repository.createPerson({
        userId,
        idempotencyKey,
        requestHash,
        ...normalized,
      });
      return this.personForResource(userId, id);
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const raced = await this.findIdempotent(userId, idempotencyKey, requestHash);
      if (raced) return this.personForResource(userId, raced.resourceId);
      throw error;
    }
  }

  async updatePerson(
    userId: string,
    personId: string,
    idempotencyKey: string,
    input: { name: string; notes?: string | null },
  ): Promise<PersonSummary> {
    const normalized = { name: input.name.trim(), notes: input.notes?.trim() || null };
    const requestHash = hashRequest({
      operation: "UPDATE_PERSON",
      personId,
      ...normalized,
    });
    const existing = await this.findIdempotent(userId, idempotencyKey, requestHash);
    if (existing) return this.personForResource(userId, existing.resourceId);
    if (!(await this.repository.getPerson(userId, personId))) throw this.personNotFound();
    try {
      const id = await this.repository.updatePerson({
        userId,
        personId,
        idempotencyKey,
        requestHash,
        ...normalized,
      });
      return this.personForResource(userId, id);
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const raced = await this.findIdempotent(userId, idempotencyKey, requestHash);
      if (raced) return this.personForResource(userId, raced.resourceId);
      throw error;
    }
  }

  async archivePerson(
    userId: string,
    personId: string,
    idempotencyKey: string,
  ): Promise<{ id: string; archived: true }> {
    const requestHash = hashRequest({ operation: "ARCHIVE_PERSON", personId });
    const existing = await this.findIdempotent(userId, idempotencyKey, requestHash);
    if (existing) return { id: existing.resourceId, archived: true };
    if (!(await this.repository.getPerson(userId, personId))) throw this.personNotFound();
    try {
      const id = await this.repository.archivePerson({
        userId,
        personId,
        idempotencyKey,
        requestHash,
      });
      return { id, archived: true };
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const raced = await this.findIdempotent(userId, idempotencyKey, requestHash);
      if (raced) return { id: raced.resourceId, archived: true };
      throw error;
    }
  }

  async postMovement(input: PersonMovementInput): Promise<PersonMovementResult> {
    const person = await this.repository.getPerson(input.userId, input.personId, true);
    if (!person) throw this.personNotFound();
    const personLedgerAccountId =
      input.movement === "GIVE" || input.movement === "RECEIVE"
        ? person.receivableLedgerAccountId
        : person.payableLedgerAccountId;
    const description = input.note?.trim()
      ? `${input.movement}: ${person.name} — ${input.note.trim()}`
      : `${input.movement}: ${person.name}`;
    const transaction = await this.accounts.postPersonMovement(
      input.userId,
      input.idempotencyKey,
      {
        movement: input.movement,
        personId: input.personId,
        personLedgerAccountId,
        accountId: input.accountId,
        effectiveDate: input.effectiveDate,
        amount: input.amount,
        description,
      },
    );
    const updatedPerson = await this.repository.getPerson(input.userId, person.id, true);
    if (!updatedPerson) throw this.personNotFound();
    return { person: this.publicPerson(updatedPerson), transaction };
  }

  private async findIdempotent(
    userId: string,
    key: string,
    requestHash: string,
  ): Promise<IdempotentPersonResource | null> {
    const existing = await this.repository.findIdempotencyRecord(userId, key);
    if (existing && existing.requestHash !== requestHash) {
      throw new HttpError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "This idempotency key was already used for different data.",
      );
    }
    return existing;
  }

  private async personForResource(userId: string, id: string): Promise<PersonSummary> {
    const person = await this.repository.getPerson(userId, id, true);
    if (!person) throw this.personNotFound();
    return this.publicPerson(person);
  }

  private publicPerson(person: PersonRecord): PersonSummary {
    const {
      receivableLedgerAccountId: _receivableLedgerAccountId,
      payableLedgerAccountId: _payableLedgerAccountId,
      archivedAt: _archivedAt,
      ...summary
    } = person;
    return summary;
  }

  private personNotFound(): HttpError {
    return new HttpError(404, "PERSON_NOT_FOUND", "The person was not found.");
  }
}
