import React from "react";
import { fireEvent, waitFor } from "@testing-library/react-native";
import { renderWithTheme } from "../test-utils";

/**
 * 15.3.3 — truthful sign-up outcome on the login screen: an email-
 * confirmation sign-up (no session returned) must SAY so instead of
 * silently staying on the form.
 */

const mockSignIn = jest.fn();
const mockSignUp = jest.fn();
const mockResetPassword = jest.fn();
jest.mock("../../lib/auth/context", () => ({
  useSession: jest.fn(() => ({
    signIn: mockSignIn,
    signUp: mockSignUp,
    resetPassword: mockResetPassword,
  })),
}));

const mockHapticSuccess = jest.fn();
const mockHapticWarning = jest.fn();
jest.mock("../../lib/haptics/haptics", () => ({
  hapticTap: jest.fn(),
  hapticSuccess: (...args: unknown[]) => mockHapticSuccess(...args),
  hapticWarning: (...args: unknown[]) => mockHapticWarning(...args),
}));

import LoginScreen from "../../app/login";

/**
 * Enumeration-safe by design: this copy must stay truthful for BOTH
 * null-session outcomes — a genuine new sign-up awaiting confirmation, and an
 * existing confirmed account, for which Supabase deliberately returns an
 * obfuscated user and no error. It therefore asserts no account was created
 * and reveals nothing about whether the address is registered.
 */
const CONFIRMATION_COPY =
  "Check your email to continue. If no message arrives, try signing in.";

function fillCredentials(view: ReturnType<typeof renderWithTheme>) {
  fireEvent.changeText(view.getByPlaceholderText("Email"), "new@user.dev");
  fireEvent.changeText(view.getByPlaceholderText("Password"), "hunter22");
}

function switchToSignUp(view: ReturnType<typeof renderWithTheme>) {
  fireEvent.press(view.getByText("Don't have an account? Create Account"));
}

beforeEach(() => {
  jest.clearAllMocks();
});

test("sign-up without a session shows the confirmation state and returns to sign-in", async () => {
  mockSignUp.mockResolvedValue({ sessionCreated: false });
  const view = renderWithTheme(<LoginScreen />);

  switchToSignUp(view);
  fillCredentials(view);
  fireEvent.press(view.getByText("Create Account"));

  await waitFor(() => {
    expect(view.getByText(CONFIRMATION_COPY)).toBeTruthy();
  });
  // Mode flipped back to sign-in so the post-confirmation action is right there.
  expect(view.getByText("Sign In")).toBeTruthy();
  expect(mockSignUp).toHaveBeenCalledWith("new@user.dev", "hunter22");
  expect(mockHapticSuccess).toHaveBeenCalledTimes(1);
});

test("an existing confirmed account (obfuscated, no error) gets the same copy and leaks nothing", async () => {
  // Supabase returns an obfuscated user and NO error for an already-registered
  // address, so `sessionCreated: false` is all the boundary can know. The copy
  // must not claim a new account, and must not differ from the genuine
  // sign-up case — differing copy would be an enumeration oracle.
  mockSignUp.mockResolvedValue({ sessionCreated: false });
  const view = renderWithTheme(<LoginScreen />);

  switchToSignUp(view);
  fillCredentials(view);
  fireEvent.press(view.getByText("Create Account"));

  await waitFor(() => {
    expect(view.getByText(CONFIRMATION_COPY)).toBeTruthy();
  });
  expect(view.queryByText(/Account created/i)).toBeNull();
  expect(view.queryByText(/already (registered|exists)/i)).toBeNull();
});

test("sign-up with an immediate session shows no confirmation copy (AuthGate navigates)", async () => {
  mockSignUp.mockResolvedValue({ sessionCreated: true });
  const view = renderWithTheme(<LoginScreen />);

  switchToSignUp(view);
  fillCredentials(view);
  fireEvent.press(view.getByText("Create Account"));

  await waitFor(() => {
    expect(mockSignUp).toHaveBeenCalledTimes(1);
  });
  expect(view.queryByText(CONFIRMATION_COPY)).toBeNull();
  // Still in sign-up mode — navigation away is AuthGate's job, not copy's.
  expect(view.getByText("Create Account")).toBeTruthy();
});

test("sign-up failure surfaces the error, not the confirmation copy", async () => {
  mockSignUp.mockRejectedValue(new Error("User already registered"));
  const view = renderWithTheme(<LoginScreen />);

  switchToSignUp(view);
  fillCredentials(view);
  fireEvent.press(view.getByText("Create Account"));

  await waitFor(() => {
    expect(view.getByText("User already registered")).toBeTruthy();
  });
  expect(view.queryByText(CONFIRMATION_COPY)).toBeNull();
  expect(mockHapticWarning).toHaveBeenCalledTimes(1);
});

test("sign-in flow is bit-identical (no confirmation copy, no mode flip)", async () => {
  mockSignIn.mockResolvedValue(undefined);
  const view = renderWithTheme(<LoginScreen />);

  fillCredentials(view);
  fireEvent.press(view.getByText("Sign In"));

  await waitFor(() => {
    expect(mockSignIn).toHaveBeenCalledWith("new@user.dev", "hunter22");
  });
  expect(view.queryByText(CONFIRMATION_COPY)).toBeNull();
  expect(mockSignUp).not.toHaveBeenCalled();
});
