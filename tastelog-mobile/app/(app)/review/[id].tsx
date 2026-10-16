import { View, Text, Linking, Platform, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { Screen, Button } from "../../../components";
import { RECIPES_QUERY_KEY } from "../../../lib/queryKeys";
// Deep import (Issue 2, section 5.1 rule): the guard must stay real in
// suites that mock the lib/hooks barrel as object literals.
import { useNavigationGuard } from "../../../lib/hooks/useNavigationGuard";
import { env } from "../../../lib/config";
import { fonts, fontSize, spacing, radius } from "../../../theme";
import type { ThemePalette } from "../../../theme/palettes";
import { useTheme, useScreenTheme } from "../../../theme/ThemeProvider";

type ReviewParams = {
  id?: string;
  recipe_id?: string;
  status?: string;
  view_url?: string;
};

export default function ReviewScreen() {
  useScreenTheme("light");
  const { palette } = useTheme();
  const s = createStyles(palette);

  const params = useLocalSearchParams<ReviewParams>();
  const router = useRouter();
  const queryClient = useQueryClient();
  // Build 4 (C3): duplicate-activation guard for the View Recipe push.
  // Declared above the early return so hook order is stable.
  const navGuard = useNavigationGuard();

  const captureId = params.id;
  const recipeId = params.recipe_id?.trim() ? params.recipe_id : null;
  const status = params.status ?? "unknown";
  const viewUrl = params.view_url ?? "";

  if (!captureId) {
    return (
      <Screen style={s.centered}>
        <Text style={s.errorText}>Invalid capture ID.</Text>
      </Screen>
    );
  }

  const STATUS_COLORS: Record<string, string> = {
    complete: palette.success,
    failed: palette.error,
  };

  const statusColor = STATUS_COLORS[status] ?? palette.text3;

  return (
    <Screen>
      <View style={s.content}>
        <Text style={s.title}>Capture Result</Text>

        <View style={s.statusRow}>
          <Text style={s.statusLabel}>Status:</Text>
          <View
            style={[
              s.statusBadge,
              { backgroundColor: statusColor + "1a" },
            ]}
          >
            <Text style={[s.statusText, { color: statusColor }]}>
              {status}
            </Text>
          </View>
        </View>

        <Text style={s.fieldLabel}>Capture ID</Text>
        <Text style={s.fieldValueMono}>{captureId}</Text>

        {recipeId ? (
          <>
            <Text style={s.fieldLabel}>Recipe ID</Text>
            <Text style={[s.fieldValueMono, s.fieldValueMonoLast]}>
              {recipeId}
            </Text>
          </>
        ) : (
          <Text style={s.warningText}>
            No recipe ID returned (capture may have failed).
          </Text>
        )}

        <View style={s.actions}>
          {recipeId ? (
            <Button
              title="View Recipe"
              onPress={() =>
                navGuard.guard(() => {
                  queryClient.invalidateQueries({ queryKey: RECIPES_QUERY_KEY });
                  router.push({
                    pathname: "/(app)/recipe/[id]",
                    params: { id: recipeId },
                  });
                })
              }
            />
          ) : null}

          {env.EXPO_PUBLIC_WEB_BASE_URL && viewUrl ? (
            <Button
              title="Open in Browser"
              onPress={async () => {
                try {
                  const fullUrl = new URL(
                    viewUrl,
                    env.EXPO_PUBLIC_WEB_BASE_URL,
                  ).toString();
                  await Linking.openURL(fullUrl);
                } catch {
                  // Fail silently
                }
              }}
              variant="outline"
            />
          ) : null}
        </View>
      </View>
    </Screen>
  );
}

function createStyles(palette: ThemePalette) {
  return StyleSheet.create({
    centered: {
      justifyContent: "center",
      alignItems: "center",
    },
    content: {
      paddingTop: spacing.xl,
    },
    title: {
      fontFamily: fonts.heading,
      fontSize: fontSize.xl,
      color: palette.text1,
      marginBottom: spacing.base,
      letterSpacing: -0.3,
    },
    statusRow: {
      flexDirection: "row",
      alignItems: "center",
      marginBottom: spacing.base,
    },
    statusLabel: {
      fontFamily: fonts.body,
      fontSize: fontSize.md,
      color: palette.text2,
      marginRight: spacing.sm,
    },
    statusBadge: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
      borderRadius: radius.md,
    },
    statusText: {
      fontFamily: fonts.bodySemiBold,
      fontSize: fontSize.base,
    },
    fieldLabel: {
      fontFamily: fonts.body,
      fontSize: fontSize.sm,
      color: palette.text3,
      marginBottom: spacing.xs,
    },
    fieldValueMono: {
      fontSize: fontSize.base,
      fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
      color: palette.text2,
      marginBottom: spacing.base,
    },
    fieldValueMonoLast: {
      marginBottom: spacing.xl,
    },
    warningText: {
      fontFamily: fonts.body,
      fontSize: fontSize.base,
      color: palette.warning,
      marginBottom: spacing.xl,
    },
    errorText: {
      fontFamily: fonts.body,
      color: palette.error,
      textAlign: "center",
    },
    actions: {
      gap: spacing.md,
    },
  });
}
