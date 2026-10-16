import React from "react";
import { screen, fireEvent } from "@testing-library/react-native";
import { renderWithTheme } from "../test-utils";
import { ErrorState } from "../../components/ErrorState";

describe("ErrorState", () => {
  test("renders error message", () => {
    renderWithTheme(<ErrorState message="Something went wrong." onRetry={() => {}} />);
    expect(screen.getByText("Something went wrong.")).toBeTruthy();
  });

  test("calls onRetry when Retry is pressed", () => {
    const onRetry = jest.fn();
    renderWithTheme(<ErrorState message="Error" onRetry={onRetry} />);
    fireEvent.press(screen.getByText("Retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
