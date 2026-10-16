import React, { useEffect } from "react";
import { ActivityIndicator } from "react-native";
import { screen, fireEvent } from "@testing-library/react-native";
import { renderWithTheme } from "../test-utils";
import { Button } from "../../components/Button";
import { useTheme } from "../../theme/ThemeProvider";
import { lightPalette, darkPalette } from "../../theme/palettes";

// Haptic wrapper mock — lets the opt-out tests assert tap-haptic emission.
const mockHapticTap = jest.fn();
jest.mock("../../lib/haptics/haptics", () => ({
  hapticTap: () => mockHapticTap(),
  hapticSuccess: jest.fn(),
  hapticWarning: jest.fn(),
}));

/**
 * Forces the ThemeProvider into a specific preference during test render.
 * Same pattern as Skeleton.test.tsx.
 */
function ThemeForcer({ mode }: { mode: "light" | "dark" }) {
  const { setPreference } = useTheme();
  useEffect(() => {
    setPreference(mode);
  }, [mode, setPreference]);
  return null;
}

function flattenStyle(style: unknown): Record<string, unknown> {
  if (!style) return {};
  const arr = Array.isArray(style) ? style : [style];
  return Object.assign({}, ...arr.flat(Infinity).filter(Boolean));
}

/** Depth-first search of a toJSON tree. */
function findNode(
  node: unknown,
  predicate: (n: any) => boolean,
): any {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findNode(child, predicate);
      if (hit) return hit;
    }
    return null;
  }
  const n = node as any;
  if (predicate(n)) return n;
  return findNode(n.children ?? null, predicate);
}

const isPressable = (n: any) => n?.props?.accessibilityRole === "button";
const isLabel = (n: any) => n?.type === "Text";

describe("Button", () => {
  test("renders title text", () => {
    renderWithTheme(<Button title="Submit" onPress={() => {}} />);
    expect(screen.getByText("Submit")).toBeTruthy();
  });

  test("calls onPress when pressed", () => {
    const onPress = jest.fn();
    renderWithTheme(<Button title="Submit" onPress={onPress} />);
    fireEvent.press(screen.getByText("Submit"));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  test("does not call onPress when disabled", () => {
    const onPress = jest.fn();
    renderWithTheme(<Button title="Submit" onPress={onPress} disabled />);
    fireEvent.press(screen.getByText("Submit"));
    expect(onPress).not.toHaveBeenCalled();
  });

  test("shows ActivityIndicator when loading", () => {
    renderWithTheme(<Button title="Submit" onPress={() => {}} loading />);
    expect(screen.queryByText("Submit")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Phase 15.2.3-B — haptic opt-out
// ---------------------------------------------------------------------------

describe("Button — haptic opt-out (15.2.3-B)", () => {
  beforeEach(() => {
    mockHapticTap.mockClear();
  });

  test("fires the tap haptic by default on press", () => {
    renderWithTheme(<Button title="Go" onPress={() => {}} />);
    fireEvent.press(screen.getByText("Go"));
    expect(mockHapticTap).toHaveBeenCalledTimes(1);
  });

  test("does not fire the tap haptic when haptic={false}", () => {
    const onPress = jest.fn();
    renderWithTheme(
      <Button title="Go" onPress={onPress} haptic={false} />,
    );
    fireEvent.press(screen.getByText("Go"));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(mockHapticTap).not.toHaveBeenCalled();
  });

  test("disabled button (default haptic) does not fire the tap haptic", () => {
    const onPress = jest.fn();
    renderWithTheme(
      <Button title="Go" onPress={onPress} disabled />,
    );
    fireEvent.press(screen.getByText("Go"));
    expect(onPress).not.toHaveBeenCalled();
    expect(mockHapticTap).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Phase 15.0.1 — token colors (disabledBg / disabledText / onPrimary)
// ---------------------------------------------------------------------------

describe("Button — token colors (15.0.1)", () => {
  test("primary uses primary fill + onPrimary label in light theme", () => {
    const { toJSON } = renderWithTheme(
      <Button title="Go" onPress={() => {}} />,
    );
    const pressable = findNode(toJSON(), isPressable);
    expect(flattenStyle(pressable.props.style).backgroundColor).toBe(
      lightPalette.primary,
    );
    const label = findNode(pressable, isLabel);
    expect(flattenStyle(label.props.style).color).toBe(lightPalette.onPrimary);
  });

  test("primary uses primary fill + onPrimary label in dark theme", () => {
    const { toJSON } = renderWithTheme(
      <>
        <ThemeForcer mode="dark" />
        <Button title="Go" onPress={() => {}} />
      </>,
    );
    const pressable = findNode(toJSON(), isPressable);
    expect(flattenStyle(pressable.props.style).backgroundColor).toBe(
      darkPalette.primary,
    );
    const label = findNode(pressable, isLabel);
    expect(flattenStyle(label.props.style).color).toBe(darkPalette.onPrimary);
  });

  test("disabled uses disabledBg fill + disabledText label in light theme", () => {
    const { toJSON } = renderWithTheme(
      <Button title="Go" onPress={() => {}} disabled />,
    );
    const pressable = findNode(toJSON(), isPressable);
    expect(flattenStyle(pressable.props.style).backgroundColor).toBe(
      lightPalette.disabledBg,
    );
    const label = findNode(pressable, isLabel);
    expect(flattenStyle(label.props.style).color).toBe(
      lightPalette.disabledText,
    );
  });

  test("disabled uses disabledBg fill + disabledText label in dark theme", () => {
    const { toJSON } = renderWithTheme(
      <>
        <ThemeForcer mode="dark" />
        <Button title="Go" onPress={() => {}} disabled />
      </>,
    );
    const pressable = findNode(toJSON(), isPressable);
    expect(flattenStyle(pressable.props.style).backgroundColor).toBe(
      darkPalette.disabledBg,
    );
    const label = findNode(pressable, isLabel);
    expect(flattenStyle(label.props.style).color).toBe(
      darkPalette.disabledText,
    );
  });

  test("destructive uses error fill + onPrimary label in light theme", () => {
    const { toJSON } = renderWithTheme(
      <Button title="Delete" onPress={() => {}} variant="destructive" />,
    );
    const pressable = findNode(toJSON(), isPressable);
    expect(flattenStyle(pressable.props.style).backgroundColor).toBe(
      lightPalette.error,
    );
    const label = findNode(pressable, isLabel);
    expect(flattenStyle(label.props.style).color).toBe(lightPalette.onPrimary);
  });

  test("destructive uses error fill + onPrimary label in dark theme", () => {
    const { toJSON } = renderWithTheme(
      <>
        <ThemeForcer mode="dark" />
        <Button title="Delete" onPress={() => {}} variant="destructive" />
      </>,
    );
    const pressable = findNode(toJSON(), isPressable);
    expect(flattenStyle(pressable.props.style).backgroundColor).toBe(
      darkPalette.error,
    );
    const label = findNode(pressable, isLabel);
    expect(flattenStyle(label.props.style).color).toBe(darkPalette.onPrimary);
  });

  test("loading spinner uses disabledText on disabledBg fill", () => {
    const { toJSON, UNSAFE_getByType } = renderWithTheme(
      <Button title="Go" onPress={() => {}} loading />,
    );
    const spinner = UNSAFE_getByType(ActivityIndicator);
    expect(spinner.props.color).toBe(lightPalette.disabledText);
    const pressable = findNode(toJSON(), isPressable);
    expect(flattenStyle(pressable.props.style).backgroundColor).toBe(
      lightPalette.disabledBg,
    );
  });

  test("loading spinner uses disabledText on disabledBg fill in dark theme", () => {
    const { toJSON, UNSAFE_getByType } = renderWithTheme(
      <>
        <ThemeForcer mode="dark" />
        <Button title="Go" onPress={() => {}} loading />
      </>,
    );
    const spinner = UNSAFE_getByType(ActivityIndicator);
    expect(spinner.props.color).toBe(darkPalette.disabledText);
    const pressable = findNode(toJSON(), isPressable);
    expect(flattenStyle(pressable.props.style).backgroundColor).toBe(
      darkPalette.disabledBg,
    );
  });

  test("size sm uses compact padding", () => {
    const { toJSON } = renderWithTheme(
      <Button title="Add" onPress={() => {}} size="sm" />,
    );
    const pressable = findNode(toJSON(), isPressable);
    const flat = flattenStyle(pressable.props.style);
    expect(flat.paddingVertical).toBe(8);
    expect(flat.minHeight).toBeUndefined();
  });

  test("size lg enforces the 56pt minimum height", () => {
    const { toJSON } = renderWithTheme(
      <Button title="Send" onPress={() => {}} size="lg" />,
    );
    const pressable = findNode(toJSON(), isPressable);
    expect(flattenStyle(pressable.props.style).minHeight).toBe(56);
  });

  test("fullWidth stretches the outer wrapper", () => {
    const { toJSON } = renderWithTheme(
      <Button title="Go" onPress={() => {}} fullWidth />,
    );
    const root = toJSON() as any;
    expect(flattenStyle(root.props.style).alignSelf).toBe("stretch");
  });

  test("accessibilityLabel passes through to the pressable", () => {
    renderWithTheme(
      <Button
        title="Delete Recipe"
        onPress={() => {}}
        accessibilityLabel="Delete recipe"
      />,
    );
    expect(screen.getByLabelText("Delete recipe")).toBeTruthy();
  });

  test("loading exposes busy accessibility state", () => {
    const { toJSON } = renderWithTheme(
      <Button title="Go" onPress={() => {}} loading />,
    );
    const pressable = findNode(toJSON(), isPressable);
    expect(pressable.props.accessibilityState).toEqual({
      disabled: true,
      busy: true,
    });
  });

  test("no variant uses palette.elevated as a disabled fill", () => {
    for (const variant of ["primary", "outline", "destructive"] as const) {
      const { toJSON, unmount } = renderWithTheme(
        <Button title="Go" onPress={() => {}} variant={variant} disabled />,
      );
      const pressable = findNode(toJSON(), isPressable);
      expect(flattenStyle(pressable.props.style).backgroundColor).toBe(
        lightPalette.disabledBg,
      );
      unmount();
    }
  });
});
