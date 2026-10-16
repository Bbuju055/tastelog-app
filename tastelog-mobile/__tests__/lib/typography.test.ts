import { fontSize, lineHeight } from "../../theme/typography";

/**
 * Phase 15.0.2 — type scale contract.
 *
 * Locks the repaired scale shape: no sub-legible `xs` step, the mid-hierarchy
 * steps exist (17, 22), and the lineHeight ratio tokens are present. Values
 * are pinned deliberately — changing the scale is a design decision that
 * should fail a test, not slip through a refactor.
 */
describe("typography scale contract (15.0.2)", () => {
  test("xs is removed from the scale", () => {
    expect("xs" in fontSize).toBe(false);
  });

  test("scale has the repaired step values", () => {
    expect(fontSize).toEqual({
      sm: 12,
      base: 15,
      md: 17,
      lg: 19,
      title: 22,
      xl: 26,
      xxl: 34,
      hero: 42,
    });
  });

  test("no step is below the 12pt legibility floor", () => {
    for (const value of Object.values(fontSize)) {
      expect(value).toBeGreaterThanOrEqual(12);
    }
  });

  test("scale is strictly ascending", () => {
    const values = Object.values(fontSize);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThan(values[i - 1] as number);
    }
  });

  test("lineHeight ratio tokens are present", () => {
    expect(lineHeight).toEqual({
      tight: 1.2,
      normal: 1.5,
      relaxed: 1.65,
    });
  });
});
