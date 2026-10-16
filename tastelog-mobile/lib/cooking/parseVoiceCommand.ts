/**
 * Voice Command Parser
 *
 * Pure mapping from a speech transcript to a typed VoiceCommand.
 * Foundation for Phase 9.C Cooking Mode voice control. Spec:
 * docs/phase9c-voice-commands.md §4.1, §4.2, §5.2.
 *
 * Grammar (locked):
 *   "next"   | "forward"   -> "next"
 *   "back"   | "previous"  -> "back"
 *   "repeat" | "again"     -> "repeat"
 *
 * Matching rules (locked):
 * - Lowercase normalize.
 * - Tokenize on non-alphanumeric boundaries (same convention as
 *   matchIngredientsToStep — robust word-boundary semantics across
 *   punctuation that \b regex doesn't give cleanly).
 * - Exact token equality only. No stemming, no prefix matching,
 *   no fuzzy matching. Subsumes the locked partial-word edges:
 *     "backward"   -> null  (must NOT match "back")
 *     "previously" -> null  (must NOT match "previous")
 *     "repeated"   -> null  (must NOT match "repeat")
 *     "unexpected" -> null  (must NOT match "next")
 *     "forwarded"  -> null  (must NOT match "forward")
 *     "against"    -> null  (must NOT match "again")
 * - Last-match-wins. Scans tokens left-to-right and returns the
 *   rightmost matching command. Handles "go back" cleanly and lets
 *   a corrective "next back" land on "back".
 * - Empty / whitespace / non-Latin (no [a-z0-9] tokens) -> null.
 *
 * Debounce of duplicate utterances, transition-lock gating, and
 * nav-bounds checks live in the consuming hook (later slice). This
 * module is parsing-only and has zero React / Expo / platform
 * imports.
 */

export type VoiceCommand = "next" | "back" | "repeat" | null;

const TOKEN_SPLIT = /[^a-z0-9]+/;

const TRIGGER_TO_COMMAND = new Map<string, Exclude<VoiceCommand, null>>([
  ["next", "next"],
  ["forward", "next"],
  ["back", "back"],
  ["previous", "back"],
  ["repeat", "repeat"],
  ["again", "repeat"],
]);

export function parseVoiceCommand(transcript: string): VoiceCommand {
  if (transcript.length === 0) return null;
  const tokens = transcript
    .toLowerCase()
    .split(TOKEN_SPLIT)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return null;

  let last: VoiceCommand = null;
  for (const token of tokens) {
    const command = TRIGGER_TO_COMMAND.get(token);
    if (command !== undefined) {
      last = command;
    }
  }
  return last;
}
