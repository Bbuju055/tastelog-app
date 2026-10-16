import { renderHook } from "@testing-library/react-native";
import { useEnteringRowKeys } from "../../../lib/hooks/useEnteringRowKeys";

type Props = {
  keys: readonly string[];
  ready: boolean;
  scopeKey?: string | null;
};

function renderEnteringRowKeys(initialProps: Props) {
  return renderHook(
    ({ keys, ready, scopeKey }: Props) =>
      useEnteringRowKeys(keys, ready, scopeKey),
    { initialProps },
  );
}

describe("useEnteringRowKeys", () => {
  it("returns an empty set and does not seed while not ready", () => {
    const { result, rerender } = renderEnteringRowKeys({
      keys: ["a", "b"],
      ready: false,
    });
    expect(result.current.size).toBe(0);

    // Keys changing while not ready must not leak into a baseline.
    rerender({ keys: ["c", "d"], ready: false });
    expect(result.current.size).toBe(0);
  });

  it("seeds on the first ready render — initial data never enters", () => {
    const { result, rerender } = renderEnteringRowKeys({
      keys: [],
      ready: false,
    });

    rerender({ keys: ["a", "b"], ready: true });
    expect(result.current.size).toBe(0);
  });

  it("flags only keys that appear after seeding", () => {
    const { result, rerender } = renderEnteringRowKeys({
      keys: ["a", "b"],
      ready: true,
    });
    expect(result.current.size).toBe(0);

    rerender({ keys: ["a", "b", "c"], ready: true });
    expect([...result.current]).toEqual(["c"]);
  });

  it("does not re-flag a key on subsequent renders (virtualization remount safety)", () => {
    const { result, rerender } = renderEnteringRowKeys({
      keys: ["a"],
      ready: true,
    });

    rerender({ keys: ["a", "b"], ready: true });
    expect(result.current.has("b")).toBe(true);

    rerender({ keys: ["a", "b"], ready: true });
    expect(result.current.size).toBe(0);
  });

  it("does not flag a removed-then-restored key (rollback / cleared filter)", () => {
    const { result, rerender } = renderEnteringRowKeys({
      keys: ["a", "b"],
      ready: true,
    });

    rerender({ keys: ["a"], ready: true });
    expect(result.current.size).toBe(0);

    rerender({ keys: ["a", "b"], ready: true });
    expect(result.current.size).toBe(0);
  });

  it("reseeds on scopeKey change — a list switch never mass-enters", () => {
    const { result, rerender } = renderEnteringRowKeys({
      keys: ["a", "b"],
      ready: true,
      scopeKey: "list-1",
    });
    expect(result.current.size).toBe(0);

    rerender({ keys: ["x", "y", "z"], ready: true, scopeKey: "list-2" });
    expect(result.current.size).toBe(0);

    // After the reseed, genuinely new keys in the new scope flag normally.
    rerender({ keys: ["x", "y", "z", "w"], ready: true, scopeKey: "list-2" });
    expect([...result.current]).toEqual(["w"]);
  });

  it("treats null → id scope transition as a scope change", () => {
    const { result, rerender } = renderEnteringRowKeys({
      keys: [],
      ready: true,
      scopeKey: null,
    });

    rerender({ keys: ["a", "b"], ready: true, scopeKey: "list-1" });
    expect(result.current.size).toBe(0);
  });

  it("returns a stable empty set when nothing enters", () => {
    const { result, rerender } = renderEnteringRowKeys({
      keys: ["a"],
      ready: true,
    });
    const first = result.current;

    rerender({ keys: ["a"], ready: true });
    expect(result.current).toBe(first);
  });
});
