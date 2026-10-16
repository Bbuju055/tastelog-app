import type { StepResponse } from "../api/schemas";

/**
 * Cooking Mode Riff — build the deterministic prefilled draft message for a
 * Riff launched from Cooking Mode (cross-screen-riff-decisions.md §2.1).
 *
 * Step-aware: names the current step (1-based `position`) and embeds the
 * step instruction as context so Riff — which is recipe-anchored but not
 * step-aware — can answer substitution / timing / troubleshooting asks for
 * the step the user is actually on. The user edits this before Send
 * (no auto-send). Instruction text is preserved verbatim (no truncation,
 * no sanitization) — it is editable text, not a structured payload.
 */
export function buildCookingRiffDraft(step: StepResponse): string {
  const instruction =
    typeof step.instruction === "string" ? step.instruction.trim() : "";
  if (instruction === "") {
    return `I'm on step ${step.position} of this recipe — can you help with a substitution, timing, or troubleshooting question?`;
  }
  return `I'm on step ${step.position} of this recipe: ${instruction} — can you help with a substitution, timing, or troubleshooting question?`;
}
