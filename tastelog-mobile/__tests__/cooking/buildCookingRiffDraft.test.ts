import { buildCookingRiffDraft } from "../../lib/cooking/buildCookingRiffDraft";
import type { StepResponse } from "../../lib/api/schemas";

function makeStep(overrides: Partial<StepResponse> = {}): StepResponse {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    recipe_id: "00000000-0000-0000-0000-000000000002",
    position: 3,
    instruction: "Sauté the onions until translucent.",
    ...overrides,
  };
}

describe("buildCookingRiffDraft", () => {
  test("mentions the 1-based step number and embeds the instruction", () => {
    expect(buildCookingRiffDraft(makeStep())).toBe(
      "I'm on step 3 of this recipe: Sauté the onions until translucent. — can you help with a substitution, timing, or troubleshooting question?",
    );
  });

  test("uses position verbatim (no index math)", () => {
    expect(buildCookingRiffDraft(makeStep({ position: 1 }))).toContain(
      "step 1 of this recipe",
    );
  });

  test("falls back to a step-only ask when instruction is empty/whitespace", () => {
    const out = buildCookingRiffDraft(
      makeStep({ position: 2, instruction: "   " }),
    );
    expect(out).toBe(
      "I'm on step 2 of this recipe — can you help with a substitution, timing, or troubleshooting question?",
    );
    expect(out).not.toContain(":  ");
  });

  test("falls back when instruction is missing at runtime (non-string)", () => {
    const out = buildCookingRiffDraft(
      makeStep({ instruction: undefined as unknown as string }),
    );
    expect(out).toBe(
      "I'm on step 3 of this recipe — can you help with a substitution, timing, or troubleshooting question?",
    );
  });

  test("preserves quotes and punctuation in the instruction verbatim", () => {
    const out = buildCookingRiffDraft(
      makeStep({ instruction: 'Add the "00" flour, then rest 20 min.' }),
    );
    expect(out).toContain('Add the "00" flour, then rest 20 min.');
  });

  test("handles very long instruction text without truncation", () => {
    const long = "Stir continuously. ".repeat(200).trim();
    const out = buildCookingRiffDraft(makeStep({ instruction: long }));
    expect(out).toContain(long);
    expect(out.endsWith("troubleshooting question?")).toBe(true);
  });

  test("is deterministic for identical input", () => {
    const step = makeStep();
    expect(buildCookingRiffDraft(step)).toBe(buildCookingRiffDraft(step));
  });
});
