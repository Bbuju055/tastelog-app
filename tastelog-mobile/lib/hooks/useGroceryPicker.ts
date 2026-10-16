import { useCallback, useRef } from "react";
import { ActionSheetIOS, Alert, Platform } from "react-native";

import { createGroceryList } from "../api/endpoints";
// Build 5 Class B diagnostic (section 13): flag-guarded terminal-point
// records, path/mode only. No-op unless EXPO_PUBLIC_NAV_DIAGNOSTICS is "1".
import { navDiagnostics } from "../diagnostics/navTrace";
import { defaultListName } from "../grocery/defaultListName";
import { hapticTap } from "../haptics/haptics";
import type { GroceryListResponse } from "../api/schemas";

/**
 * Callback shape for `pickList`.
 *
 * - `listId: string` — user picked an existing list or created a new one.
 *   Caller should pass this as `list_id` in the remake request.
 * - `listId: null` — 0–1 lists or Android; caller should omit `list_id`
 *   and let the backend auto-resolve.
 * - `wasCreated: boolean` — true when a new list was just created via the
 *   naming prompt. Callers use this to show context-aware error messages
 *   when the subsequent remake fails (partial failure).
 */
type OnListSelected = (listId: string | null, wasCreated: boolean) => void;

/**
 * Shared grocery list picker hook.
 *
 * Shows a full list picker (ActionSheetIOS) when 2+ lists exist.
 * "New List..." triggers a naming prompt + POST creation before
 * calling back with the new list's id.
 *
 * Used by both the recipe list (quick-add / batch-add) and
 * recipe detail (scaled add) screens.
 */
export function useGroceryPicker(
  lists: readonly GroceryListResponse[],
  isLoading: boolean,
) {
  const creatingRef = useRef(false);

  const promptAndCreate = useCallback(
    (onSelected: OnListSelected) => {
      if (creatingRef.current) return;

      const suggestion = defaultListName(
        lists.map((l) => l.display_name),
      );

      Alert.prompt(
        "Name your list",
        undefined,
        [
          {
            text: "Cancel",
            style: "cancel",
            // Diagnostic record only (F13: cancel callbacks are invoked).
            onPress: () => {
              navDiagnostics.record("grocery.pickerResult", { path: "promptCancel" });
            },
          },
          {
            text: "Create",
            onPress: async (value?: string) => {
              const name = value?.trim() || suggestion;
              if (creatingRef.current) return;

              creatingRef.current = true;
              try {
                const created = await createGroceryList({ name });
                navDiagnostics.record("grocery.pickerResult", { path: "newCreated" });
                onSelected(created.id, true);
              } catch {
                navDiagnostics.record("grocery.pickerResult", { path: "createError" });
                Alert.alert(
                  "Error",
                  "Couldn't create list. Please try again.",
                );
              } finally {
                creatingRef.current = false;
              }
            },
          },
        ],
        "plain-text",
        suggestion,
      );
    },
    [lists],
  );

  const pickList = useCallback(
    (onSelected: OnListSelected) => {
      if (isLoading) return;

      // 0–1 lists: skip picker, let backend auto-resolve
      if (lists.length < 2) {
        navDiagnostics.record("grocery.picker", { mode: "auto" });
        onSelected(null, false);
        return;
      }

      // Android: no ActionSheetIOS — auto-target
      if (Platform.OS !== "ios") {
        onSelected(null, false);
        return;
      }

      hapticTap();

      // Build options: all list names + "New List..." + Cancel
      const listOptions = lists.map((l) => l.display_name);
      const newListIndex = listOptions.length;
      const cancelIndex = listOptions.length + 1;
      const options = [...listOptions, "New List...", "Cancel"];

      navDiagnostics.record("grocery.picker", { mode: "sheet" });
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: "Add to which list?",
          options,
          cancelButtonIndex: cancelIndex,
        },
        (buttonIndex) => {
          if (buttonIndex === cancelIndex) {
            navDiagnostics.record("grocery.pickerResult", { path: "sheetCancel" });
            return;
          }

          if (buttonIndex === newListIndex) {
            promptAndCreate(onSelected);
            return;
          }

          // Existing list selected
          const selected = lists[buttonIndex];
          if (selected) {
            navDiagnostics.record("grocery.pickerResult", { path: "existing" });
            onSelected(selected.id, false);
          }
        },
      );
    },
    [lists, isLoading, promptAndCreate],
  );

  return { pickList };
}
