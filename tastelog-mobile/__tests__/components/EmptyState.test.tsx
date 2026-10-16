import React from "react";
import { screen, fireEvent } from "@testing-library/react-native";
import { renderWithTheme } from "../test-utils";
import { EmptyState } from "../../components/EmptyState";

describe("EmptyState", () => {
  test("renders message", () => {
    renderWithTheme(<EmptyState message="No recipes yet." />);
    expect(screen.getByText("No recipes yet.")).toBeTruthy();
  });

  test("renders action button when provided", () => {
    const onPress = jest.fn();
    renderWithTheme(
      <EmptyState
        message="No recipes."
        action={{ title: "Add One", onPress }}
      />,
    );
    fireEvent.press(screen.getByText("Add One"));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  test("does not render action button when not provided", () => {
    renderWithTheme(<EmptyState message="Empty." />);
    expect(screen.queryByText("Add One")).toBeNull();
  });
});
