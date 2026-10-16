import { motion } from "../../theme/motion";

/**
 * Phase 15.1.1 — motion token contract.
 *
 * Values are pinned deliberately (like the typography scale contract):
 * tuning them for feel in 15.1.2+ must show up as a reviewed diff here,
 * not drift silently.
 */
describe("motion token contract (15.1.1)", () => {
  test("durations are pinned and inside the charter bands", () => {
    expect(motion.duration).toEqual({
      fast: 120,
      base: 200,
      slow: 300,
      beat: 700,
    });
    // Charter: product transitions 150–250ms band; beats capped ~800ms.
    expect(motion.duration.base).toBeGreaterThanOrEqual(150);
    expect(motion.duration.base).toBeLessThanOrEqual(250);
    expect(motion.duration.beat).toBeLessThanOrEqual(800);
  });

  test("easing tokens are 4-point cubic-bezier tuples (pure data)", () => {
    for (const curve of Object.values(motion.easing)) {
      expect(Array.isArray(curve)).toBe(true);
      expect(curve).toHaveLength(4);
      for (const point of curve) {
        expect(typeof point).toBe("number");
      }
    }
    expect(motion.easing.out).toEqual([0.16, 1, 0.3, 1]);
    expect(motion.easing.inOut).toEqual([0.65, 0, 0.35, 1]);
  });

  test("spring configs are pure parameter objects", () => {
    expect(motion.spring.touch).toEqual({ damping: 20, stiffness: 300, mass: 1 });
    expect(motion.spring.settle).toEqual({ damping: 26, stiffness: 180, mass: 1 });
  });

  test("motion module is pure data — no animation runtime import", () => {
    // Shape-level guarantee: everything exported is plain numbers/objects.
    const flatten = (value: unknown): unknown[] =>
      typeof value === "object" && value !== null
        ? Object.values(value).flatMap(flatten)
        : [value];
    for (const leaf of flatten(motion)) {
      expect(typeof leaf).toBe("number");
    }
  });
});
