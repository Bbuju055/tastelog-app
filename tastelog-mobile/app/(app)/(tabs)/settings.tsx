import { useState, useCallback, useEffect, useSyncExternalStore } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
  Alert,
  TextInput,
  StyleSheet,
} from "react-native";
import { type Href, useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listCaptureTokens,
  revokeCaptureToken,
} from "../../../lib/api/endpoints";
import {
  removeCaptureToken,
  getCaptureTokenId,
} from "../../../lib/auth/storage";
import { provisionAndStoreCaptureToken } from "../../../lib/auth/tokenOrchestrator";
import { Button } from "../../../components";
import { hapticTap } from "../../../lib/haptics/haptics";
// Deep import (Issue 2, section 5.1 rule): the guard must stay real in
// suites that mock the lib/hooks barrel as object literals.
import { useNavigationGuard } from "../../../lib/hooks/useNavigationGuard";
// Build 5 Class B diagnostic (section 4.B.12): flag-gated export rows.
import {
  isNavDiagnosticsEnabled,
  navDiagnostics,
} from "../../../lib/diagnostics/navTrace";
import { apiErrorMessage } from "../../../lib/apiErrorMessage";
import { TOKENS_QUERY_KEY } from "../../../lib/queryKeys";
import { env } from "../../../lib/config";
import { useSession } from "../../../lib/auth/context";
import { fonts, fontSize, spacing, radius, shadows } from "../../../theme";
import type { ThemePalette } from "../../../theme/palettes";
import {
  useTheme,
  useScreenTheme,
  type ThemePreference,
} from "../../../theme/ThemeProvider";
import type { CaptureTokenResponse } from "../../../lib/api/schemas";

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export default function SettingsScreen() {
  useScreenTheme("light");
  const { palette, theme, preference, setPreference } = useTheme();
  const router = useRouter();
  const { signOut } = useSession();
  const queryClient = useQueryClient();
  // Build 4 (C3): duplicate-activation guard for the How Tastelog Works
  // push. Unlocks on focus regain when that screen pops.
  const navGuard = useNavigationGuard();

  const { data: tokens, isLoading, error, refetch } = useQuery({
    queryKey: TOKENS_QUERY_KEY,
    queryFn: () => listCaptureTokens(),
  });

  const [tokenName, setTokenName] = useState("");
  const [createdPlaintext, setCreatedPlaintext] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isRevoking, setIsRevoking] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [storedTokenId, setStoredTokenId] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    getCaptureTokenId().then((id) => {
      if (mounted) setStoredTokenId(id);
    });
    return () => {
      mounted = false;
    };
  }, []);

  const handleCreate = useCallback(async () => {
    const trimmed = tokenName.trim();
    if (!trimmed) {
      setActionError("Token name is required.");
      return;
    }

    setActionError(null);
    setIsCreating(true);

    try {
      const result = await provisionAndStoreCaptureToken(trimmed);
      if (!result.success) {
        setActionError(result.error);
        return;
      }
      setStoredTokenId(result.tokenId);
      setCreatedPlaintext(result.token);
      setTokenName("");
      await queryClient.invalidateQueries({ queryKey: TOKENS_QUERY_KEY });
    } catch (err) {
      setActionError(apiErrorMessage(err));
    } finally {
      setIsCreating(false);
    }
  }, [tokenName, queryClient]);

  const handleRevoke = useCallback(
    async (token: CaptureTokenResponse) => {
      Alert.alert(
        "Revoke Token",
        `Revoke "${token.name}"? This cannot be undone.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Revoke",
            style: "destructive",
            onPress: async () => {
              setIsRevoking(token.id);
              setActionError(null);
              try {
                await revokeCaptureToken(token.id);
                const currentStoredId = await getCaptureTokenId();
                if (currentStoredId && currentStoredId === token.id) {
                  await removeCaptureToken();
                  setStoredTokenId(null);
                }
                await queryClient.invalidateQueries({ queryKey: TOKENS_QUERY_KEY });
              } catch (err) {
                setActionError(apiErrorMessage(err));
              } finally {
                setIsRevoking(null);
              }
            },
          },
        ]
      );
    },
    [queryClient]
  );

  const handleSignOut = useCallback(async () => {
    try {
      await signOut();
    } catch (err) {
      Alert.alert("Sign Out Failed", apiErrorMessage(err));
    }
  }, [signOut]);

  const activeTokens = tokens?.filter((t) => !t.revoked_at) ?? [];
  const s = createStyles(palette);

  // Build 5 Class B diagnostic rows (plan 8.4). Subscribed only while the
  // flag is on; the subscription is a no-op store read otherwise.
  const navDiagEnabled = isNavDiagnosticsEnabled();
  const navDiagStatus = useSyncExternalStore(
    navDiagnostics.subscribe,
    navDiagnostics.getStatus,
  );
  const navDiagRows: { label: string; onPress: () => void }[] = [
    {
      label: "Export last Back failure",
      onPress: () => navDiagnostics.getController()?.exportLastFailure(),
    },
    {
      label: "Export current trace",
      onPress: () => navDiagnostics.getController()?.exportTrace(),
    },
    {
      label: "Delete diagnostic data",
      onPress: () => navDiagnostics.getController()?.deleteData(),
    },
  ];

  return (
    <ScrollView
      contentContainerStyle={s.scrollContent}
      style={{ backgroundColor: palette.bg }}
    >
      {/* ---- Theme ---- */}
      <Text style={s.sectionTitle}>Appearance</Text>
      {/* themeCard keeps overflow:"hidden" for row-highlight clipping, which
          would clip an iOS shadow — so it deliberately gets no shadows.card. */}
      <View style={s.themeCard}>
        {THEME_OPTIONS.map((opt, i) => {
          const isActive = preference === opt.value;
          const isLast = i === THEME_OPTIONS.length - 1;
          return (
            <Pressable
              key={opt.value}
              onPress={() => {
                hapticTap();
                setPreference(opt.value);
              }}
              accessibilityRole="button"
              accessibilityState={{ selected: isActive }}
              accessibilityLabel={`${opt.label}${isActive ? ", selected" : ""}`}
              style={[
                s.themeOptionRow,
                !isLast && s.themeOptionRowDivider,
              ]}
            >
              <Text
                style={[
                  s.themeOptionRowLabel,
                  isActive && s.themeOptionRowLabelActive,
                ]}
              >
                {opt.label}
              </Text>
              {isActive && (
                <Text style={s.themeOptionRowCheck}>{"\u2713"}</Text>
              )}
            </Pressable>
          );
        })}
      </View>

      {/* ---- Token Management ---- */}
      <Text style={s.sectionTitle}>Capture Tokens</Text>

      {storedTokenId ? (
        <Text style={s.statusSuccess}>Device token set</Text>
      ) : (
        <Text style={s.statusMuted}>No device token stored</Text>
      )}

      {actionError && (
        <Text style={s.errorText}>{actionError}</Text>
      )}

      {/* Created token plaintext (shown once) */}
      {createdPlaintext && (
        <View style={s.createdCard}>
          <Text style={s.createdCardTitle}>
            Token created! Copy it now — it won't be shown again.
          </Text>
          <Text style={s.createdCardMono}>
            {createdPlaintext}
          </Text>
          <Pressable
            onPress={() => setCreatedPlaintext(null)}
            style={{ marginTop: spacing.sm }}
          >
            <Text style={s.linkText}>Dismiss</Text>
          </Pressable>
        </View>
      )}

      {/* Create token */}
      <View style={s.createRow}>
        <TextInput
          placeholder="Token name"
          placeholderTextColor={palette.text4}
          value={tokenName}
          onChangeText={setTokenName}
          editable={!isCreating}
          keyboardAppearance={theme === "dark" ? "dark" : "light"}
          style={s.tokenInput}
        />
        <Button
          title="Create"
          onPress={handleCreate}
          disabled={!tokenName.trim()}
          loading={isCreating}
          size="sm"
        />
      </View>

      {/* Token list */}
      {isLoading ? (
        <ActivityIndicator
          color={palette.text3}
          style={{ marginVertical: spacing.base }}
        />
      ) : error ? (
        <View style={{ marginBottom: spacing.base }}>
          <Text style={s.errorText}>{apiErrorMessage(error)}</Text>
          <Pressable onPress={() => refetch()}>
            <Text style={s.linkText}>Retry</Text>
          </Pressable>
        </View>
      ) : activeTokens.length === 0 ? (
        <Text style={s.statusMuted}>No active tokens.</Text>
      ) : (
        activeTokens.map((token) => (
          <View
            key={token.id}
            style={[s.tokenCard, theme === "light" && shadows.card]}
          >
            <View style={{ flex: 1 }}>
              <Text style={s.tokenName}>
                {token.name}
                {storedTokenId === token.id && (
                  <Text style={s.tokenDeviceLabel}> (this device)</Text>
                )}
              </Text>
              <Text style={s.tokenDate}>
                Created: {new Date(token.created_at).toLocaleDateString()}
              </Text>
            </View>
            <Pressable
              onPress={() => handleRevoke(token)}
              disabled={isRevoking === token.id}
            >
              {isRevoking === token.id ? (
                <ActivityIndicator size="small" color={palette.text3} />
              ) : (
                <Text style={s.revokeText}>Revoke</Text>
              )}
            </Pressable>
          </View>
        ))
      )}

      {/* ---- Help ---- */}
      <Text style={[s.sectionTitle, { marginTop: spacing.xxl }]}>
        Help
      </Text>
      <View style={s.themeCard}>
        <Pressable
          onPress={() =>
            navGuard.guard(() => {
              hapticTap();
              // Href cast at the assignment boundary (repo convention):
              // typed-route declarations regenerate on next `expo start`.
              router.push("/(app)/how-it-works" as Href);
            })
          }
          accessibilityRole="button"
          accessibilityLabel="How Tastelog works"
          style={s.themeOptionRow}
        >
          <Text style={s.themeOptionRowLabel}>How Tastelog works</Text>
        </Pressable>
      </View>

      {/* ---- Nav diagnostics (Build 6 diagnostic profile only) ---- */}
      {navDiagEnabled && (
        <>
          <Text style={[s.sectionTitle, { marginTop: spacing.xxl }]}>
            Nav diagnostics
          </Text>
          <View style={s.themeCard}>
            {navDiagRows.map((row, i) => (
              <Pressable
                key={row.label}
                onPress={row.onPress}
                accessibilityRole="button"
                accessibilityLabel={row.label}
                style={[
                  s.themeOptionRow,
                  i < navDiagRows.length - 1 && s.themeOptionRowDivider,
                ]}
              >
                <Text style={s.themeOptionRowLabel}>{row.label}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={s.statusMuted}>
            {`${navDiagStatus.probeLine} | capture ${navDiagStatus.hasLastCapture ? "stored" : "none"}${navDiagStatus.message ? ` | ${navDiagStatus.message}` : ""}`}
          </Text>
        </>
      )}

      {/* ---- Debug (dev builds only; release bundles compile __DEV__ to false,
           and the typeof guard fails closed if the global is ever undeclared) ---- */}
      {typeof __DEV__ !== "undefined" && __DEV__ && (
        <>
          <Text style={[s.sectionTitle, { marginTop: spacing.xxl }]}>
            Debug
          </Text>
          <View style={[s.debugCard, theme === "light" && shadows.card]}>
            <Text style={s.debugText}>
              API: {env.EXPO_PUBLIC_API_BASE_URL}
            </Text>
            <Text style={s.debugText}>
              Web: {env.EXPO_PUBLIC_WEB_BASE_URL ?? "\u2014"}
            </Text>
          </View>
        </>
      )}

      {/* ---- Sign Out ---- */}
      <View style={s.signOutButton}>
        <Button
          title="Sign Out"
          onPress={handleSignOut}
          variant="destructive"
        />
      </View>
    </ScrollView>
  );
}

function createStyles(palette: ThemePalette) {
  return StyleSheet.create({
    scrollContent: {
      paddingTop: spacing.base,
      paddingBottom: spacing.xxxl + spacing.sm,
      paddingHorizontal: spacing.screen,
    },
    sectionTitle: {
      fontFamily: fonts.heading,
      fontSize: fontSize.lg,
      color: palette.text1,
      marginBottom: spacing.sm,
      letterSpacing: -0.2,
    },
    statusSuccess: {
      fontFamily: fonts.body,
      color: palette.success,
      fontSize: fontSize.sm,
      marginBottom: spacing.md,
    },
    statusMuted: {
      fontFamily: fonts.body,
      color: palette.text3,
      fontSize: fontSize.sm,
      marginBottom: spacing.md,
    },
    errorText: {
      fontFamily: fonts.body,
      color: palette.error,
      marginBottom: spacing.md,
    },
    createdCard: {
      backgroundColor: palette.successSoft,
      borderWidth: 1,
      borderColor: palette.success,
      borderRadius: radius.md,
      padding: spacing.md,
      marginBottom: spacing.base,
    },
    createdCardTitle: {
      fontFamily: fonts.bodySemiBold,
      color: palette.text1,
      marginBottom: spacing.xs,
    },
    createdCardMono: {
      fontFamily: "monospace",
      fontSize: fontSize.sm,
      color: palette.text2,
    },
    linkText: {
      fontFamily: fonts.bodySemiBold,
      color: palette.accent,
    },
    createRow: {
      flexDirection: "row",
      gap: spacing.sm,
      marginBottom: spacing.base,
    },
    tokenInput: {
      flex: 1,
      borderWidth: 1,
      borderColor: palette.border,
      borderRadius: radius.md,
      padding: spacing.md,
      fontSize: fontSize.md,
      fontFamily: fonts.body,
      color: palette.text1,
      backgroundColor: palette.card,
    },
    tokenCard: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      backgroundColor: palette.card,
      borderWidth: 1,
      borderColor: palette.border,
      borderRadius: radius.md,
      padding: spacing.md,
      marginBottom: spacing.sm,
    },
    tokenName: {
      fontFamily: fonts.bodySemiBold,
      color: palette.text1,
    },
    tokenDeviceLabel: {
      fontFamily: fonts.body,
      color: palette.success,
    },
    tokenDate: {
      fontFamily: fonts.body,
      color: palette.text3,
      fontSize: fontSize.sm,
    },
    revokeText: {
      fontFamily: fonts.bodySemiBold,
      color: palette.error,
    },
    debugCard: {
      backgroundColor: palette.card,
      borderRadius: radius.md,
      padding: spacing.md,
      marginBottom: spacing.xl,
    },
    debugText: {
      fontFamily: fonts.body,
      fontSize: fontSize.sm,
      color: palette.text2,
      marginBottom: spacing.xs,
    },
    signOutButton: {
      marginBottom: spacing.xxxl,
    },
    themeCard: {
      backgroundColor: palette.card,
      borderWidth: 1,
      borderColor: palette.border,
      borderRadius: radius.md,
      marginBottom: spacing.xl,
      overflow: "hidden",
    },
    themeOptionRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingVertical: spacing.md + 2,
      paddingHorizontal: spacing.base,
      minHeight: 44,
    },
    themeOptionRowDivider: {
      borderBottomWidth: 1,
      borderBottomColor: palette.divider,
    },
    themeOptionRowLabel: {
      fontFamily: fonts.body,
      fontSize: fontSize.md,
      color: palette.text1,
    },
    themeOptionRowLabelActive: {
      fontFamily: fonts.bodySemiBold,
    },
    themeOptionRowCheck: {
      fontFamily: fonts.bodySemiBold,
      fontSize: fontSize.md,
      color: palette.primary,
    },
  });
}
