import { getMergeToastMessage } from "../../lib/grocery/mergeToastMessage";

describe("getMergeToastMessage", () => {
  const LIST = "Weekly Groceries";

  // --- No merges ---
  test("no merges — all items inserted", () => {
    expect(getMergeToastMessage(LIST, 5, 0)).toBe(
      "Added 5 items to Weekly Groceries",
    );
  });

  test("no merges — single item", () => {
    expect(getMergeToastMessage(LIST, 1, 0)).toBe(
      "Added 1 item to Weekly Groceries",
    );
  });

  // --- Some merges ---
  test("some merges — mixed insert and merge", () => {
    expect(getMergeToastMessage(LIST, 5, 2)).toBe(
      "Added 5 items to Weekly Groceries (2 merged)",
    );
  });

  test("some merges — one merged out of many", () => {
    expect(getMergeToastMessage(LIST, 8, 1)).toBe(
      "Added 8 items to Weekly Groceries (1 merged)",
    );
  });

  // --- All merged ---
  test("all merged — every item was a quantity update", () => {
    expect(getMergeToastMessage(LIST, 3, 3)).toBe(
      "All items already in Weekly Groceries \u2014 quantities updated",
    );
  });

  test("all merged — single item", () => {
    expect(getMergeToastMessage(LIST, 1, 1)).toBe(
      "All items already in Weekly Groceries \u2014 quantities updated",
    );
  });
});
