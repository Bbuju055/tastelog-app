import { defaultListName } from "../../lib/grocery/defaultListName";

// Fixed date for deterministic tests: March 22, 2026
const MARCH_22 = new Date(2026, 2, 22);

describe("defaultListName", () => {
  test("returns date-based name when no existing lists", () => {
    expect(defaultListName([], MARCH_22)).toBe("March 22 list");
  });

  test("returns base name when no collision", () => {
    expect(defaultListName(["Weekend BBQ"], MARCH_22)).toBe("March 22 list");
  });

  test("appends (2) on first collision", () => {
    expect(defaultListName(["March 22 list"], MARCH_22)).toBe(
      "March 22 list (2)",
    );
  });

  test("appends (3) when (2) also exists", () => {
    expect(
      defaultListName(["March 22 list", "March 22 list (2)"], MARCH_22),
    ).toBe("March 22 list (3)");
  });

  test("skips gaps in suffix sequence", () => {
    // (2) exists but (3) doesn't — should use (3) not (2)
    expect(
      defaultListName(
        ["March 22 list", "March 22 list (2)", "March 22 list (3)"],
        MARCH_22,
      ),
    ).toBe("March 22 list (4)");
  });

  test("collision check is case-insensitive", () => {
    expect(defaultListName(["march 22 list"], MARCH_22)).toBe(
      "March 22 list (2)",
    );
  });

  test("collision check trims whitespace", () => {
    expect(defaultListName(["  March 22 list  "], MARCH_22)).toBe(
      "March 22 list (2)",
    );
  });

  test("uses different month/day from injected date", () => {
    const jan1 = new Date(2026, 0, 1);
    expect(defaultListName([], jan1)).toBe("January 1 list");
  });

  test("defaults to current date when no date provided", () => {
    const result = defaultListName([]);
    // Should contain a month name and "list"
    expect(result).toMatch(/^\w+ \d{1,2} list$/);
  });
});
