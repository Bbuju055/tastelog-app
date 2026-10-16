import { parseQuantity } from "../../../lib/ingredients/parseQuantity";

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
      expect(parseQuantity("\u00BD")).toEqual({ n: 1n, d: 2n });
      expect(parseQuantity("\u00BC")).toEqual({ n: 1n, d: 4n });
      expect(parseQuantity("\u00BE")).toEqual({ n: 3n, d: 4n });
      expect(parseQuantity("\u2153")).toEqual({ n: 1n, d: 3n });
      expect(parseQuantity("\u2154")).toEqual({ n: 2n, d: 3n });
    });

    it("parses integer + unicode fraction", () => {
      expect(parseQuantity("1\u00BD")).toEqual({ n: 3n, d: 2n });
      expect(parseQuantity("2\u00BC")).toEqual({ n: 9n, d: 4n });
      expect(parseQuantity("1\u00BE")).toEqual({ n: 7n, d: 4n });
    });

    it("parses integer + space + unicode fraction", () => {
      expect(parseQuantity("1 \u00BD")).toEqual({ n: 3n, d: 2n });
      expect(parseQuantity("2 \u00BC")).toEqual({ n: 9n, d: 4n });
    });

    it("rejects unicode with invalid prefix", () => {
      expect(parseQuantity("a\u00BD")).toBeNull();
      expect(parseQuantity("1.5\u00BD")).toBeNull();
    });

    it("rejects unicode with suffix", () => {
      expect(parseQuantity("\u00BD tsp")).toBeNull();
      expect(parseQuantity("1\u00BD cups")).toBeNull();
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
