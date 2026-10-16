import { deriveScaleFactor, parseServings } from "../../../lib/ingredients/scaling";
import { ONE, make } from "../../../lib/ingredients/rational";

describe("scaling module", () => {
  describe("parseServings re-export", () => {
    it("is the same function as the direct module export", () => {
      // Sanity check: the scaling surface exposes parseServings so cook mode
      // and recipe detail can both import from one place.
      expect(parseServings("4")).toBe(4);
      expect(parseServings("Serves 6")).toBe(6);
      expect(parseServings("")).toBeNull();
    });
  });

  describe("deriveScaleFactor", () => {
    describe("valid inputs", () => {
      it("returns ONE when desired equals base", () => {
        expect(deriveScaleFactor(4, "4")).toBe(ONE);
      });

      it("returns 2/1 when doubling", () => {
        const result = deriveScaleFactor(4, "8");
        expect(result).not.toBeNull();
        expect(result).toEqual(make(2n, 1n));
      });

      it("returns 1/2 when halving", () => {
        const result = deriveScaleFactor(4, "2");
        expect(result).not.toBeNull();
        expect(result).toEqual(make(1n, 2n));
      });

      it("returns 3/2 for non-integer ratio", () => {
        const result = deriveScaleFactor(4, "6");
        expect(result).not.toBeNull();
        expect(result).toEqual(make(3n, 2n));
      });

      it("trims whitespace from desiredText", () => {
        const result = deriveScaleFactor(4, "  8  ");
        expect(result).toEqual(make(2n, 1n));
      });
    });

    describe("invalid base", () => {
      it("returns null when base is null", () => {
        expect(deriveScaleFactor(null, "4")).toBeNull();
      });

      it("returns null when base is zero", () => {
        expect(deriveScaleFactor(0, "4")).toBeNull();
      });

      it("returns null when base is negative", () => {
        expect(deriveScaleFactor(-2, "4")).toBeNull();
      });
    });

    describe("invalid desiredText", () => {
      it("returns null for empty string", () => {
        expect(deriveScaleFactor(4, "")).toBeNull();
      });

      it("returns null for whitespace only", () => {
        expect(deriveScaleFactor(4, "   ")).toBeNull();
      });

      it("returns null for non-digit characters", () => {
        expect(deriveScaleFactor(4, "4a")).toBeNull();
        expect(deriveScaleFactor(4, "four")).toBeNull();
      });

      it("returns null for decimal values", () => {
        expect(deriveScaleFactor(4, "4.5")).toBeNull();
      });

      it("returns null for negative values", () => {
        expect(deriveScaleFactor(4, "-4")).toBeNull();
      });

      it("returns null for zero", () => {
        expect(deriveScaleFactor(4, "0")).toBeNull();
      });
    });
  });
});
