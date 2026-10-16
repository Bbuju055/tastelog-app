/**
 * RiffChat — Phase 13.1 conversational adaptation surface.
 *
 * Anchored to a single recipe. Sends user turns to POST /api/recipes/{id}/riff
 * and shows the assistant reply inline. Session + message state is in-memory
 * via useRiffSession — no persistence, no query cache.
 *
 * Phase 13.3: refactored to render as a full-height column. Mounted by
 * app/(app)/recipe/riff/[id].tsx — the screen owns the close affordance,
 * recipe title header, and KeyboardAvoidingView wrapper.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextStyle,
  type ViewStyle,
} from "react-native";

import type { RiffSessionController } from "../lib/hooks/useRiffSession";
import { isApiError } from "../lib/errors";
import { hapticTap } from "../lib/haptics/haptics";
import { fonts, fontSize, lineHeight, radius, spacing } from "../theme";
import { Button } from "./Button";
import type { ThemePalette } from "../theme/palettes";
import { useTheme } from "../theme/ThemeProvider";

type RiffChatProps = {
  // Phase 13.9 Slice H — controller-injected. The route screen owns the
  // anchor-specific hook call (useRiffSession for recipes,
  // useDraftRiffSession for drafts) and passes the resulting controller
  // here. RiffChat is anchor-agnostic per contract §8.2.
  session: RiffSessionController;
  initialDraft?: string;
  showSaveCta?: boolean;
};

export function RiffChat({
  session,
  initialDraft,
  showSaveCta = true,
}: RiffChatProps) {
  const { palette } = useTheme();
  const s = useMemo(() => createStyles(palette), [palette]);

  const {
    messages,
    sendMessage,
    isLoading,
    error,
    savedMessageIds,
    saveRecipe,
    // Issue 1: save-time mapping added seconds to the save request, so the
    // pending state is now rendered (Saving… + duplicate suppression).
    isSaving,
    // 13.5 additions
    currentPartialAssistantMessage,
    isStreaming,
    cancel,
  } = session;
  const [input, setInput] = useState(initialDraft ?? "");
  const scrollRef = useRef<ScrollView | null>(null);

  const trimmed = input.trim();
  const canSend = trimmed.length > 0 && !isLoading;

  // Scroll to newest message as the list grows or a pending turn resolves.
  // currentPartialAssistantMessage is included so the partial bubble stays
  // in view as it grows during streaming (Phase 13.5).
  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [messages.length, isLoading, currentPartialAssistantMessage]);

  const handleSend = () => {
    if (!canSend) return;
    sendMessage(trimmed);
    setInput("");
    Keyboard.dismiss();
  };

  // Issue 2 (C10): when the client can know why the turn failed, say so.
  // 429 = the Phase 13.7 daily riff cap; 401 = expired session. Everything
  // else keeps the existing generic copy. No auto sign-out, no pre-checks.
  const errorCopy = (() => {
    if (!error) return null;
    if (isApiError(error) && error.status === 429) {
      return "Daily riff limit reached. Try again tomorrow.";
    }
    if (isApiError(error) && error.status === 401) {
      return "Your session has expired. Sign in again to riff.";
    }
    return "Couldn’t reach the assistant. Try again in a moment.";
  })();

  // First user message of the session, truncated to 40 chars, used as the
  // Alert.prompt default when saving. Memoized over messages.
  const firstUserMessageLabel = useMemo(() => {
    const first = messages.find((m) => m.role === "user");
    if (!first) return "";
    return first.content.length > 40
      ? first.content.slice(0, 40)
      : first.content;
  }, [messages]);

  const handleSavePress = (messageId: string) => {
    // Synchronous duplicate-save guard (Issue 1): while a save is pending
    // the prompt never re-opens, mirroring the hook-level isPending guard.
    if (isSaving) return;
    // Alert.prompt is iOS-only — matches the existing 4.2.G grocery-rename
    // pattern. Android handling is a documented V1 limitation.
    Alert.prompt(
      "Save to Cookbook",
      "Add a label for this variation (optional).",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Save",
          onPress: (text?: string) => {
            // Server trims and null-coerces; client passes raw or null.
            saveRecipe(messageId, text ?? null);
          },
        },
      ],
      "plain-text",
      firstUserMessageLabel,
    );
  };

  return (
    <View style={s.root}>
      <ScrollView
        ref={scrollRef}
        style={s.messagesContainer}
        contentContainerStyle={s.messagesContent}
        keyboardShouldPersistTaps="handled"
      >
        {messages.map((m, idx) => {
          const messageHasSaveCta =
            showSaveCta &&
            m.role === "assistant" &&
            m.id != null &&
            m.generatedRecipe !== null;
          const isSaved = m.id != null && savedMessageIds.has(m.id);
          const hasVisibleContent = (m.content ?? "").trim().length > 0;
          return (
            <View key={idx}>
              {hasVisibleContent && (
                <View
                  style={[
                    s.bubbleRow,
                    m.role === "user" ? s.bubbleRowUser : s.bubbleRowAssistant,
                  ]}
                >
                  <View
                    style={[
                      s.bubble,
                      m.role === "user" ? s.bubbleUser : s.bubbleAssistant,
                    ]}
                  >
                    <Text
                      style={[
                        s.bubbleText,
                        m.role === "user"
                          ? s.bubbleTextUser
                          : s.bubbleTextAssistant,
                      ]}
                    >
                      {m.content}
                    </Text>
                  </View>
                </View>
              )}
              {messageHasSaveCta && !isSaved && (
                <Text style={s.saveBridgeText}>
                  Save the full recipe to your cookbook, then open it from the recipe page or list.
                </Text>
              )}
              {messageHasSaveCta && (
                <Pressable
                  onPress={() => handleSavePress(m.id!)}
                  disabled={isSaved || isSaving}
                  accessibilityRole="button"
                  accessibilityState={{
                    disabled: isSaved || isSaving,
                    busy: isSaving,
                  }}
                  accessibilityLabel={
                    isSaved
                      ? "Recipe saved"
                      : isSaving
                        ? "Saving recipe"
                        : "Save to Cookbook"
                  }
                  hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
                  style={s.saveCta}
                >
                  <Text
                    style={[
                      s.saveCtaText,
                      (isSaved || isSaving) && s.saveCtaTextSaved,
                    ]}
                  >
                    {isSaved
                      ? "Saved ✓"
                      : isSaving
                        ? "Saving…"
                        : "Save to Cookbook"}
                  </Text>
                </Pressable>
              )}
            </View>
          );
        })}
        {/*
         * Phase 13.5 streaming partial bubble. Rendered while a streaming
         * turn is mid-flight. Same styles as a committed assistant
         * bubble — visual distinction (typing indicator, fade-in) is
         * reserved for 13.6 polish. No save CTA: partial messages have
         * no id and no generatedRecipe.
         *
         * `!= null` (loose equality) catches both null and undefined so
         * existing literal hook mocks (which don't yet provide this
         * field) continue to render no partial bubble. Item 6 will
         * extend the mocks to provide the field explicitly.
         */}
        {currentPartialAssistantMessage != null && (
          <View style={[s.bubbleRow, s.bubbleRowAssistant]}>
            <View style={[s.bubble, s.bubbleAssistant]}>
              <Text style={[s.bubbleText, s.bubbleTextAssistant]}>
                {currentPartialAssistantMessage}
              </Text>
            </View>
          </View>
        )}
      </ScrollView>

      {errorCopy && <Text style={s.errorText}>{errorCopy}</Text>}

      <View style={s.composerRow}>
        <TextInput
          style={[s.input, { flex: 1 }]}
          value={input}
          onChangeText={setInput}
          placeholder="Ask for an adaptation…"
          placeholderTextColor={palette.text4}
          multiline
          editable={!isLoading}
          accessibilityLabel="Riff message"
        />
        {isStreaming ? (
          <Pressable
            onPress={() => {
              hapticTap();
              cancel();
            }}
            accessibilityRole="button"
            accessibilityLabel="Stop response"
            style={s.cancelBtn}
          >
            <Text style={s.cancelBtnText}>Stop</Text>
          </Pressable>
        ) : (
          <Button
            title="Send"
            onPress={handleSend}
            disabled={!canSend}
            loading={isLoading}
            size="lg"
            accessibilityLabel="Send message"
          />
        )}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function createStyles(palette: ThemePalette) {
  const root: ViewStyle = {
    flex: 1,
  };
  const messagesContainer: ViewStyle = {
    flex: 1,
  };
  const messagesContent: ViewStyle = {
    padding: spacing.base,
    gap: spacing.base,
    flexGrow: 1,
  };
  const bubbleRow: ViewStyle = {
    flexDirection: "row",
    width: "100%",
  };
  const bubbleRowUser: ViewStyle = {
    justifyContent: "flex-end",
  };
  const bubbleRowAssistant: ViewStyle = {
    justifyContent: "flex-start",
  };
  const bubble: ViewStyle = {
    maxWidth: "85%",
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
  };
  const bubbleUser: ViewStyle = {
    backgroundColor: palette.accent,
  };
  const bubbleAssistant: ViewStyle = {
    backgroundColor: palette.surface,
  };
  const bubbleText: TextStyle = {
    fontFamily: fonts.body,
    fontSize: fontSize.base,
    lineHeight: fontSize.base * lineHeight.normal,
  };
  const bubbleTextUser: TextStyle = {
    color: palette.bg,
  };
  const bubbleTextAssistant: TextStyle = {
    color: palette.text1,
  };
  const input: TextStyle = {
    minHeight: 56,
    maxHeight: 160,
    fontFamily: fonts.body,
    fontSize: fontSize.base,
    color: palette.text1,
    backgroundColor: palette.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: palette.border,
    padding: spacing.base,
    textAlignVertical: "top",
  };
  const errorText: TextStyle = {
    fontFamily: fonts.body,
    fontSize: fontSize.sm,
    color: palette.error,
  };
  const composerRow: ViewStyle = {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: spacing.sm,
    paddingVertical: spacing.base,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: palette.border,
  };
  // 13.5 Cancel button shown in place of Send while a streaming turn is
  // active. Muted surface/border styling — NOT destructive red. Cancel
  // is a normal user action mid-stream, not a danger / destructive op.
  const cancelBtn: ViewStyle = {
    minHeight: 56,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    backgroundColor: palette.surface,
    borderWidth: 1,
    borderColor: palette.border,
    alignItems: "center",
    justifyContent: "center",
  };
  const cancelBtnText: TextStyle = {
    fontFamily: fonts.bodySemiBold,
    fontSize: fontSize.base,
    color: palette.text1,
  };
  const saveBridgeText: TextStyle = {
    fontFamily: fonts.body,
    fontSize: fontSize.sm,
    color: palette.text3,
    marginTop: spacing.xs,
    paddingHorizontal: spacing.sm,
  };
  const saveCta: ViewStyle = {
    marginTop: spacing.xs,
    alignSelf: "flex-start",
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  };
  const saveCtaText: TextStyle = {
    fontFamily: fonts.body,
    fontSize: fontSize.sm,
    color: palette.primary,
  };
  const saveCtaTextSaved: TextStyle = {
    color: palette.text3,
  };

  return {
    root,
    messagesContainer,
    messagesContent,
    bubbleRow,
    bubbleRowUser,
    bubbleRowAssistant,
    bubble,
    bubbleUser,
    bubbleAssistant,
    bubbleText,
    bubbleTextUser,
    bubbleTextAssistant,
    input,
    errorText,
    composerRow,
    cancelBtn,
    cancelBtnText,
    saveBridgeText,
    saveCta,
    saveCtaText,
    saveCtaTextSaved,
  };
}
