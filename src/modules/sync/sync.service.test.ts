import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../../lib/http-error.js";
import type { ExpensesService } from "../expenses/expenses.service.js";
import type { AccountsService } from "../accounts/accounts.service.js";
import type { PeopleService } from "../people/people.service.js";
import type { LoansService } from "../loans/loans.service.js";
import type { InvestmentsService } from "../investments/investments.service.js";
import { SyncService } from "./sync.service.js";

describe("offline sync service", () => {
  it("replays a duplicate client UUID with the same idempotency key", async () => {
    const transaction = { id: "ledger-1" };
    const seen = new Map<string, { payload: unknown; transaction: typeof transaction }>();
    const createExpense = vi.fn(
      async (_userId: string, key: string, payload: unknown) => {
        const existing = seen.get(key);
        if (existing) {
          if (JSON.stringify(existing.payload) !== JSON.stringify(payload))
            throw new HttpError(
              409,
              "IDEMPOTENCY_KEY_REUSED",
              "Payload conflicts with the original write.",
            );
          return { transaction: existing.transaction };
        }
        seen.set(key, { payload, transaction });
        return { transaction };
      },
    );
    const service = new SyncService(
      { listTransactions: vi.fn() } as never,
      { createExpense } as unknown as ExpensesService,
      {} as AccountsService,
      {} as PeopleService,
      {} as LoansService,
      {} as InvestmentsService,
    );
    const mutation = {
      clientId: "e5e4c942-7cc1-47fc-b375-dc54b82dfcb3",
      method: "POST" as const,
      path: "/expenses",
      payload: {
        effectiveDate: "2026-11-25",
        description: "Offline lunch",
        amount: "200.00",
      },
    };

    const first = await service.push("user-1", [mutation]);
    const retry = await service.push("user-1", [mutation]);

    expect(first.results[0]).toMatchObject({
      clientId: mutation.clientId,
      status: "accepted",
    });
    expect(retry.results[0]).toMatchObject({
      clientId: mutation.clientId,
      status: "accepted",
    });
    expect(createExpense).toHaveBeenCalledTimes(2);
    expect(createExpense.mock.calls[0]?.[1]).toBe(`offline:${mutation.clientId}`);
    expect(seen.size).toBe(1);
  });

  it("returns a conflict for a reused UUID with different data", async () => {
    const createExpense = vi.fn(
      async (_userId: string, key: string, payload: unknown) => {
        if (key && JSON.stringify(payload).includes("changed"))
          throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED", "Idempotency key reused.");
        return { transaction: { id: "ledger-1" } };
      },
    );
    const service = new SyncService(
      { listTransactions: vi.fn() } as never,
      { createExpense } as unknown as ExpensesService,
      {} as AccountsService,
      {} as PeopleService,
      {} as LoansService,
      {} as InvestmentsService,
    );
    const result = await service.push("user-1", [
      {
        clientId: "e5e4c942-7cc1-47fc-b375-dc54b82dfcb3",
        method: "POST",
        path: "/expenses",
        payload: {
          effectiveDate: "2026-11-25",
          description: "changed",
          amount: "200.00",
        },
      },
    ]);
    expect(result.results[0]).toMatchObject({
      status: "conflict",
      code: "IDEMPOTENCY_KEY_REUSED",
    });
  });
});
