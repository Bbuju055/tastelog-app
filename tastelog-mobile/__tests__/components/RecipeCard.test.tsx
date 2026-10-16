import React, { useEffect } from "react";
import { Animated } from "react-native";
import { screen, fireEvent } from "@testing-library/react-native";
import { renderWithTheme } from "../test-utils";
import { RecipeCard } from "../../components/RecipeCard";
import { lightPalette } from "../../theme/palettes";
import { shadows } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";
import type { RecipeSearchResult } from "../../lib/api/schemas";

const FULL_RECIPE: RecipeSearchResult = {
  id: "abc-123",
  title: "Pasta Carbonara",
  servings: "4",
  prep_time: "10 min",
  cook_time: "20 min",
  confidence_score: 0.95,
  favorite: false,
  tags: ["Italian", "Pasta"],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const MINIMAL_RECIPE: RecipeSearchResult = {
  id: "def-456",
  title: "Quick Salad",
  servings: null,
  prep_time: null,
  cook_time: null,
  confidence_score: null,
  favorite: false,
  tags: [],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

describe("RecipeCard", () => {
  test("renders recipe title", () => {
    renderWithTheme(<RecipeCard recipe={FULL_RECIPE} onPress={() => {}} onToggleFavorite={() => {}} />);
    expect(screen.getByText("Pasta Carbonara")).toBeTruthy();
  });

  test("renders cook_time when present", () => {
    renderWithTheme(<RecipeCard recipe={FULL_RECIPE} onPress={() => {}} onToggleFavorite={() => {}} />);
    expect(screen.getByText("20 min")).toBeTruthy();
  });

  test("renders first tag as pill when present", () => {
    renderWithTheme(<RecipeCard recipe={FULL_RECIPE} onPress={() => {}} onToggleFavorite={() => {}} />);
    expect(screen.getByText("ITALIAN")).toBeTruthy();
  });

  test("handles null optional fields without crashing", () => {
    renderWithTheme(<RecipeCard recipe={MINIMAL_RECIPE} onPress={() => {}} onToggleFavorite={() => {}} />);
    expect(screen.getByText("Quick Salad")).toBeTruthy();
  });

  test("calls onPress with recipe when pressed", () => {
    const onPress = jest.fn();
    renderWithTheme(<RecipeCard recipe={FULL_RECIPE} onPress={onPress} onToggleFavorite={() => {}} />);
    fireEvent.press(screen.getByText("Pasta Carbonara"));
    expect(onPress).toHaveBeenCalledWith(FULL_RECIPE);
  });

  test("renders grocery button when onAddToGrocery is provided", () => {
    const onAdd = jest.fn();
    renderWithTheme(
      <RecipeCard recipe={FULL_RECIPE} onPress={() => {}} onToggleFavorite={() => {}} onAddToGrocery={onAdd} />,
    );
    expect(screen.getByLabelText("Add to grocery list")).toBeTruthy();
  });

  test("does not render grocery button when onAddToGrocery is omitted", () => {
    renderWithTheme(<RecipeCard recipe={FULL_RECIPE} onPress={() => {}} onToggleFavorite={() => {}} />);
    expect(screen.queryByLabelText("Add to grocery list")).toBeNull();
  });

  test("grocery button calls onAddToGrocery without triggering onPress", () => {
    const onPress = jest.fn();
    const onAdd = jest.fn();
    renderWithTheme(
      <RecipeCard recipe={FULL_RECIPE} onPress={onPress} onToggleFavorite={() => {}} onAddToGrocery={onAdd} />,
    );
    fireEvent.press(screen.getByLabelText("Add to grocery list"));
    expect(onAdd).toHaveBeenCalledWith(FULL_RECIPE);
    expect(onPress).not.toHaveBeenCalled();
  });

  test("grocery button is disabled when groceryPending is true", () => {
    const onAdd = jest.fn();
    renderWithTheme(
      <RecipeCard
        recipe={FULL_RECIPE}
        onPress={() => {}}
        onToggleFavorite={() => {}}
        onAddToGrocery={onAdd}
        groceryPending
      />,
    );
    fireEvent.press(screen.getByLabelText("Add to grocery list"));
    expect(onAdd).not.toHaveBeenCalled();
  });

  test("calls onLongPress when provided", () => {
    const onLongPress = jest.fn();
    renderWithTheme(
      <RecipeCard recipe={FULL_RECIPE} onPress={() => {}} onToggleFavorite={() => {}} onLongPress={onLongPress} />,
    );
    fireEvent(screen.getByText("Pasta Carbonara"), "longPress");
    expect(onLongPress).toHaveBeenCalledWith(FULL_RECIPE);
  });

  test("selected card shows accent border styling", () => {
    const { toJSON } = renderWithTheme(
      <RecipeCard recipe={FULL_RECIPE} onPress={() => {}} onToggleFavorite={() => {}} selected />,
    );
    const root = toJSON() as any;
    // Tree: outer entrance Animated.View → inner press-feedback Animated.View → Pressable
    const pressable = root.children[0].children[0];
    const flatStyle = Object.assign(
      {},
      ...[].concat(pressable.props.style).filter(Boolean),
    );
    expect(flatStyle.borderColor).toBe(lightPalette.selectedBorder);
    expect(flatStyle.borderWidth).toBe(1);
    expect(flatStyle.backgroundColor).toBe(lightPalette.selected);
  });

  // Phase 15.0.1 — light-only card shadow.
  // Robust traversal: find the Pressable by accessibilityRole instead of a
  // fixed children path (survives wrapper-tree changes, e.g. 15.1.2).
  function findCardPressable(node: unknown): any {
    if (!node || typeof node !== "object") return null;
    if (Array.isArray(node)) {
      for (const child of node) {
        const hit = findCardPressable(child);
        if (hit) return hit;
      }
      return null;
    }
    const n = node as any;
    if (n.props?.accessibilityRole === "button") return n;
    return findCardPressable(n.children ?? null);
  }

  test("card applies shadows.card in light theme", () => {
    const { toJSON } = renderWithTheme(
      <RecipeCard recipe={FULL_RECIPE} onPress={() => {}} onToggleFavorite={() => {}} />,
    );
    const pressable = findCardPressable(toJSON());
    const flatStyle = Object.assign(
      {},
      ...[].concat(pressable.props.style).flat(Infinity).filter(Boolean),
    );
    expect(flatStyle.shadowOpacity).toBe(shadows.card.shadowOpacity);
    expect(flatStyle.shadowRadius).toBe(shadows.card.shadowRadius);
  });

  test("card has no shadow in dark theme", () => {
    function ThemeForcer({ mode }: { mode: "light" | "dark" }) {
      const { setPreference } = useTheme();
      useEffect(() => {
        setPreference(mode);
      }, [mode, setPreference]);
      return null;
    }
    const { toJSON } = renderWithTheme(
      <>
        <ThemeForcer mode="dark" />
        <RecipeCard recipe={FULL_RECIPE} onPress={() => {}} onToggleFavorite={() => {}} />
      </>,
    );
    const pressable = findCardPressable(toJSON());
    const flatStyle = Object.assign(
      {},
      ...[].concat(pressable.props.style).flat(Infinity).filter(Boolean),
    );
    expect(flatStyle.shadowOpacity).toBeUndefined();
  });

  test("renders cleanly when entranceOpacity is provided (Phase 10.G)", () => {
    const opacityValue = new Animated.Value(0);
    renderWithTheme(
      <RecipeCard
        recipe={FULL_RECIPE}
        onPress={() => {}}
        onToggleFavorite={() => {}}
        entranceOpacity={opacityValue}
      />,
    );
    expect(screen.getByText("Pasta Carbonara")).toBeTruthy();
  });

  test("quick add does not trigger long press", () => {
    const onLongPress = jest.fn();
    const onAdd = jest.fn();
    renderWithTheme(
      <RecipeCard
        recipe={FULL_RECIPE}
        onPress={() => {}}
        onToggleFavorite={() => {}}
        onAddToGrocery={onAdd}
        onLongPress={onLongPress}
      />,
    );
    fireEvent.press(screen.getByLabelText("Add to grocery list"));
    expect(onAdd).toHaveBeenCalled();
    expect(onLongPress).not.toHaveBeenCalled();
  });

  // Phase 13.6.4-FU — Saved Riff lineage indicator
  describe("Riff lineage indicator", () => {
    const RIFF_RECIPE: RecipeSearchResult = {
      ...FULL_RECIPE,
      parent_recipe_id: "11111111-1111-1111-1111-111111111111",
      riff_session_id: "22222222-2222-2222-2222-222222222222",
      riff_label: "Dairy-Free",
    };

    test("renders 'Riff' indicator when parent_recipe_id is present", () => {
      renderWithTheme(
        <RecipeCard recipe={RIFF_RECIPE} onPress={() => {}} onToggleFavorite={() => {}} />,
      );
      expect(screen.getByText("Riff")).toBeTruthy();
      expect(screen.getByLabelText("Riff recipe")).toBeTruthy();
    });

    test("does not render 'Riff' indicator when lineage is absent", () => {
      // FULL_RECIPE has no parent_recipe_id (undefined via the optional field).
      renderWithTheme(
        <RecipeCard recipe={FULL_RECIPE} onPress={() => {}} onToggleFavorite={() => {}} />,
      );
      expect(screen.queryByLabelText("Riff recipe")).toBeNull();
      expect(screen.queryByText("Riff")).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// 15.1.5 — star favorite pop
// ---------------------------------------------------------------------------

describe("RecipeCard — star favorite transition (15.1.5)", () => {
  test("favorite flip false→true re-renders the filled star without crashing", () => {
    const { rerender } = renderWithTheme(
      <RecipeCard
        recipe={FULL_RECIPE}
        onPress={() => {}}
        onToggleFavorite={() => {}}
      />,
    );
    expect(screen.getByText("☆")).toBeTruthy();
    rerender(
      <RecipeCard
        recipe={{ ...FULL_RECIPE, favorite: true }}
        onPress={() => {}}
        onToggleFavorite={() => {}}
      />,
    );
    expect(screen.getByText("★")).toBeTruthy();
  });

  test("mounting an already-favorited card renders the filled star at rest", () => {
    // Virtualized remount safety: the prev-value ref seeds from the prop,
    // so no transition is observed on mount (no pop; scale stays at rest).
    renderWithTheme(
      <RecipeCard
        recipe={{ ...FULL_RECIPE, favorite: true }}
        onPress={() => {}}
        onToggleFavorite={() => {}}
      />,
    );
    expect(screen.getByText("★")).toBeTruthy();
  });

  test("unfavorite true→false renders the empty star", () => {
    const { rerender } = renderWithTheme(
      <RecipeCard
        recipe={{ ...FULL_RECIPE, favorite: true }}
        onPress={() => {}}
        onToggleFavorite={() => {}}
      />,
    );
    rerender(
      <RecipeCard
        recipe={FULL_RECIPE}
        onPress={() => {}}
        onToggleFavorite={() => {}}
      />,
    );
    expect(screen.getByText("☆")).toBeTruthy();
  });
});
