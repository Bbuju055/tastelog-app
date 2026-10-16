import { parseServings } from "../../../lib/ingredients/parseServings";

describe("parseServings", () => {
  describe("bare numbers", () => {
    it("parses single digit", () => {
      expect(parseServings("4")).toBe(4);
    });

    it("parses multi-digit", () => {
      expect(parseServings("12")).toBe(12);
      expect(parseServings("100")).toBe(100);
    });

    it("trims whitespace", () => {
      expect(parseServings("  4  ")).toBe(4);
    });

    it("rejects zero", () => {
      expect(parseServings("0")).toBeNull();
    });
  });

  describe("number + servings", () => {
    it("parses 'N servings'", () => {
      expect(parseServings("4 servings")).toBe(4);
      expect(parseServings("8 servings")).toBe(8);
    });

    it("parses 'N serving' (singular)", () => {
      expect(parseServings("1 serving")).toBe(1);
    });

    it("is case-insensitive", () => {
      expect(parseServings("4 Servings")).toBe(4);
      expect(parseServings("4 SERVINGS")).toBe(4);
    });
  });

  describe("serves/makes + number", () => {
    it("parses 'Serves N'", () => {
      expect(parseServings("Serves 6")).toBe(6);
      expect(parseServings("serves 4")).toBe(4);
    });

    it("parses 'Makes N'", () => {
      expect(parseServings("Makes 12")).toBe(12);
      expect(parseServings("makes 8")).toBe(8);
    });

    it("is case-insensitive", () => {
      expect(parseServings("SERVES 6")).toBe(6);
      expect(parseServings("MAKES 12")).toBe(12);
    });
  });

  describe("rejection cases", () => {
    it("rejects null and undefined", () => {
      expect(parseServings(null)).toBeNull();
      expect(parseServings(undefined)).toBeNull();
    });

    it("rejects empty and whitespace", () => {
      expect(parseServings("")).toBeNull();
      expect(parseServings("   ")).toBeNull();
    });

    it("rejects ranges", () => {
      expect(parseServings("2-3")).toBeNull();
      expect(parseServings("4-6 servings")).toBeNull();
      expect(parseServings("Serves 4-6")).toBeNull();
    });

    it("rejects approximations", () => {
      expect(parseServings("about 4")).toBeNull();
      expect(parseServings("~6")).toBeNull();
      expect(parseServings("approximately 8")).toBeNull();
    });

    it("rejects unrecognized words", () => {
      expect(parseServings("6 portions")).toBeNull();
      expect(parseServings("6 people")).toBeNull();
      expect(parseServings("yields 4")).toBeNull();
    });

    it("rejects freeform text", () => {
      expect(parseServings("a large batch")).toBeNull();
      expect(parseServings("enough for a family")).toBeNull();
    });

    it("rejects decimals", () => {
      expect(parseServings("4.5")).toBeNull();
      expect(parseServings("4.5 servings")).toBeNull();
    });
  });
});
