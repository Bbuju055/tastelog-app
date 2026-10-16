import { useState, useEffect } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Screen, Button } from "../../../../components";
import { hapticTap } from "../../../../lib/haptics/haptics";
import { useLogCook } from "../../../../lib/hooks/useLogCook";
import { useDeleteCookEvent } from "../../../../lib/hooks/useDeleteCookEvent";
import { useSession } from "../../../../lib/auth/context";
import { useRecipe } from "../../../../lib/hooks";
import { fonts, fontSize, radius, spacing } from "../../../../theme";
import type { ThemePalette } from "../../../../theme/palettes";
import { useTheme, useScreenTheme } from "../../../../theme/ThemeProvider";

const STAR_COUNT = 5;

export default function CookLogModal() {
  useScreenTheme("light");
  const { palette, theme } = useTheme();
  const s = createStyles(palette);

  const { id, from, scale, editEventId, rating: ratingParam, notes: notesParam } =
    useLocalSearchParams<{
      id?: string;
      from?: string;
      scale?: string;
      editEventId?: string;
      rating?: string;
      notes?: string;
    }>();
  const recipeId = typeof id === "string" ? id : undefined;
  const fromCooking = from === "cooking";
  const scaleParam = typeof scale === "string" && scale.trim() ? scale : undefined;
  const isEditMode = typeof editEventId === "string" && editEventId.length > 0;
  const router = useRouter();
  const { session } = useSession();
  const userId = session?.user?.id;

  const { data: recipe } = useRecipe(recipeId);
  const logMutation = useLogCook();
  const deleteMutation = useDeleteCookEvent();
  const isMutating = logMutation.isPending || deleteMutation.isPending;

  const [rating, setRating] = useState<number | null>(null);
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!isEditMode) return;

    if (ratingParam) {
      const parsed = parseInt(ratingParam, 10);
      if (parsed >= 1 && parsed <= 5) {
        setRating(parsed);
      }
    }

    if (notesParam) {
      setNotes(notesParam);
    }
  }, [isEditMode, ratingParam, notesParam]);

  function dismiss() {
    if (fromCooking) {
      router.dismiss(2);
    } else {
      router.back();
    }
  }

  function handleSkip() {
    dismiss();
  }

  function handleLog() {
    if (!recipeId || !userId || isMutating) return;

    const logVars = {
      recipeId,
      recipeTitle: recipe?.title ?? "Untitled",
      userId,
      ...(rating !== null ? { rating } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      ...(scaleParam ? { scale: scaleParam } : {}),
    };

    if (isEditMode) {
      if (!editEventId) return;

      deleteMutation.mutate(
        { cookEventId: editEventId, recipeId },
        {
          onSuccess: () => {
            logMutation.mutate(logVars, { onSuccess: dismiss });
          },
        },
      );
    } else {
      logMutation.mutate(logVars, { onSuccess: dismiss });
    }
  }

  function handleStarPress(star: number) {
    hapticTap();
    setRating((prev) => (prev === star ? null : star));
  }

  if (!recipeId) {
    return (
      <Screen style={s.centered}>
        <Text style={s.errorText}>Invalid recipe ID.</Text>
      </Screen>
    );
  }

  return (
    <Screen style={s.container}>
      {/* Header */}
      <View style={s.header}>
        <Text style={s.headerTitle}>{isEditMode ? "Edit cook" : "Log this cook"}</Text>
        <Pressable onPress={handleSkip} hitSlop={12}>
          <Text style={s.skipText}>Skip</Text>
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={s.scrollContent}
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
      >
        {/* Star rating */}
        <Text style={s.fieldLabel}>How was it?</Text>
        <View style={s.starRow}>
          {Array.from({ length: STAR_COUNT }, (_, i) => {
            const star = i + 1;
            const filled = rating !== null && star <= rating;
            return (
              <Pressable
                key={star}
                onPress={() => handleStarPress(star)}
                hitSlop={4}
                accessibilityRole="button"
                accessibilityLabel={`${star} star${star > 1 ? "s" : ""}`}
                accessibilityState={{ selected: filled }}
              >
                <Text style={[s.star, filled && s.starFilled]}>
                  {filled ? "\u2605" : "\u2606"}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* Notes */}
        <Text style={s.fieldLabel}>Notes</Text>
        <TextInput
          style={s.notesInput}
          value={notes}
          onChangeText={setNotes}
          placeholder="Any changes? How did it go?"
          placeholderTextColor={palette.text4}
          multiline
          textAlignVertical="top"
          maxLength={1000}
          keyboardAppearance={theme === "dark" ? "dark" : "light"}
          returnKeyType="done"
          blurOnSubmit
        />

        {/* Scale display (read-only, from route param) */}
        {scaleParam && (
          <View style={s.scaleRow}>
            <Text style={s.scaleLabel}>Scale</Text>
            <Text style={s.scaleValue}>{scaleParam}</Text>
          </View>
        )}

        {/* Log button */}
        <Button
          title={isEditMode ? "Update" : "Log"}
          onPress={handleLog}
          loading={isMutating}
          accessibilityLabel={
            isMutating
              ? (isEditMode ? "Updating cook event" : "Logging cook event")
              : (isEditMode ? "Update cook event" : "Log cook event")
          }
        />
      </ScrollView>
    </Screen>
  );
}

function createStyles(palette: ThemePalette) {
  return StyleSheet.create({
    centered: {
      flex: 1,
      justifyContent: "center",
      alignItems: "center",
    },
    errorText: {
      fontFamily: fonts.body,
      color: palette.error,
      textAlign: "center",
    },
    container: {
      flex: 1,
      paddingHorizontal: spacing.screen,
    },
    header: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingVertical: spacing.base,
    },
    headerTitle: {
      fontFamily: fonts.heading,
      fontSize: fontSize.xl,
      color: palette.text1,
      letterSpacing: -0.3,
    },
    skipText: {
      fontFamily: fonts.bodyMedium,
      fontSize: fontSize.base,
      color: palette.text3,
    },
    scrollContent: {
      paddingTop: spacing.lg,
      paddingBottom: spacing.xxxl,
    },
    fieldLabel: {
      fontFamily: fonts.bodySemiBold,
      fontSize: fontSize.sm,
      color: palette.text3,
      marginBottom: spacing.sm,
      letterSpacing: 0.2,
    },
    starRow: {
      flexDirection: "row",
      gap: spacing.md,
      marginBottom: spacing.xl,
    },
    star: {
      fontSize: fontSize.xxl,
      color: palette.starEmpty,
    },
    starFilled: {
      color: palette.star,
    },
    notesInput: {
      backgroundColor: palette.card,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: palette.border,
      paddingHorizontal: spacing.base,
      paddingVertical: spacing.md,
      fontSize: fontSize.base,
      fontFamily: fonts.body,
      color: palette.text1,
      maxHeight: 160,
      marginBottom: spacing.xl,
    },
    scaleRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      marginBottom: spacing.xl,
    },
    scaleLabel: {
      fontFamily: fonts.bodySemiBold,
      fontSize: fontSize.sm,
      color: palette.text3,
    },
    scaleValue: {
      fontFamily: fonts.body,
      fontSize: fontSize.base,
      color: palette.text2,
    },
  });
}
