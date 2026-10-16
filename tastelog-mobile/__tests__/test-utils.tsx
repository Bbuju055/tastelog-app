import type { ReactElement } from "react";
import { render, type RenderOptions } from "@testing-library/react-native";
import { ThemeProvider } from "../theme/ThemeProvider";

/**
 * Render helper that wraps UI in a real ThemeProvider.
 * Use instead of bare `render()` for any component that calls useTheme().
 */
export function renderWithTheme(
  ui: ReactElement,
  options?: Omit<RenderOptions, "wrapper">,
) {
  return render(ui, {
    wrapper: ThemeProvider,
    ...options,
  });
}
