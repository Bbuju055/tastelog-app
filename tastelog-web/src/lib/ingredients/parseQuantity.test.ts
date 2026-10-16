import { describe, expect, it } from "vitest";
import { parseQuantity } from "./parseQuantity";

describe("parseQuantity", () => {
  describe("integers", () => {
    it("parses single digit", () => {
      expect(parseQuantity("2")).toEqual({ n: 2n, d: 1n });
      expect(parseQuantity("0")).toEqual({ n: 0n, d: 1n });
    });

    it("parses multi-digit", () => {
      expect(parseQuantity("10")).toEqual({ n: 10n, d: 1n });
      expect(parseQuantity("123")).toEqual({ n: 123n, d: 1n });
    });

    it("trims whitespace", () => {
      expect(parseQuantity("  2  ")).toEqual({ n: 2n, d: 1n });
    });
  });

  describe("decimals", () => {
    it("parses simple decimals", () => {
      expect(parseQuantity("1.5")).toEqual({ n: 3n, d: 2n });
      expect(parseQuantity("0.5")).toEqual({ n: 1n, d: 2n });
      expect(parseQuantity("2.0")).toEqual({ n: 2n, d: 1n });
    });

    it("parses decimals with multiple places", () => {
      expect(parseQuantity("0.75")).toEqual({ n: 3n, d: 4n });
      expect(parseQuantity("0.25")).toEqual({ n: 1n, d: 4n });
      expect(parseQuantity("1.125")).toEqual({ n: 9n, d: 8n });
    });

    it("rejects malformed decimals", () => {
      expect(parseQuantity(".5")).toBeNull();
      expect(parseQuantity("1.")).toBeNull();
      expect(parseQuantity("1..5")).toBeNull();
    });
  });

  describe("fractions", () => {
    it("parses simple fractions", () => {
      expect(parseQuantity("1/2")).toEqual({ n: 1n, d: 2n });
      expect(parseQuantity("3/4")).toEqual({ n: 3n, d: 4n });
      expect(parseQuantity("1/8")).toEqual({ n: 1n, d: 8n });
    });

    it("parses improper fractions", () => {
      expect(parseQuantity("3/2")).toEqual({ n: 3n, d: 2n });
      expect(parseQuantity("5/4")).toEqual({ n: 5n, d: 4n });
    });

    it("reduces fractions", () => {
      expect(parseQuantity("2/4")).toEqual({ n: 1n, d: 2n });
      expect(parseQuantity("6/8")).toEqual({ n: 3n, d: 4n });
    });

    it("rejects zero denominator", () => {
      expect(parseQuantity("1/0")).toBeNull();
    });
  });

  describe("mixed numbers", () => {
    it("parses mixed numbers", () => {
      expect(parseQuantity("1 1/2")).toEqual({ n: 3n, d: 2n });
      expect(parseQuantity("2 3/4")).toEqual({ n: 11n, d: 4n });
      expect(parseQuantity("1 1/4")).toEqual({ n: 5n, d: 4n });
    });

    it("handles multiple spaces", () => {
      expect(parseQuantity("1  1/2")).toEqual({ n: 3n, d: 2n });
    });

    it("rejects improper fraction part", () => {
      expect(parseQuantity("1 5/4")).toBeNull();
      expect(parseQuantity("2 3/2")).toBeNull();
      expect(parseQuantity("1 4/4")).toBeNull();
    });

    it("rejects zero denominator", () => {
      expect(parseQuantity("1 1/0")).toBeNull();
    });
  });

  describe("unicode fractions", () => {
    it("parses single unicode fraction", () => {
      expect(parseQuantity("½")).toEqual({ n: 1n, d: 2n });
      expect(parseQuantity("¼")).toEqual({ n: 1n, d: 4n });
      expect(parseQuantity("¾")).toEqual({ n: 3n, d: 4n });
      expect(parseQuantity("⅓")).toEqual({ n: 1n, d: 3n });
      expect(parseQuantity("⅔")).toEqual({ n: 2n, d: 3n });
    });

    it("parses integer + unicode fraction", () => {
      expect(parseQuantity("1½")).toEqual({ n: 3n, d: 2n });
      expect(parseQuantity("2¼")).toEqual({ n: 9n, d: 4n });
      expect(parseQuantity("1¾")).toEqual({ n: 7n, d: 4n });
    });

    it("parses integer + space + unicode fraction", () => {
      expect(parseQuantity("1 ½")).toEqual({ n: 3n, d: 2n });
      expect(parseQuantity("2 ¼")).toEqual({ n: 9n, d: 4n });
    });

    it("rejects unicode with invalid prefix", () => {
      expect(parseQuantity("a½")).toBeNull();
      expect(parseQuantity("1.5½")).toBeNull();
    });

    it("rejects unicode with suffix", () => {
      expect(parseQuantity("½ tsp")).toBeNull();
      expect(parseQuantity("1½ cups")).toBeNull();
    });
  });

  describe("rejection cases", () => {
    it("rejects null and undefined", () => {
      expect(parseQuantity(null)).toBeNull();
      expect(parseQuantity(undefined)).toBeNull();
    });

    it("rejects empty and whitespace", () => {
      expect(parseQuantity("")).toBeNull();
      expect(parseQuantity("   ")).toBeNull();
    });

    it("rejects negative numbers", () => {
      expect(parseQuantity("-1")).toBeNull();
      expect(parseQuantity("-1/2")).toBeNull();
      expect(parseQuantity("-0.5")).toBeNull();
    });

    it("rejects ranges", () => {
      expect(parseQuantity("1-2")).toBeNull();
      expect(parseQuantity("2 to 3")).toBeNull();
      expect(parseQuantity("1 or 2")).toBeNull();
    });

    it("rejects approximations", () => {
      expect(parseQuantity("about 2")).toBeNull();
      expect(parseQuantity("~3")).toBeNull();
      expect(parseQuantity("2-ish")).toBeNull();
      expect(parseQuantity("approx 1")).toBeNull();
    });

    it("rejects text", () => {
      expect(parseQuantity("some")).toBeNull();
      expect(parseQuantity("a few")).toBeNull();
      expect(parseQuantity("pinch")).toBeNull();
      expect(parseQuantity("several")).toBeNull();
    });

    it("rejects mixed text and numbers", () => {
      expect(parseQuantity("2 cups")).toBeNull();
      expect(parseQuantity("one")).toBeNull();
      expect(parseQuantity("2x")).toBeNull();
    });
  });
});
