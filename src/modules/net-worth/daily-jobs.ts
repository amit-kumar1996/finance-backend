import type { PrismaClient } from "../../generated/prisma/client.js";
import type { Logger } from "pino";
import type { InvestmentsService } from "../investments/investments.service.js";
import type { NetWorthService } from "./net-worth.service.js";
import { todayInKolkata } from "./net-worth.service.js";

const isAfterMarketClose = (): boolean => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return hour > 23 || (hour === 23 && minute >= 45);
};

export const startDailyPortfolioJobs = (
  prisma: PrismaClient,
  netWorth: NetWorthService,
  investments: InvestmentsService,
  logger: Logger,
) => {
  const snapshotDateByUser = new Map<string, string>();
  const marketDateByUser = new Map<string, string>();
  const closingSnapshotDateByUser = new Map<string, string>();
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      const date = todayInKolkata();
      const afterClose = isAfterMarketClose();
      const users = await prisma.user.findMany({ select: { id: true } });
      for (const user of users) {
        let marketRefreshComplete = marketDateByUser.get(user.id) === date;
        if (afterClose && !marketRefreshComplete) {
          try {
            const funds = await investments.list(user.id, "MUTUAL_FUND");
            if (funds.some((fund) => Boolean(fund.symbol)))
              await investments.syncAmfi(user.id);
            marketDateByUser.set(user.id, date);
            marketRefreshComplete = true;
          } catch (error) {
            logger.warn(
              { error, userId: user.id, date },
              "Scheduled market refresh failed; the previous price remains in use",
            );
          }
        }
        const needsInitialSnapshot = snapshotDateByUser.get(user.id) !== date;
        const needsClosingSnapshot =
          afterClose &&
          marketRefreshComplete &&
          closingSnapshotDateByUser.get(user.id) !== date;
        if (needsInitialSnapshot || needsClosingSnapshot) {
          await netWorth.snapshot(user.id, date);
          snapshotDateByUser.set(user.id, date);
          if (needsClosingSnapshot) closingSnapshotDateByUser.set(user.id, date);
        }
      }
    } catch (error) {
      logger.error({ error }, "Daily portfolio job failed");
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void run(), 5 * 60 * 1000);
  timer.unref();
  void run();
  return { stop: () => clearInterval(timer), run };
};
