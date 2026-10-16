import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  type EdgeInsets,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { ErrorState, LoadingState, Screen } from "../../../../components";
import { RiffChat } from "../../../../components/RiffChat";
import { useRecipe } from "../../../../lib/hooks";
import { useRiffSession } from "../../../../lib/hooks/useRiffSession";
import type { ThemePalette } from "../../../../theme/palettes";
import { useScreenTheme, useTheme } from "../../../../theme/ThemeProvider";
import { fonts, fontSize, spacing } from "../../../../theme";

/**
 * Phase 13.3 — Dedicated Riff Compose Surface.
 *
 * Full-screen modal route (presentation: "fullScreenModal" in _layout.tsx).
 * Owns the close affordance, recipe-title header, and KeyboardAvoidingView
 * wrapper. Mounts <RiffChat /> as the canvas. Each mount = new session
 * (ephemeral persistence per Decision 1).
 */
export default function RecipeRiffScreen() {
  const { id, entryPoint: rawEntryPoint, initialDraft: rawInitialDraft } =
    useLocalSearchParams<{
      id?: string;
      entryPoint?: string;
      initialDraft?: string;
    }>();
  const recipeId = typeof id === "string" ? id : undefined;
  const entryPoint =
    typeof rawEntryPoint === "string" ? rawEntryPoint : undefined;
  const initialDraft =
    typeof rawInitialDraft === "string" ? rawInitialDraft : undefined;
  const showSaveCta = entryPoint !== "grocery_substitute";
  const router = useRouter();

  useScreenTheme("light");
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const s = createStyles(palette, insets);

  const { data: recipe, error, isLoading, refetch } = useRecipe(recipeId);

  // Phase 13.9 Slice H — hook ownership moved up from RiffChat. Same
  // anchor, same options-arg shape (`entryPoint ? { entryPoint } : undefined`)
  // as the prior internal call so the existing recipe-anchored
  // useRiffSession tests stay green. recipeId fallback "" keeps Hook Rules
  // call-count stable when the route is entered without an id; the
  // !recipeId early return below prevents the controller from ever being
  // exercised in that path.
  const session = useRiffSession(
    recipeId ?? "",
    entryPoint ? { entryPoint } : undefined,
  );

  if (!recipeId) {
    return (
      <Screen style={s.centered}>
        <Text style={s.errorText}>Invalid recipe ID.</Text>
      </Screen>
    );
  }

  if (isLoading) {
    return (
      <Screen style={s.centered}>
        <LoadingState message="Loading recipe…" />
      </Screen>
    );
  }

  if (error || !recipe) {
    return (
      <Screen style={s.centered}>
        <ErrorState
          message={error?.message ?? "Failed to load recipe."}
          onRetry={refetch}
        />
      </Screen>
    );
  }

  return (
    <Screen style={s.container}>
      <KeyboardAvoidingView
        style={s.kav}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <View style={s.header}>
          {/* Issue 1: close is protected during the critical save window
              (save-time mapping added seconds to the request). Disabled,
              not hidden: the modal stays put until the save settles. */}
          <Pressable
            onPress={() => {
              if (session.isSaving) return;
              router.back();
            }}
            disabled={session.isSaving}
            hitSlop={16}
            accessibilityRole="button"
            accessibilityState={{ disabled: session.isSaving }}
            accessibilityLabel="Close riff"
          >
            <Text
              style={[s.closeText, session.isSaving && s.closeTextDisabled]}
            >
              {"✕"}
            </Text>
          </Pressable>
          <Text style={s.headerTitle} numberOfLines={1}>
            {recipe.title}
          </Text>
        </View>
        <RiffChat
          session={session}
          initialDraft={initialDraft}
          showSaveCta={showSaveCta}
        />
      </KeyboardAvoidingView>
    </Screen>
  );
}

function createStyles(palette: ThemePalette, insets: EdgeInsets) {
  return StyleSheet.create({
    centered: {
      flex: 1,
      justifyContent: "center",
      alignItems: "center",
    },
    container: {
      flex: 1,
      paddingHorizontal: spacing.screen,
    },
    kav: {
      flex: 1,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      paddingTop: insets.top + spacing.base,
      paddingBottom: spacing.base,
      gap: spacing.base,
    },
    headerTitle: {
      fontFamily: fonts.heading,
      fontSize: fontSize.md,
      color: palette.text1,
      flex: 1,
    },
    closeText: {
      fontFamily: fonts.body,
      fontSize: fontSize.xl,
      color: palette.text3,
    },
    // Build 4 (C4): header-control disabled convention (see the
    // recipe-detail Edit entry): the glyph visibly dims while disabled.
    closeTextDisabled: {
      opacity: 0.4,
    },
    errorText: {
      fontFamily: fonts.body,
      color: palette.error,
      textAlign: "center",
    },
  });
}
