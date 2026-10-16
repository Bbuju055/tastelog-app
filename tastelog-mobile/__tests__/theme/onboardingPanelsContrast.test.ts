import React, { useEffect } from "react";
import { renderWithTheme } from "../test-utils";
import { useTheme } from "../../theme/ThemeProvider";
import { darkPalette, lightPalette } from "../../theme/palettes";
import type { ThemePalette } from "../../theme/palettes";
import { OnboardingPanels } from "../../components/OnboardingPanels";

/**
 * 15.3.2 — numeric WCAG contrast floors for the onboarding panels
 * (charter §3.7: body ≥4.5:1, large text ≥3:1).
 *
 * These assertions read the colours off the RENDERED component rather than
 * naming palette tokens directly. A palette-only test passes even if the
 * component switches to a failing token, which is not evidence of anything;
 * this one fails the moment the rendered token stops clearing the floor.
 */

function channelToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return (
    0.2126 * channelToLinear(r) +
    0.7152 * channelToLinear(g) +
    0.0722 * channelToLinear(b)
  );
}

function contrastRatio(fg: string, bg: string): number {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const [lighter, darker] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (lighter + 0.05) / (darker + 0.05);
}

function flattenStyle(style: unknown): Record<string, unknown> {
  if (!style) return {};
  if (Array.isArray(style)) {
    return style.reduce<Record<string, unknown>>(
      (acc, entry) => ({ ...acc, ...flattenStyle(entry) }),
      {},
    );
  }
  if (typeof style === "object") return style as Record<string, unknown>;
  return {};
}

/** Mirrors the Skeleton.test.tsx convention for forcing a resolved theme. */
function ThemeForcer({ mode }: { mode: "light" | "dark" }) {
  const { setPreference } = useTheme();
  useEffect(() => {
    setPreference(mode);
  }, [mode, setPreference]);
  return null;
}

function renderPanels(mode: "light" | "dark") {
  return renderWithTheme(
    React.createElement(
      React.Fragment,
      null,
      React.createElement(ThemeForcer, { mode }),
      React.createElement(OnboardingPanels, {
        mode: "firstRun",
        onComplete: jest.fn(),
      }),
    ),
  );
}

function renderedColor(node: { props: { style?: unknown } }): string {
  const color = flattenStyle(node.props.style).color;
  expect(typeof color).toBe("string");
  return color as string;
}

const palettes: Array<["light" | "dark", ThemePalette]> = [
  ["light", lightPalette],
  ["dark", darkPalette],
];

describe.each(palettes)(
  "onboarding panel contrast — %s palette (rendered tokens)",
  (mode, palette) => {
    test("panel heading clears the large-text floor AND the body floor on bg", () => {
      const view = renderPanels(mode);
      const color = renderedColor(view.getByText("Capture any recipe"));

      expect(contrastRatio(color, palette.bg)).toBeGreaterThanOrEqual(3);
      // The heading is the primary reading surface, so it is held to the
      // stricter body floor as well.
      expect(contrastRatio(color, palette.bg)).toBeGreaterThanOrEqual(4.5);
    });

    test("panel body copy ≥ 4.5:1 on bg", () => {
      const view = renderPanels(mode);
      const color = renderedColor(
        view.getByText(/Snap a photo of a cookbook page/),
      );

      expect(contrastRatio(color, palette.bg)).toBeGreaterThanOrEqual(4.5);
    });

    test("skip label ≥ 4.5:1 on bg (body-size text, not the muted token)", () => {
      const view = renderPanels(mode);
      const color = renderedColor(view.getByText("Skip"));

      expect(contrastRatio(color, palette.bg)).toBeGreaterThanOrEqual(4.5);
    });

    test("primary CTA label ≥ 4.5:1 on the primary fill", () => {
      // The CTA colour is owned by the shared Button, but the panels are the
      // surface that must clear the floor — so assert the rendered label.
      const view = renderPanels(mode);
      const color = renderedColor(view.getByText("Next"));

      expect(contrastRatio(color, palette.primary)).toBeGreaterThanOrEqual(4.5);
    });
  },
);
