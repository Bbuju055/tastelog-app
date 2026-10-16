import React from "react";
import { Alert } from "react-native";
import { fireEvent, screen } from "@testing-library/react-native";
import { renderWithTheme } from "../test-utils";

// Phase 13.9 Slice H — RiffChat is now controller-injected. Tests construct
// a literal controller (shape: RiffSessionController) and pass it via the
// `session` prop. No hook mock needed — RiffChat no longer calls
// useRiffSession internally; the recipe / draft routes own the hook.
//
// The makeController(...) helper preserves the prior setHookState(...)
// signature: overrides flow through, sendMessage / saveRecipe / cancel
// default to fresh jest.fn() per call so tests assert on call args.

import { RiffChat } from "../../components/RiffChat";
import { ApiError } from "../../lib/errors";
import type { RiffSessionController } from "../../lib/hooks/useRiffSession";

function makeController(
  overrides: Partial<RiffSessionController> = {},
): RiffSessionController {
  const send =
    (overrides.sendMessage as jest.Mock | undefined) ?? jest.fn();
  const save =
    (overrides.saveRecipe as jest.Mock | undefined) ?? jest.fn();
  const cancel =
    (overrides.cancel as jest.Mock | undefined) ?? jest.fn();
  return {
    messages: overrides.messages ?? [],
    sessionId: overrides.sessionId ?? null,
    sendMessage: send,
    isLoading: overrides.isLoading ?? false,
    isStreaming: overrides.isStreaming ?? false,
    cancel,
    currentPartialAssistantMessage:
      overrides.currentPartialAssistantMessage ?? null,
    streamError: overrides.streamError ?? null,
    error: overrides.error ?? null,
    savedMessageIds: overrides.savedMessageIds ?? new Set(),
    saveRecipe: save,
    isSaving: overrides.isSaving ?? false,
    saveError: overrides.saveError ?? null,
  };
}

describe("RiffChat", () => {
  it("renders the input and send button", () => {
    const session = makeController();
    renderWithTheme(<RiffChat session={session} />);

    expect(screen.getByLabelText("Riff message")).toBeTruthy();
    expect(screen.getByText("Send")).toBeTruthy();
  });

  it("does not dispatch send when input is empty after trim", () => {
    const session = makeController();
    renderWithTheme(<RiffChat session={session} />);

    const input = screen.getByLabelText("Riff message");
    fireEvent.changeText(input, "   \n\t  ");
    fireEvent.press(screen.getByText("Send"));

    expect(session.sendMessage).not.toHaveBeenCalled();
  });

  it("does not dispatch send while loading", () => {
    const session = makeController({ isLoading: true });
    renderWithTheme(<RiffChat session={session} />);

    // In loading state, Send swaps its label to "…". Query via
    // accessibilityRole; the disabled prop guarantees onPress is never invoked.
    fireEvent.press(screen.getByRole("button"));
    expect(session.sendMessage).not.toHaveBeenCalled();
  });

  it("dispatches the trimmed message when send is pressed", () => {
    const session = makeController();
    renderWithTheme(<RiffChat session={session} />);

    const input = screen.getByLabelText("Riff message");
    fireEvent.changeText(input, "  Make it dairy-free  ");
    fireEvent.press(screen.getByText("Send"));

    expect(session.sendMessage).toHaveBeenCalledWith("Make it dairy-free");
  });

  it("clears the input on Send", () => {
    const session = makeController();
    renderWithTheme(<RiffChat session={session} />);

    const input = screen.getByLabelText("Riff message");
    fireEvent.changeText(input, "test message");
    expect(input.props.value).toBe("test message");

    fireEvent.press(screen.getByText("Send"));

    expect(session.sendMessage).toHaveBeenCalledWith("test message");
    expect(screen.getByLabelText("Riff message").props.value).toBe("");
  });

  it("renders an inline error message when the mutation fails", () => {
    const session = makeController({
      error: { message: "network down" } as unknown as RiffSessionController["error"],
    });
    renderWithTheme(<RiffChat session={session} />);

    expect(
      screen.getByText(
        "Couldn’t reach the assistant. Try again in a moment.",
      ),
    ).toBeTruthy();
  });

  it("renders the daily-limit copy for an ApiError with status 429 (Issue 2 C10)", () => {
    const session = makeController({
      error: new ApiError({
        message: "Daily riff limit reached (25 turns).",
        kind: "http",
        status: 429,
      }),
    });
    renderWithTheme(<RiffChat session={session} />);

    expect(
      screen.getByText("Daily riff limit reached. Try again tomorrow."),
    ).toBeTruthy();
    expect(
      screen.queryByText("Couldn’t reach the assistant. Try again in a moment."),
    ).toBeNull();
  });

  it("renders the session-expired copy for an ApiError with status 401 (Issue 2 C10)", () => {
    const session = makeController({
      error: new ApiError({
        message: "Not authenticated.",
        kind: "http",
        status: 401,
      }),
    });
    renderWithTheme(<RiffChat session={session} />);

    expect(
      screen.getByText("Your session has expired. Sign in again to riff."),
    ).toBeTruthy();
    expect(
      screen.queryByText("Couldn’t reach the assistant. Try again in a moment."),
    ).toBeNull();
  });

  it("keeps the generic copy for any other error status (Issue 2 C10)", () => {
    const session = makeController({
      error: new ApiError({
        message: "Server exploded.",
        kind: "http",
        status: 500,
      }),
    });
    renderWithTheme(<RiffChat session={session} />);

    expect(
      screen.getByText("Couldn’t reach the assistant. Try again in a moment."),
    ).toBeTruthy();
    // Raw server detail and status jargon never surface.
    expect(screen.queryByText(/Server exploded/)).toBeNull();
    expect(screen.queryByText(/500/)).toBeNull();
  });

  it("renders messages in order with both roles visible", () => {
    const session = makeController({
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
        { role: "user", content: "Thanks" },
      ],
    });
    renderWithTheme(<RiffChat session={session} />);

    expect(screen.getByText("Hi")).toBeTruthy();
    expect(screen.getByText("Hello")).toBeTruthy();
    expect(screen.getByText("Thanks")).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Phase 13.2 — Save to Cookbook CTA
  // -------------------------------------------------------------------------

  it("shows 'Save to Cookbook' on assistant messages with generatedRecipe and id", () => {
    const session = makeController({
      messages: [
        {
          role: "assistant",
          content: "Here's a dairy-free version",
          id: "msg-1",
          generatedRecipe: {
            title: "X",
            servings: null,
            prep_time: null,
            cook_time: null,
            confidence: 1.0,
            ingredients: [],
            steps: [],
          } as Record<string, unknown>,
        },
      ],
    });
    renderWithTheme(<RiffChat session={session} />);

    expect(screen.getByText("Save to Cookbook")).toBeTruthy();
  });

  it("hides Save CTA on user messages and on assistant messages without a generated recipe", () => {
    const session = makeController({
      messages: [
        { role: "user", content: "Make it dairy-free" },
        {
          role: "assistant",
          content: "Just discussing, no recipe block here",
          id: "msg-1",
          generatedRecipe: null,
        },
      ],
    });
    renderWithTheme(<RiffChat session={session} />);

    expect(screen.queryByText("Save to Cookbook")).toBeNull();
  });

  it("opens Alert.prompt with the first user message as default and dispatches saveRecipe on confirm", () => {
    const save = jest.fn();
    const promptSpy = jest
      .spyOn(Alert, "prompt")
      .mockImplementation(() => undefined);

    const session = makeController({
      messages: [
        { role: "user", content: "Make it dairy-free" },
        {
          role: "assistant",
          content: "Here's the version",
          id: "msg-1",
          generatedRecipe: {
            title: "X",
            servings: null,
            prep_time: null,
            cook_time: null,
            confidence: 1.0,
            ingredients: [],
            steps: [],
          } as Record<string, unknown>,
        },
      ],
      saveRecipe: save,
    });
    renderWithTheme(<RiffChat session={session} />);

    fireEvent.press(screen.getByText("Save to Cookbook"));

    expect(promptSpy).toHaveBeenCalled();
    const [title, _msg, buttons, type, defaultValue] = promptSpy.mock.calls[0]!;
    expect(title).toBe("Save to Cookbook");
    expect(type).toBe("plain-text");
    expect(defaultValue).toBe("Make it dairy-free");

    // Simulate the user typing a label and tapping "Save" in the prompt.
    type PromptButton = { text: string; onPress?: (text?: string) => void };
    const saveButton = (buttons as PromptButton[]).find(
      (b) => b.text === "Save",
    );
    saveButton?.onPress?.("Dairy-Free");

    expect(save).toHaveBeenCalledWith("msg-1", "Dairy-Free");

    promptSpy.mockRestore();
  });

  it("does not render an empty assistant bubble when content is blank after strip (13.2.8)", () => {
    // Fence-only assistant response: stripRecipeBlocks produces "" and the
    // hook still stores the message (generatedRecipe populated for CTA).
    // The component must skip the bubble so no empty padded container renders
    // below the user prompt, while keeping the Save CTA reachable.
    const session = makeController({
      messages: [
        { role: "user", content: "give me the full recipe" },
        {
          role: "assistant",
          content: "",
          id: "msg-1",
          generatedRecipe: {
            title: "X",
            servings: null,
            prep_time: null,
            cook_time: null,
            confidence: 1.0,
            ingredients: [],
            steps: [],
          } as Record<string, unknown>,
        },
      ],
    });
    renderWithTheme(<RiffChat session={session} />);

    // User bubble still renders, CTA still renders.
    expect(screen.getByText("give me the full recipe")).toBeTruthy();
    expect(screen.getByText("Save to Cookbook")).toBeTruthy();
  });

  it("shows 'Saved ✓' when the message id is in savedMessageIds", () => {
    const session = makeController({
      messages: [
        {
          role: "assistant",
          content: "Here's the version",
          id: "msg-1",
          generatedRecipe: {
            title: "X",
            servings: null,
            prep_time: null,
            cook_time: null,
            confidence: 1.0,
            ingredients: [],
            steps: [],
          } as Record<string, unknown>,
        },
      ],
      savedMessageIds: new Set(["msg-1"]),
    });
    renderWithTheme(<RiffChat session={session} />);

    expect(screen.getByText("Saved ✓")).toBeTruthy();
    expect(screen.queryByText("Save to Cookbook")).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Phase 13.6.7 — Save bridge copy
  // -------------------------------------------------------------------------

  it("renders the save bridge copy on an unsaved assistant message with generatedRecipe", () => {
    const session = makeController({
      messages: [
        {
          role: "assistant",
          content: "Here is a dairy-free version.",
          id: "msg-1",
          generatedRecipe: {
            title: "X",
            servings: null,
            prep_time: null,
            cook_time: null,
            confidence: 1.0,
            ingredients: [],
            steps: [],
          } as Record<string, unknown>,
        },
      ],
    });
    renderWithTheme(<RiffChat session={session} />);

    // Bridge copy is a sibling Text, not a replacement for the bubble or CTA.
    expect(
      screen.getByText(/Save the full recipe to your cookbook/i),
    ).toBeTruthy();
    expect(screen.getByText("Here is a dairy-free version.")).toBeTruthy();
    expect(screen.getByText("Save to Cookbook")).toBeTruthy();
  });

  it("hides the save bridge copy once the message is saved", () => {
    const session = makeController({
      messages: [
        {
          role: "assistant",
          content: "Here is a dairy-free version.",
          id: "msg-1",
          generatedRecipe: {
            title: "X",
            servings: null,
            prep_time: null,
            cook_time: null,
            confidence: 1.0,
            ingredients: [],
            steps: [],
          } as Record<string, unknown>,
        },
      ],
      savedMessageIds: new Set(["msg-1"]),
    });
    renderWithTheme(<RiffChat session={session} />);

    expect(
      screen.queryByText(/Save the full recipe to your cookbook/i),
    ).toBeNull();
    // Saved ✓ is still visible — bridge hides, CTA preserves saved state.
    expect(screen.getByText("Saved ✓")).toBeTruthy();
  });

  it("does not render the save bridge copy on assistant messages without generatedRecipe", () => {
    const session = makeController({
      messages: [
        {
          role: "assistant",
          content: "Just discussing, no recipe block here.",
          id: "msg-1",
          generatedRecipe: null,
        },
      ],
    });
    renderWithTheme(<RiffChat session={session} />);

    expect(
      screen.queryByText(/Save the full recipe to your cookbook/i),
    ).toBeNull();
  });

  it("does not render the save bridge copy on user messages", () => {
    const session = makeController({
      messages: [{ role: "user", content: "Make it dairy-free" }],
    });
    renderWithTheme(<RiffChat session={session} />);

    expect(
      screen.queryByText(/Save the full recipe to your cookbook/i),
    ).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 6E — Phase 13.5 streaming UI
  // -------------------------------------------------------------------------

  it("renders the partial assistant bubble while streaming", () => {
    const session = makeController({
      isStreaming: true,
      currentPartialAssistantMessage: "Hel",
      messages: [{ role: "user", content: "Hi" }],
    });
    renderWithTheme(<RiffChat session={session} />);

    // User bubble + partial bubble both visible.
    expect(screen.getByText("Hi")).toBeTruthy();
    expect(screen.getByText("Hel")).toBeTruthy();

    // Save CTA is NOT rendered for the partial bubble — it's outside the
    // messages.map loop and has no id/generatedRecipe to gate on.
    expect(screen.queryByText("Save to Cookbook")).toBeNull();
  });

  it("renders Cancel instead of Send while streaming and dispatches cancel()", () => {
    const cancelMock = jest.fn();
    const session = makeController({
      isStreaming: true,
      currentPartialAssistantMessage: "streaming...",
      cancel: cancelMock,
    });
    renderWithTheme(<RiffChat session={session} />);

    // Stop renders; Send does not.
    expect(screen.getByText("Stop")).toBeTruthy();
    expect(screen.queryByText("Send")).toBeNull();

    // Pressing Stop invokes the controller's cancel().
    fireEvent.press(screen.getByText("Stop"));
    expect(cancelMock).toHaveBeenCalledTimes(1);
  });

  it("renders Send again when streaming ends", () => {
    // Simulate streaming completion: controller has isStreaming=false and
    // currentPartialAssistantMessage=null. Re-render reflects the new state.
    const session = makeController({
      isStreaming: false,
      currentPartialAssistantMessage: null,
      messages: [
        { role: "user", content: "Hi" },
        {
          role: "assistant",
          content: "All done",
          id: "asst-1",
          generatedRecipe: null,
        },
      ],
    });
    renderWithTheme(<RiffChat session={session} />);

    expect(screen.getByText("Send")).toBeTruthy();
    expect(screen.queryByText("Stop")).toBeNull();
    // Final assistant message renders normally.
    expect(screen.getByText("All done")).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Phase 13.8 — initialDraft seed + showSaveCta suppression
  // -------------------------------------------------------------------------

  it("seeds the composer with initialDraft when prop is set", () => {
    const session = makeController();
    renderWithTheme(
      <RiffChat
        session={session}
        initialDraft="What can I substitute for Flour in this recipe?"
      />,
    );
    const input = screen.getByLabelText("Riff message");
    expect(input.props.value).toBe(
      "What can I substitute for Flour in this recipe?",
    );
  });

  it("does not auto-send when initialDraft is set", () => {
    const session = makeController();
    renderWithTheme(
      <RiffChat
        session={session}
        initialDraft="What can I substitute for Flour in this recipe?"
      />,
    );
    // No tap, no submit — sendMessage must NOT be invoked from mounting alone.
    expect(session.sendMessage).not.toHaveBeenCalled();
  });

  it("suppresses Save CTA and bridge copy when showSaveCta is false even with generatedRecipe + id", () => {
    const session = makeController({
      messages: [
        {
          role: "assistant",
          content: "Here is a substitute.",
          id: "msg-1",
          generatedRecipe: {
            title: "X",
            servings: null,
            prep_time: null,
            cook_time: null,
            confidence: 1.0,
            ingredients: [],
            steps: [],
          } as Record<string, unknown>,
        },
      ],
    });
    renderWithTheme(<RiffChat session={session} showSaveCta={false} />);

    // Bubble content still renders.
    expect(screen.getByText("Here is a substitute.")).toBeTruthy();
    // Save CTA + bridge copy both suppressed.
    expect(screen.queryByText("Save to Cookbook")).toBeNull();
    expect(
      screen.queryByText(/Save the full recipe to your cookbook/i),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Issue 1: save pending state (Saving… + duplicate suppression)
// ---------------------------------------------------------------------------

describe("RiffChat save pending state (Issue 1)", () => {
  const recipeMessage = {
    role: "assistant" as const,
    content: "Here's a dairy-free version",
    id: "msg-1",
    generatedRecipe: {
      title: "X",
      servings: null,
      prep_time: null,
      cook_time: null,
      confidence: 1.0,
      ingredients: [],
      steps: [],
    } as Record<string, unknown>,
  };

  it("shows Saving… with disabled + busy state while a save is pending", () => {
    const session = makeController({
      messages: [recipeMessage],
      isSaving: true,
    });
    renderWithTheme(<RiffChat session={session} />);

    expect(screen.getByText("Saving…")).toBeTruthy();
    const cta = screen.getByLabelText("Saving recipe");
    expect(cta.props.accessibilityState).toMatchObject({
      disabled: true,
      busy: true,
    });
  });

  it("suppresses further save presses while pending (no second prompt)", () => {
    const promptSpy = jest
      .spyOn(Alert, "prompt")
      .mockImplementation(() => undefined);
    const save = jest.fn();
    const session = makeController({
      messages: [recipeMessage],
      isSaving: true,
      saveRecipe: save,
    });
    renderWithTheme(<RiffChat session={session} />);

    fireEvent.press(screen.getByLabelText("Saving recipe"));
    expect(promptSpy).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });

  it("returns to the normal CTA when the save settles unsaved (retryable failure)", () => {
    const session = makeController({
      messages: [recipeMessage],
      isSaving: false,
    });
    renderWithTheme(<RiffChat session={session} />);
    expect(screen.getByText("Save to Cookbook")).toBeTruthy();
  });
});
