/**
 * Build 5 Class B diagnostic (section 4.D.18 / section 13): the picker hook
 * emits flag-guarded diagnostic records at its terminal points and changes
 * nothing else. The five pickerResult paths and the two mode records are
 * pinned here; the caller contract (onSelected arguments) is asserted
 * alongside so a record can never replace a callback.
 */
import { act, renderHook } from "@testing-library/react-native";
import { ActionSheetIOS, Alert } from "react-native";

const mockRecord = jest.fn();
jest.mock("../../../lib/diagnostics/navTrace", () => ({
  navDiagnostics: { record: (...args: unknown[]) => mockRecord(...args) },
}));

const mockCreateGroceryList = jest.fn();
jest.mock("../../../lib/api/endpoints", () => ({
  createGroceryList: (...args: unknown[]) => mockCreateGroceryList(...args),
}));

jest.mock("../../../lib/haptics/haptics", () => ({
  hapticTap: jest.fn(),
}));

import { useGroceryPicker } from "../../../lib/hooks/useGroceryPicker";
import type { GroceryListResponse } from "../../../lib/api/schemas";

type SheetCallback = (buttonIndex: number) => void;
type PromptButton = { text?: string; style?: string; onPress?: (v?: string) => void };

const lists: GroceryListResponse[] = [
  { id: "list-a", name: "A", display_name: "A" } as GroceryListResponse,
  { id: "list-b", name: "B", display_name: "B" } as GroceryListResponse,
];

let sheetCallback: SheetCallback | null = null;
let promptButtons: PromptButton[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  sheetCallback = null;
  promptButtons = [];
  jest
    .spyOn(ActionSheetIOS, "showActionSheetWithOptions")
    .mockImplementation((_opts, cb) => {
      sheetCallback = cb as SheetCallback;
    });
  jest.spyOn(Alert, "prompt").mockImplementation((_t, _m, buttons) => {
    promptButtons = (buttons ?? []) as PromptButton[];
  });
  jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
});

function recordsOf(kind: string): unknown[] {
  return mockRecord.mock.calls.filter((c) => c[0] === kind).map((c) => c[1]);
}

describe("useGroceryPicker diagnostic records", () => {
  it("records mode auto when fewer than two lists exist and still auto-selects", () => {
    const { result } = renderHook(() => useGroceryPicker([lists[0]!], false));
    const onSelected = jest.fn();
    act(() => result.current.pickList(onSelected));
    expect(onSelected).toHaveBeenCalledWith(null, false);
    expect(recordsOf("grocery.picker")).toEqual([{ mode: "auto" }]);
    expect(recordsOf("grocery.pickerResult")).toEqual([]);
  });

  it("records mode sheet when the ActionSheet is shown", () => {
    const { result } = renderHook(() => useGroceryPicker(lists, false));
    act(() => result.current.pickList(jest.fn()));
    expect(ActionSheetIOS.showActionSheetWithOptions).toHaveBeenCalledTimes(1);
    expect(recordsOf("grocery.picker")).toEqual([{ mode: "sheet" }]);
  });

  it("records sheetCancel on the cancel index and does not call back", () => {
    const { result } = renderHook(() => useGroceryPicker(lists, false));
    const onSelected = jest.fn();
    act(() => result.current.pickList(onSelected));
    act(() => sheetCallback?.(lists.length + 1));
    expect(onSelected).not.toHaveBeenCalled();
    expect(recordsOf("grocery.pickerResult")).toEqual([{ path: "sheetCancel" }]);
  });

  it("records existing when a list row is chosen", () => {
    const { result } = renderHook(() => useGroceryPicker(lists, false));
    const onSelected = jest.fn();
    act(() => result.current.pickList(onSelected));
    act(() => sheetCallback?.(1));
    expect(onSelected).toHaveBeenCalledWith("list-b", false);
    expect(recordsOf("grocery.pickerResult")).toEqual([{ path: "existing" }]);
  });

  it("records newCreated after the list is created", async () => {
    mockCreateGroceryList.mockResolvedValueOnce({ id: "list-new" });
    const { result } = renderHook(() => useGroceryPicker(lists, false));
    const onSelected = jest.fn();
    act(() => result.current.pickList(onSelected));
    act(() => sheetCallback?.(lists.length));
    expect(Alert.prompt).toHaveBeenCalledTimes(1);
    const create = promptButtons.find((b) => b.text === "Create");
    await act(async () => {
      await create?.onPress?.("");
    });
    expect(onSelected).toHaveBeenCalledWith("list-new", true);
    expect(recordsOf("grocery.pickerResult")).toEqual([{ path: "newCreated" }]);
  });

  it("records createError when creation rejects and keeps the error alert", async () => {
    mockCreateGroceryList.mockRejectedValueOnce(new Error("boom"));
    const { result } = renderHook(() => useGroceryPicker(lists, false));
    const onSelected = jest.fn();
    act(() => result.current.pickList(onSelected));
    act(() => sheetCallback?.(lists.length));
    const create = promptButtons.find((b) => b.text === "Create");
    await act(async () => {
      await create?.onPress?.("");
    });
    expect(onSelected).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith(
      "Error",
      "Couldn't create list. Please try again.",
    );
    expect(recordsOf("grocery.pickerResult")).toEqual([{ path: "createError" }]);
  });

  it("records promptCancel from the prompt Cancel button and nothing else happens", () => {
    const { result } = renderHook(() => useGroceryPicker(lists, false));
    const onSelected = jest.fn();
    act(() => result.current.pickList(onSelected));
    act(() => sheetCallback?.(lists.length));
    const cancel = promptButtons.find((b) => b.text === "Cancel");
    expect(cancel?.style).toBe("cancel");
    act(() => cancel?.onPress?.());
    expect(onSelected).not.toHaveBeenCalled();
    expect(mockCreateGroceryList).not.toHaveBeenCalled();
    expect(recordsOf("grocery.pickerResult")).toEqual([{ path: "promptCancel" }]);
  });

  it("never passes list names or typed text into a record", async () => {
    mockCreateGroceryList.mockResolvedValueOnce({ id: "list-new" });
    const { result } = renderHook(() => useGroceryPicker(lists, false));
    act(() => result.current.pickList(jest.fn()));
    act(() => sheetCallback?.(lists.length));
    const create = promptButtons.find((b) => b.text === "Create");
    await act(async () => {
      await create?.onPress?.("Secret shopping");
    });
    const serialised = JSON.stringify(mockRecord.mock.calls);
    expect(serialised).not.toContain("Secret");
    expect(serialised).not.toContain("list-new");
    expect(serialised).not.toContain("\"A\"");
  });
});
