/**
 * Rational Arithmetic (BigInt)
 *
 * Exact rational number operations using BigInt.
 * No floating-point drift. All results reduced, denominator always > 0.
 */

import type { Rational } from "./types";

// --------------------
// Construction helpers
// --------------------

export function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a;
}

/** Create a normalized Rational from numerator/denominator. */
export function make(n: bigint, d: bigint = 1n): Rational {
  if (d === 0n) throw new Error("Rational: denominator cannot be zero");

  // keep denominator positive
  if (d < 0n) {
    n = -n;
    d = -d;
  }

  if (n === 0n) return { n: 0n, d: 1n };

  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}

// --------------------
// Arithmetic
// --------------------

export function mul(a: Rational, b: Rational): Rational {
  return make(a.n * b.n, a.d * b.d);
}

export function add(a: Rational, b: Rational): Rational {
  return make(a.n * b.d + b.n * a.d, a.d * b.d);
}

export function sub(a: Rational, b: Rational): Rational {
  return make(a.n * b.d - b.n * a.d, a.d * b.d);
}

// --------------------
// Comparison
// --------------------

export function cmp(a: Rational, b: Rational): -1 | 0 | 1 {
  const diff = a.n * b.d - b.n * a.d;
  if (diff < 0n) return -1;
  if (diff > 0n) return 1;
  return 0;
}

export function isOne(r: Rational): boolean {
  return r.n === 1n && r.d === 1n;
}

export function isZero(r: Rational): boolean {
  return r.n === 0n;
}

// --------------------
// Rounding
// --------------------

/**
 * Round to nearest integer using round-half-up.
 * Examples: 0.5 -> 1, 1.5 -> 2, -0.5 -> -1, -1.5 -> -2
 */
export function roundHalfUp(r: Rational): bigint {
  if (r.d === 1n) return r.n;

  const sign = r.n < 0n ? -1n : 1n;
  const absN = r.n < 0n ? -r.n : r.n;

  // floor((absN + d/2) / d) then apply sign
  const half = r.d / 2n;
  const roundedAbs = (absN + half) / r.d;

  return sign * roundedAbs;
}

// --------------------
// Display
// --------------------

export function toDisplayString(r: Rational): string {
  if (r.n === 0n) return "0";
  if (r.d === 1n) return r.n.toString();

  const sign = r.n < 0n ? "-" : "";
  const absN = r.n < 0n ? -r.n : r.n;

  const whole = absN / r.d;
  const rem = absN % r.d;

  if (rem === 0n) return `${sign}${whole}`;

  if (whole === 0n) return `${sign}${rem}/${r.d}`;

  return `${sign}${whole} ${rem}/${r.d}`;
}

// --------------------
// Presets
// --------------------

export const HALF: Rational = make(1n, 2n);
export const ONE: Rational = make(1n, 1n);
export const TWO: Rational = make(2n, 1n);
