import { describe, expect, it, vi } from "vitest";
import type { AccountsService } from "../accounts/accounts.service.js";
import type { PeopleRepository, PersonRecord } from "./people.types.js";
import { PeopleService } from "./people.service.js";

const person: PersonRecord = {
  id: "person-b",
  name: "Alex",
  notes: null,
  createdAt: new Date("2026-11-24T00:00:00.000Z"),
  archivedAt: null,
  givenTotal: "0.00",
  receivedTotal: "0.00",
  borrowedTotal: "0.00",
  repaidTotal: "0.00",
  receivableBalance: "0.00",
  payableBalance: "0.00",
  netBalance: "0.00",
  type: "Given",
  givenOrBorrowed: "0.00",
  receivedOrRepaid: "0.00",
  receivableLedgerAccountId: "receivable-b",
  payableLedgerAccountId: "payable-b",
};

const makeService = () => {
  const repository: PeopleRepository = {
    listPeople: vi.fn(async () => [person]),
    getPerson: vi.fn(async (userId) => (userId === "user-b" ? person : null)),
    getStatement: vi.fn(async (userId) =>
      userId === "user-b" ? { person, transactions: [] } : null,
    ),
    findIdempotencyRecord: vi.fn(async () => null),
    createPerson: vi.fn(async () => person.id),
    updatePerson: vi.fn(async () => person.id),
    archivePerson: vi.fn(async () => person.id),
  };
  const accounts = {
    postPersonMovement: vi.fn(),
  } as unknown as AccountsService;
  return { service: new PeopleService(repository, accounts), repository, accounts };
};

describe("people ownership", () => {
  it("does not let user A read user B's person or statement", async () => {
    const { service } = makeService();
    await expect(service.getPerson("user-a", person.id)).rejects.toMatchObject({
      code: "PERSON_NOT_FOUND",
    });
    await expect(service.getStatement("user-a", person.id)).rejects.toMatchObject({
      code: "PERSON_NOT_FOUND",
    });
  });

  it("does not let user A update, archive, or post to user B's person", async () => {
    const { service, repository, accounts } = makeService();
    await expect(
      service.updatePerson("user-a", person.id, "update-a", { name: "Changed" }),
    ).rejects.toMatchObject({ code: "PERSON_NOT_FOUND" });
    await expect(
      service.archivePerson("user-a", person.id, "archive-a"),
    ).rejects.toMatchObject({
      code: "PERSON_NOT_FOUND",
    });
    await expect(
      service.postMovement({
        userId: "user-a",
        personId: person.id,
        idempotencyKey: "give-a",
        movement: "GIVE",
        effectiveDate: "2026-11-24",
        amount: "10.00",
        accountId: "bank-a",
      }),
    ).rejects.toMatchObject({ code: "PERSON_NOT_FOUND" });
    expect(repository.updatePerson).not.toHaveBeenCalled();
    expect(repository.archivePerson).not.toHaveBeenCalled();
    expect(accounts.postPersonMovement).not.toHaveBeenCalled();
  });
});
