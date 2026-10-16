import { useCallback } from "react";
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
import { useQueryClient } from "@tanstack/react-query";
import { ErrorState, LoadingState, Screen } from "../../../../components";
import { RiffChat } from "../../../../components/RiffChat";
import { useDraft } from "../../../../lib/hooks/useDraft";
import { useDraftRiffSession } from "../../../../lib/hooks/useDraftRiffSession";
import { apiErrorMessage } from "../../../../lib/apiErrorMessage";
import { DRAFTS_QUERY_KEY, RECIPES_QUERY_KEY } from "../../../../lib/queryKeys";
import type { ThemePalette } from "../../../../theme/palettes";
import { useScreenTheme, useTheme } from "../../../../theme/ThemeProvider";
import { fonts, fontSize, spacing } from "../../../../theme";

/**
 * Phase 13.9 Slice H — Draft Riff Compose Surface.
 *
 * Sibling of `app/(app)/recipe/riff/[id].tsx`, mounted as a `fullScreenModal`
 * via `_layout.tsx`. Owns the close affordance, draft-title header,
 * KeyboardAvoidingView wrapper, and the `useDraftRiffSession` controller.
 *
 * On save success (2xx OR 409 ALREADY_SAVED idempotent retry per
 * docs/capture-draft-riff-contract.md §9.1), invalidate
 * RECIPES_QUERY_KEY + DRAFTS_QUERY_KEY and `router.replace` to the new
 * recipe — the draft has been deleted server-side; leaving it in the
 * back-stack would be incorrect.
 */
export default function DraftRiffScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const draftId = typeof id === "string" ? id : undefined;
  const router = useRouter();
  const queryClient = useQueryClient();

  useScreenTheme("light");
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const s = createStyles(palette, insets);

  const { data: draft, error, isLoading, refetch } = useDraft(draftId);

  // Contract §9.1 — save success path. Fires for normal 2xx saves and for
  // 409 ALREADY_SAVED (translated by useDraftRiffSession from idempotent
  // server response). Both branches must land the user on the saved recipe.
  const handleSaveSuccess = useCallback(
    (newRecipeId: string) => {
      void queryClient.invalidateQueries({ queryKey: RECIPES_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: DRAFTS_QUERY_KEY });
      router.replace({
        pathname: "/(app)/recipe/[id]",
        params: { id: newRecipeId },
      });
    },
    [queryClient, router],
  );

  // Contract §11 — entry_point locked to "draft_review". draftId fallback ""
  // keeps Hook Rules call-count stable when the route is entered without an
  // id; the !draftId early return below prevents the controller from being
  // exercised in that path.
  const session = useDraftRiffSession(draftId ?? "", {
    entryPoint: "draft_review",
    onSaveSuccess: handleSaveSuccess,
  });

  if (!draftId) {
    return (
      <Screen style={s.centered}>
        <Text style={s.errorText}>Invalid draft ID.</Text>
      </Screen>
    );
  }

  if (isLoading) {
    return (
      <Screen style={s.centered}>
        <LoadingState message="Loading draft…" />
      </Screen>
    );
  }

  if (error || !draft) {
    return (
      <Screen style={s.centered}>
        <ErrorState
          message={error ? apiErrorMessage(error) : "Failed to load draft."}
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
            {draft.title}
          </Text>
        </View>
        <RiffChat session={session} />
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
