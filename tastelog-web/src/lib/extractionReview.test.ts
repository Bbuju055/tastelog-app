import { describe, it, expect } from "vitest";
import { missingRecipeSections } from "./extractionReview";

describe("minimum extraction content", () => {
  it("requires both sections and ignores blank editor rows", () => {
    expect(missingRecipeSections([], [])).toEqual(["ingredients", "instructions"]);
    expect(missingRecipeSections(["salt"], [" "])).toEqual(["instructions"]);
    expect(missingRecipeSections([" "], ["Mix."])).toEqual(["ingredients"]);
    expect(missingRecipeSections(["", "salt"], ["Mix."])).toEqual([]);
  });
});
