import type { PrismaClient } from "../../generated/prisma/client.js";
import { decodeSyncCursor, encodeSyncCursor } from "./sync.service.js";
import type { SyncRepository } from "./sync.service.js";

export class PrismaSyncRepository implements SyncRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listTransactions(userId: string, rawCursor: string | undefined) {
    const cursor = decodeSyncCursor(rawCursor);
    const rows = await this.prisma.ledgerTransaction.findMany({
      where: {
        userId,
        ...(cursor
          ? {
              OR: [
                { createdAt: { gt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { gt: cursor.id } },
              ],
            }
          : {}),
      },
      include: {
        entries: {
          include: {
            ledgerAccount: { select: { id: true, name: true, category: true } },
          },
          orderBy: { id: "asc" },
        },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 201,
    });
    const hasMore = rows.length > 200;
    const page = hasMore ? rows.slice(0, 200) : rows;
    const last = page.at(-1);
    return {
      changes: page.map((row) => ({
        id: row.id,
        effectiveDate: row.effectiveDate.toISOString().slice(0, 10),
        description: row.description,
        source: row.source,
        reversalOfId: row.reversalOfId,
        createdAt: row.createdAt.toISOString(),
        entries: row.entries.map((entry) => ({
          accountId: entry.ledgerAccountId,
          accountName: entry.ledgerAccount.name,
          category: entry.ledgerAccount.category,
          debit: entry.debitAmount.toFixed(2),
          credit: entry.creditAmount.toFixed(2),
        })),
      })),
      cursor: last ? encodeSyncCursor(last.createdAt, last.id) : (rawCursor ?? null),
      hasMore,
    };
  }
}
