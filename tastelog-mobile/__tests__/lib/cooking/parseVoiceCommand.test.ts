import type { VoiceCommand } from "../../../lib/cooking/parseVoiceCommand";
import { parseVoiceCommand } from "../../../lib/cooking/parseVoiceCommand";

describe("parseVoiceCommand", () => {
  describe("trigger word coverage", () => {
    it("maps 'next' to next", () => {
      expect(parseVoiceCommand("next")).toBe("next");
    });
    it("maps 'forward' to next", () => {
      expect(parseVoiceCommand("forward")).toBe("next");
    });
    it("maps 'back' to back", () => {
      expect(parseVoiceCommand("back")).toBe("back");
    });
    it("maps 'previous' to back", () => {
      expect(parseVoiceCommand("previous")).toBe("back");
    });
    it("maps 'repeat' to repeat", () => {
      expect(parseVoiceCommand("repeat")).toBe("repeat");
    });
    it("maps 'again' to repeat", () => {
      expect(parseVoiceCommand("again")).toBe("repeat");
    });
  });

  describe("case insensitivity", () => {
    it("uppercase 'NEXT' maps to next", () => {
      expect(parseVoiceCommand("NEXT")).toBe("next");
    });
    it("mixed-case 'Repeat' maps to repeat", () => {
      expect(parseVoiceCommand("Repeat")).toBe("repeat");
    });
    it("mixed-case 'BaCk' maps to back", () => {
      expect(parseVoiceCommand("BaCk")).toBe("back");
    });
  });

  describe("noise-word tolerance", () => {
    it("ignores leading filler: 'please go next'", () => {
      expect(parseVoiceCommand("please go next")).toBe("next");
    });
    it("ignores trailing filler: 'can you repeat that'", () => {
      expect(parseVoiceCommand("can you repeat that")).toBe("repeat");
    });
    it("ignores both ends: 'okay so go back please'", () => {
      expect(parseVoiceCommand("okay so go back please")).toBe("back");
    });
  });

  describe("last-match-wins", () => {
    it("'back and forth to the next' -> next", () => {
      expect(parseVoiceCommand("back and forth to the next")).toBe("next");
    });
    it("'next back' -> back", () => {
      expect(parseVoiceCommand("next back")).toBe("back");
    });
    it("'again next repeat' -> repeat", () => {
      expect(parseVoiceCommand("again next repeat")).toBe("repeat");
    });
    it("repeated same trigger 'next next' -> next (debounce is a hook-layer concern)", () => {
      expect(parseVoiceCommand("next next")).toBe("next");
    });
  });

  describe("word boundaries — partial-word collisions must NOT match", () => {
    it("'backward' -> null (locked edge)", () => {
      expect(parseVoiceCommand("backward")).toBeNull();
    });
    it("'backwards' -> null", () => {
      expect(parseVoiceCommand("backwards")).toBeNull();
    });
    it("'previously' -> null", () => {
      expect(parseVoiceCommand("previously")).toBeNull();
    });
    it("'repeated' -> null", () => {
      expect(parseVoiceCommand("repeated")).toBeNull();
    });
    it("'unexpected' -> null (contains 'next' as substring)", () => {
      expect(parseVoiceCommand("unexpected")).toBeNull();
    });
    it("'undertake' -> null", () => {
      expect(parseVoiceCommand("undertake")).toBeNull();
    });
    it("'forwarded' -> null (substring of 'forward' does not count)", () => {
      expect(parseVoiceCommand("forwarded")).toBeNull();
    });
    it("'against' -> null (contains 'again' as substring)", () => {
      expect(parseVoiceCommand("against")).toBeNull();
    });
  });

  describe("punctuation and separator tolerance", () => {
    it("'next!' -> next", () => {
      expect(parseVoiceCommand("next!")).toBe("next");
    });
    it("'go back.' -> back", () => {
      expect(parseVoiceCommand("go back.")).toBe("back");
    });
    it("'next, please' -> next", () => {
      expect(parseVoiceCommand("next, please")).toBe("next");
    });
    it("hyphenated 'step-by-step next' -> next", () => {
      expect(parseVoiceCommand("step-by-step next")).toBe("next");
    });
    it("apostrophe 'let's go back' -> back", () => {
      expect(parseVoiceCommand("let's go back")).toBe("back");
    });
  });

  describe("empty / whitespace input", () => {
    it("empty string -> null", () => {
      expect(parseVoiceCommand("")).toBeNull();
    });
    it("single space -> null", () => {
      expect(parseVoiceCommand(" ")).toBeNull();
    });
    it("mixed whitespace -> null", () => {
      expect(parseVoiceCommand("   \t\n  ")).toBeNull();
    });
  });

  describe("non-trigger transcripts", () => {
    it("conversational noise 'how long should I stir' -> null", () => {
      expect(parseVoiceCommand("how long should I stir")).toBeNull();
    });
    it("kitchen ambient 'timer' -> null", () => {
      expect(parseVoiceCommand("timer")).toBeNull();
    });
    it("non-English Spanish 'siguiente' -> null", () => {
      expect(parseVoiceCommand("siguiente")).toBeNull();
    });
    it("non-Latin script with no [a-z0-9] tokens -> null", () => {
      expect(parseVoiceCommand("次")).toBeNull();
    });
  });

  describe("return-type contract", () => {
    it("only ever returns one of the four documented values", () => {
      const valid: ReadonlyArray<VoiceCommand> = [
        "next",
        "back",
        "repeat",
        null,
      ];
      const samples = [
        "next",
        "back",
        "repeat",
        "forward",
        "previous",
        "again",
        "",
        "blah",
        "backward",
        "let's go back please",
      ];
      for (const transcript of samples) {
        expect(valid).toContain(parseVoiceCommand(transcript));
      }
    });
  });
});
