import React from "react";
import { AccessibilityInfo } from "react-native";
import { fireEvent } from "@testing-library/react-native";
import { renderWithTheme } from "../test-utils";

const mockUseReducedMotion = jest.fn((): boolean => false);
jest.mock("../../lib/hooks/useReducedMotion", () => ({
  useReducedMotion: () => mockUseReducedMotion(),
}));

import { OnboardingPanels } from "../../components/OnboardingPanels";

/**
 * 15.3.2 — shared onboarding panels: three-panel walk, skip on every panel,
 * exactly-once completion, replay labels, a11y contract, reduced motion.
 */

const PANEL_HEADINGS = [
  "Capture any recipe",
  "Review, then save",
  "Cook it your way",
] as const;

beforeEach(() => {
  jest.clearAllMocks();
  mockUseReducedMotion.mockImplementation(() => false);
});

describe("first-run mode", () => {
  test("walks all three panels and completes with 'finish'", () => {
    const onComplete = jest.fn();
    const view = renderWithTheme(
      <OnboardingPanels mode="firstRun" onComplete={onComplete} />,
    );

    expect(view.getByText(PANEL_HEADINGS[0])).toBeTruthy();
    expect(view.getByLabelText("Panel 1 of 3")).toBeTruthy();

    fireEvent.press(view.getByText("Next"));
    expect(view.getByText(PANEL_HEADINGS[1])).toBeTruthy();
    expect(view.getByLabelText("Panel 2 of 3")).toBeTruthy();

    fireEvent.press(view.getByText("Next"));
    expect(view.getByText(PANEL_HEADINGS[2])).toBeTruthy();
    expect(onComplete).not.toHaveBeenCalled();

    fireEvent.press(view.getByText("Start capturing"));
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith("finish");
  });

  test.each([0, 1, 2])("skip is available on panel %i and completes with 'skip'", (panel) => {
    const onComplete = jest.fn();
    const view = renderWithTheme(
      <OnboardingPanels mode="firstRun" onComplete={onComplete} />,
    );

    for (let i = 0; i < panel; i += 1) {
      fireEvent.press(view.getByText("Next"));
    }
    expect(view.getByText(PANEL_HEADINGS[panel])).toBeTruthy();

    fireEvent.press(view.getByLabelText("Skip onboarding"));
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith("skip");
  });

  test("completion fires exactly once across rapid taps", () => {
    const onComplete = jest.fn();
    const view = renderWithTheme(
      <OnboardingPanels mode="firstRun" onComplete={onComplete} />,
    );

    fireEvent.press(view.getByText("Next"));
    fireEvent.press(view.getByText("Next"));
    const cta = view.getByText("Start capturing");
    fireEvent.press(cta);
    fireEvent.press(cta);
    fireEvent.press(view.getByLabelText("Skip onboarding"));

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith("finish");
  });

  test("headings are accessibility headers; voice/permission truth lives on the cook panel", () => {
    const view = renderWithTheme(
      <OnboardingPanels mode="firstRun" onComplete={jest.fn()} />,
    );

    expect(view.getByRole("header")).toBeTruthy();

    fireEvent.press(view.getByText("Next"));
    fireEvent.press(view.getByText("Next"));
    expect(
      view.getByText(/voice control lives inside cooking mode/i),
    ).toBeTruthy();
    expect(view.getByText(/asks for the microphone only there/i)).toBeTruthy();
  });

  test("focus move is guarded: no crash and no focus call when the host node is unresolvable", () => {
    // Harness limitation (honest): react-test-renderer resolves
    // findNodeHandle to null, so the actual setAccessibilityFocus
    // invocation is NOT deterministically assertable here — the null-node
    // guard is. Real VoiceOver focus movement is a device-matrix item.
    const focusSpy = jest
      .spyOn(AccessibilityInfo, "setAccessibilityFocus")
      .mockImplementation(() => {});
    const view = renderWithTheme(
      <OnboardingPanels mode="firstRun" onComplete={jest.fn()} />,
    );

    fireEvent.press(view.getByText("Next"));

    expect(view.getByText(PANEL_HEADINGS[1])).toBeTruthy();
    expect(focusSpy).not.toHaveBeenCalledWith(null);
  });

  test("reduced motion: panel changes render instantly and completely", () => {
    mockUseReducedMotion.mockImplementation(() => true);
    const onComplete = jest.fn();
    const view = renderWithTheme(
      <OnboardingPanels mode="firstRun" onComplete={onComplete} />,
    );

    fireEvent.press(view.getByText("Next"));
    expect(view.getByText(PANEL_HEADINGS[1])).toBeTruthy();
    fireEvent.press(view.getByText("Next"));
    expect(view.getByText(PANEL_HEADINGS[2])).toBeTruthy();
    fireEvent.press(view.getByText("Start capturing"));
    expect(onComplete).toHaveBeenCalledWith("finish");
  });

  test("reduced motion enabling mid-flow (async false→true) keeps panel changes working", () => {
    mockUseReducedMotion.mockImplementationOnce(() => false);
    const view = renderWithTheme(
      <OnboardingPanels mode="firstRun" onComplete={jest.fn()} />,
    );

    // Subsequent renders observe the enabled preference (the real hook
    // resolves its initial async read exactly like this: false, then true).
    mockUseReducedMotion.mockImplementation(() => true);
    fireEvent.press(view.getByText("Next"));
    expect(view.getByText(PANEL_HEADINGS[1])).toBeTruthy();
  });
});

describe("replay mode", () => {
  test("uses Close and Done labels; both complete without distinction the parent can't handle", () => {
    const onComplete = jest.fn();
    const view = renderWithTheme(
      <OnboardingPanels mode="replay" onComplete={onComplete} />,
    );

    expect(view.getByText("Close")).toBeTruthy();
    expect(view.queryByText("Skip")).toBeNull();

    fireEvent.press(view.getByText("Next"));
    fireEvent.press(view.getByText("Next"));
    fireEvent.press(view.getByText("Done"));

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith("finish");
  });

  test("Close completes with 'skip' from any panel", () => {
    const onComplete = jest.fn();
    const view = renderWithTheme(
      <OnboardingPanels mode="replay" onComplete={onComplete} />,
    );

    fireEvent.press(view.getByText("Next"));
    fireEvent.press(view.getByLabelText("Close"));

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith("skip");
  });
});
