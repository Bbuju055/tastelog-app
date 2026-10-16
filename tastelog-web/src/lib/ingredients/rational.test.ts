import { describe, expect, it } from "vitest";
import {
  gcd,
  make,
  mul,
  add,
  sub,
  cmp,
  isOne,
  isZero,
  roundHalfUp,
  toDisplayString,
  HALF,
  ONE,
  TWO,
} from "./rational";

describe("gcd", () => {
  it("returns gcd of positive integers", () => {
    expect(gcd(12n, 8n)).toBe(4n);
    expect(gcd(15n, 5n)).toBe(5n);
    expect(gcd(7n, 3n)).toBe(1n);
  });

  it("handles zero", () => {
    expect(gcd(0n, 5n)).toBe(5n);
    expect(gcd(5n, 0n)).toBe(5n);
  });

  it("handles negative inputs", () => {
    expect(gcd(-12n, 8n)).toBe(4n);
    expect(gcd(12n, -8n)).toBe(4n);
    expect(gcd(-12n, -8n)).toBe(4n);
  });
});

describe("make", () => {
  it("creates reduced rational", () => {
    expect(make(4n, 8n)).toEqual({ n: 1n, d: 2n });
    expect(make(6n, 9n)).toEqual({ n: 2n, d: 3n });
  });

  it("handles whole numbers", () => {
    expect(make(5n)).toEqual({ n: 5n, d: 1n });
    expect(make(5n, 1n)).toEqual({ n: 5n, d: 1n });
  });

  it("normalizes zero to 0/1", () => {
    expect(make(0n, 5n)).toEqual({ n: 0n, d: 1n });
    expect(make(0n, 100n)).toEqual({ n: 0n, d: 1n });
    expect(make(0n, -5n)).toEqual({ n: 0n, d: 1n });
  });

  it("keeps denominator positive", () => {
    expect(make(3n, -4n)).toEqual({ n: -3n, d: 4n });
    expect(make(-3n, -4n)).toEqual({ n: 3n, d: 4n });
  });

  it("throws on zero denominator", () => {
    expect(() => make(1n, 0n)).toThrow("denominator cannot be zero");
  });
});

describe("mul", () => {
  it("multiplies two rationals", () => {
    expect(mul(make(1n, 2n), make(2n, 3n))).toEqual({ n: 1n, d: 3n });
    expect(mul(make(3n, 4n), make(2n, 1n))).toEqual({ n: 3n, d: 2n });
  });

  it("handles multiplication by one", () => {
    expect(mul(make(5n, 7n), ONE)).toEqual({ n: 5n, d: 7n });
  });

  it("handles multiplication by zero", () => {
    expect(mul(make(5n, 7n), make(0n, 1n))).toEqual({ n: 0n, d: 1n });
  });
});

describe("add", () => {
  it("adds two rationals", () => {
    expect(add(make(1n, 4n), make(1n, 4n))).toEqual({ n: 1n, d: 2n });
    expect(add(make(1n, 2n), make(1n, 3n))).toEqual({ n: 5n, d: 6n });
  });

  it("handles addition with zero", () => {
    expect(add(make(3n, 4n), make(0n, 1n))).toEqual({ n: 3n, d: 4n });
  });
});

describe("sub", () => {
  it("subtracts two rationals", () => {
    expect(sub(make(3n, 4n), make(1n, 4n))).toEqual({ n: 1n, d: 2n });
    expect(sub(make(1n, 2n), make(1n, 3n))).toEqual({ n: 1n, d: 6n });
  });

  it("can produce negative result", () => {
    expect(sub(make(1n, 4n), make(1n, 2n))).toEqual({ n: -1n, d: 4n });
  });
});

describe("cmp", () => {
  it("returns -1 when a < b", () => {
    expect(cmp(make(1n, 3n), make(1n, 2n))).toBe(-1);
    expect(cmp(make(2n, 5n), make(3n, 5n))).toBe(-1);
  });

  it("returns 0 when equal", () => {
    expect(cmp(make(1n, 2n), make(2n, 4n))).toBe(0);
    expect(cmp(make(3n, 1n), make(3n, 1n))).toBe(0);
  });

  it("returns 1 when a > b", () => {
    expect(cmp(make(1n, 2n), make(1n, 3n))).toBe(1);
    expect(cmp(make(5n, 1n), make(4n, 1n))).toBe(1);
  });
});

describe("isOne", () => {
  it("returns true for 1/1", () => {
    expect(isOne(ONE)).toBe(true);
    expect(isOne(make(1n, 1n))).toBe(true);
    expect(isOne(make(2n, 2n))).toBe(true); // 2/2 reduces to 1/1
  });

  it("returns false for other values", () => {
    expect(isOne(make(1n, 2n))).toBe(false);
    expect(isOne(make(2n, 1n))).toBe(false);
    expect(isOne(make(0n, 1n))).toBe(false);
  });
});

describe("isZero", () => {
  it("returns true for zero", () => {
    expect(isZero(make(0n, 1n))).toBe(true);
    expect(isZero(make(0n, 5n))).toBe(true);
  });

  it("returns false for non-zero", () => {
    expect(isZero(make(1n, 1n))).toBe(false);
    expect(isZero(make(-1n, 2n))).toBe(false);
  });
});

describe("roundHalfUp", () => {
  it("rounds .5 up", () => {
    expect(roundHalfUp(make(1n, 2n))).toBe(1n); // 0.5 -> 1
    expect(roundHalfUp(make(3n, 2n))).toBe(2n); // 1.5 -> 2
    expect(roundHalfUp(make(5n, 2n))).toBe(3n); // 2.5 -> 3
  });

  it("rounds down when below .5", () => {
    expect(roundHalfUp(make(1n, 3n))).toBe(0n); // 0.33 -> 0
    expect(roundHalfUp(make(4n, 3n))).toBe(1n); // 1.33 -> 1
    expect(roundHalfUp(make(7n, 5n))).toBe(1n); // 1.4 -> 1
  });

  it("rounds up when above .5", () => {
    expect(roundHalfUp(make(2n, 3n))).toBe(1n); // 0.67 -> 1
    expect(roundHalfUp(make(5n, 3n))).toBe(2n); // 1.67 -> 2
    expect(roundHalfUp(make(9n, 5n))).toBe(2n); // 1.8 -> 2
  });

  it("returns whole number unchanged", () => {
    expect(roundHalfUp(make(3n, 1n))).toBe(3n);
    expect(roundHalfUp(make(0n, 1n))).toBe(0n);
  });

  it("handles negative values", () => {
    expect(roundHalfUp(make(-1n, 2n))).toBe(-1n); // -0.5 -> -1
    expect(roundHalfUp(make(-3n, 2n))).toBe(-2n); // -1.5 -> -2
    expect(roundHalfUp(make(-1n, 3n))).toBe(0n); // -0.33 -> 0
  });
});

describe("toDisplayString", () => {
  it("displays whole numbers", () => {
    expect(toDisplayString(make(3n, 1n))).toBe("3");
    expect(toDisplayString(make(0n, 1n))).toBe("0");
    expect(toDisplayString(make(10n, 1n))).toBe("10");
  });

  it("displays proper fractions", () => {
    expect(toDisplayString(make(1n, 2n))).toBe("1/2");
    expect(toDisplayString(make(3n, 4n))).toBe("3/4");
    expect(toDisplayString(make(1n, 8n))).toBe("1/8");
  });

  it("displays mixed numbers", () => {
    expect(toDisplayString(make(3n, 2n))).toBe("1 1/2");
    expect(toDisplayString(make(5n, 4n))).toBe("1 1/4");
    expect(toDisplayString(make(7n, 3n))).toBe("2 1/3");
  });

  it("reduces before display", () => {
    expect(toDisplayString(make(4n, 2n))).toBe("2");
    expect(toDisplayString(make(6n, 4n))).toBe("1 1/2");
  });

  it("handles negative values", () => {
    expect(toDisplayString(make(-3n, 1n))).toBe("-3");
    expect(toDisplayString(make(-1n, 2n))).toBe("-1/2");
    expect(toDisplayString(make(-3n, 2n))).toBe("-1 1/2");
  });
});

describe("presets", () => {
  it("HALF is 1/2", () => {
    expect(HALF).toEqual({ n: 1n, d: 2n });
  });

  it("ONE is 1/1", () => {
    expect(ONE).toEqual({ n: 1n, d: 1n });
  });

  it("TWO is 2/1", () => {
    expect(TWO).toEqual({ n: 2n, d: 1n });
  });
});
