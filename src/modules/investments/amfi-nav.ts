export interface AmfiNavRow {
  schemeCode: string;
  schemeName: string;
  nav: string;
  date: string;
}

const monthNumber = new Map([
  ["jan", "01"],
  ["feb", "02"],
  ["mar", "03"],
  ["apr", "04"],
  ["may", "05"],
  ["jun", "06"],
  ["jul", "07"],
  ["aug", "08"],
  ["sep", "09"],
  ["oct", "10"],
  ["nov", "11"],
  ["dec", "12"],
]);

const parseDate = (value: string): string | null => {
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(value.trim());
  const month = match ? monthNumber.get(match[2]!.toLowerCase()) : undefined;
  if (!match || !month) return null;
  return `${match[3]}-${month}-${match[1]!.padStart(2, "0")}`;
};

export const parseAmfiNavFile = (contents: string): Map<string, AmfiNavRow> => {
  const result = new Map<string, AmfiNavRow>();
  let schemeNameIndex = 3;
  let navIndex: number | null = null;
  let dateIndex: number | null = null;
  for (const line of contents.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const fields = line.split(";").map((field) => field.trim());
    if (fields.length < 2) continue;
    const normalized = fields.map((field) => field.toLowerCase());
    if (normalized.some((field) => field.includes("scheme code"))) {
      schemeNameIndex = normalized.findIndex((field) => field.includes("scheme name"));
      navIndex = normalized.findIndex(
        (field) => field.includes("net asset value") || field === "nav",
      );
      dateIndex = normalized.findIndex((field) => field === "date");
      continue;
    }
    if (!/^\d{1,8}$/.test(fields[0] ?? "")) continue;
    const selectedNavIndex = navIndex ?? (fields.length >= 8 ? 6 : 4);
    const selectedDateIndex = dateIndex ?? (fields.length >= 8 ? 7 : 5);
    const code = fields[0]!;
    const nav = fields[selectedNavIndex] ?? "";
    const date = parseDate(fields[selectedDateIndex] ?? "");
    const name = fields[schemeNameIndex] ?? fields[3] ?? "";
    if (!name || !date || !/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(nav)) continue;
    result.set(code, { schemeCode: code, schemeName: name, nav, date });
  }
  return result;
};

export const fetchAmfiNavFile = async (url: string): Promise<Map<string, AmfiNavRow>> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok)
    throw new Error(`AMFI NAV download failed with HTTP ${response.status}.`);
  const contents = await response.text();
  if (contents.length > 20_000_000)
    throw new Error("AMFI NAV file exceeded the allowed size.");
  const rows = parseAmfiNavFile(contents);
  if (rows.size === 0) throw new Error("AMFI NAV file had no valid scheme rows.");
  return rows;
};
import type { MarketDataAdapter, MarketDataQuote } from "./investments.types.js";

export class AmfiNavAdapter implements MarketDataAdapter {
  readonly source = "AMFI" as const;
  constructor(private readonly url: string) {}

  async fetchPrices(): Promise<Map<string, MarketDataQuote>> {
    const rows = await fetchAmfiNavFile(this.url);
    return new Map(
      [...rows].map(([symbol, row]) => [
        symbol,
        { symbol, price: row.nav, date: row.date },
      ]),
    );
  }
}
