import { describe, expect, it } from "vitest";
import {
  getMonthBounds,
  getPreviousDate,
  getPreviousMonthBounds,
} from "./prisma-expenses.repository.js";

describe("expense period boundaries", () => {
  it("handles leap day and month-end date transitions", () => {
    expect(getPreviousDate("2024-03-01")).toBe("2024-02-29");
    expect(getPreviousDate("2024-03-31")).toBe("2024-03-30");
    expect(getPreviousDate("2024-01-01")).toBe("2023-12-31");
  });

  it("uses the correct current and previous month lengths across year boundaries", () => {
    expect(getMonthBounds("2024-02")).toEqual({ from: "2024-02-01", to: "2024-02-29" });
    expect(getPreviousMonthBounds("2024-03")).toEqual({
      from: "2024-02-01",
      to: "2024-02-29",
    });
    expect(getPreviousMonthBounds("2024-01")).toEqual({
      from: "2023-12-01",
      to: "2023-12-31",
    });
  });
});
