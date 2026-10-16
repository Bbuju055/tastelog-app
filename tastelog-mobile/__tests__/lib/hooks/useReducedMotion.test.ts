import { AccessibilityInfo } from "react-native";
import { renderHook, act, waitFor } from "@testing-library/react-native";
import { useReducedMotion } from "../../../lib/hooks/useReducedMotion";

/**
 * Phase 15.1.1 — reduced-motion hook.
 *
 * AccessibilityInfo is spied per-test (no global jest.setup mock needed:
 * jest-expo provides the module; we control its async result and capture
 * the change-event subscription here).
 */
describe("useReducedMotion (15.1.1)", () => {
  let changeHandler: ((enabled: boolean) => void) | null = null;
  const removeMock = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    changeHandler = null;
    jest
      .spyOn(AccessibilityInfo, "isReduceMotionEnabled")
      .mockResolvedValue(false);
    jest
      .spyOn(AccessibilityInfo, "addEventListener")
      .mockImplementation((event: string, handler: any) => {
        if (event === "reduceMotionChanged") changeHandler = handler;
        return { remove: removeMock } as any;
      });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("defaults to false before the initial async read resolves", () => {
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);
  });

  test("resolves to true when the system preference is enabled", async () => {
    (AccessibilityInfo.isReduceMotionEnabled as jest.Mock).mockResolvedValue(
      true,
    );
    const { result } = renderHook(() => useReducedMotion());
    await waitFor(() => expect(result.current).toBe(true));
  });

  test("normalizes a non-boolean initial resolve to false (15.1.2 hardening)", async () => {
    (AccessibilityInfo.isReduceMotionEnabled as jest.Mock).mockResolvedValue(
      undefined,
    );
    const { result } = renderHook(() => useReducedMotion());
    await act(async () => {});
    expect(result.current).toBe(false);
  });

  test("updates when the reduceMotionChanged event fires", async () => {
    const { result } = renderHook(() => useReducedMotion());
    expect(changeHandler).not.toBeNull();
    act(() => {
      changeHandler?.(true);
    });
    expect(result.current).toBe(true);
    act(() => {
      changeHandler?.(false);
    });
    expect(result.current).toBe(false);
  });

  test("removes the subscription on unmount", () => {
    const { unmount } = renderHook(() => useReducedMotion());
    unmount();
    expect(removeMock).toHaveBeenCalledTimes(1);
  });

  test("ignores a late initial resolve after unmount (no act warning)", async () => {
    let resolveInitial: (v: boolean) => void = () => {};
    (AccessibilityInfo.isReduceMotionEnabled as jest.Mock).mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveInitial = resolve;
      }),
    );
    const { unmount } = renderHook(() => useReducedMotion());
    unmount();
    await act(async () => {
      resolveInitial(true);
    });
    // No assertion target beyond "does not throw / no unmounted setState".
  });
});
