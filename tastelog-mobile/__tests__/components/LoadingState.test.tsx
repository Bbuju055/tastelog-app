import React from "react";
import { screen } from "@testing-library/react-native";
import { renderWithTheme } from "../test-utils";
import { LoadingState } from "../../components/LoadingState";

describe("LoadingState", () => {
  test("renders message when provided", () => {
    renderWithTheme(<LoadingState message="Loading recipes..." />);
    expect(screen.getByText("Loading recipes...")).toBeTruthy();
  });

  test("does not render message when not provided", () => {
    renderWithTheme(<LoadingState />);
    expect(screen.queryByText("Loading recipes...")).toBeNull();
  });
});
