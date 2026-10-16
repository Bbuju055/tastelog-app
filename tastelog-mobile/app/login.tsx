import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
} from "react-native";
import { useSession } from "../lib/auth/context";
import { Button } from "../components";
import { apiErrorMessage } from "../lib/apiErrorMessage";
import { hapticSuccess, hapticWarning } from "../lib/haptics/haptics";
import { fonts, fontSize, spacing, radius } from "../theme";
import type { ThemePalette } from "../theme/palettes";
import { useTheme, useScreenTheme } from "../theme/ThemeProvider";

type Mode = "signin" | "signup";

export default function LoginScreen() {
  useScreenTheme("light");
  const { palette, theme } = useTheme();
  const { signIn, signUp, resetPassword } = useSession();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit() {
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setError("Email and password are required.");
      return;
    }

    setError(null);
    setSuccessMessage(null);
    setIsSubmitting(true);

    try {
      if (mode === "signin") {
        await signIn(trimmedEmail, password);
      } else {
        const result = await signUp(trimmedEmail, password);
        if (!result.sessionCreated) {
          // No session was created, so the AuthGate will not navigate — say
          // so instead of silently staying on the form.
          //
          // This branch covers two outcomes we deliberately CANNOT tell
          // apart: a genuine new sign-up awaiting email confirmation, and an
          // existing confirmed account, for which Supabase returns an
          // obfuscated user and no error precisely so the response cannot be
          // used to test whether an email is registered. The copy therefore
          // asserts no account was created, reveals nothing about existence,
          // states the next action, and offers sign-in as recovery.
          setMode("signin");
          setSuccessMessage(
            "Check your email to continue. If no message arrives, try signing in.",
          );
        }
      }

      hapticSuccess();
    } catch (err) {
      hapticWarning();
      setError(apiErrorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleForgotPassword() {
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setSuccessMessage(null);
      setError("Enter your email to reset your password.");
      hapticWarning();
      return;
    }

    setError(null);
    setSuccessMessage(null);
    setIsSubmitting(true);

    try {
      await resetPassword(trimmedEmail);
      hapticSuccess();
      setSuccessMessage("Password reset email sent. Check your inbox.");
    } catch (err) {
      hapticWarning();
      setError(apiErrorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  const isSignUp = mode === "signup";
  const kbAppearance = theme === "dark" ? "dark" : "light";
  const s = createStyles(palette);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={s.container}
    >
      <View style={s.inner}>
        <Text style={s.title}>Tastelog</Text>

        {error && <Text style={s.error}>{error}</Text>}

        {successMessage && (
          <Text style={s.success}>{successMessage}</Text>
        )}

        <TextInput
          placeholder="Email"
          placeholderTextColor={palette.text4}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          keyboardAppearance={kbAppearance}
          editable={!isSubmitting}
          style={s.input}
        />

        <TextInput
          placeholder="Password"
          placeholderTextColor={palette.text4}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete="password"
          keyboardAppearance={kbAppearance}
          editable={!isSubmitting}
          onSubmitEditing={handleSubmit}
          style={[s.input, { marginBottom: spacing.xl }]}
        />

        <Button
          title={isSignUp ? "Create Account" : "Sign In"}
          onPress={handleSubmit}
          loading={isSubmitting}
        />

        {!isSignUp && (
          <Pressable
            onPress={handleForgotPassword}
            disabled={isSubmitting}
            style={s.linkButton}
          >
            <Text style={s.linkTextMuted}>Forgot Password?</Text>
          </Pressable>
        )}

        <Pressable
          onPress={() => {
            setMode(isSignUp ? "signin" : "signup");
            setError(null);
            setSuccessMessage(null);
          }}
          disabled={isSubmitting}
          style={s.linkButton}
        >
          <Text style={s.linkTextAccent}>
            {isSignUp
              ? "Already have an account? Sign In"
              : "Don't have an account? Create Account"}
          </Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function createStyles(palette: ThemePalette) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: palette.bg,
    },
    inner: {
      flex: 1,
      justifyContent: "center",
      paddingHorizontal: spacing.screen,
    },
    title: {
      fontFamily: fonts.heading,
      fontSize: fontSize.hero,
      color: palette.text1,
      textAlign: "center",
      marginBottom: spacing.xxl,
      letterSpacing: -0.5,
    },
    error: {
      fontFamily: fonts.body,
      fontSize: fontSize.base,
      color: palette.error,
      marginBottom: spacing.base,
      textAlign: "center",
    },
    success: {
      fontFamily: fonts.body,
      fontSize: fontSize.base,
      color: palette.success,
      marginBottom: spacing.base,
      textAlign: "center",
    },
    input: {
      backgroundColor: palette.card,
      borderWidth: 1,
      borderColor: palette.border,
      borderRadius: radius.md,
      padding: spacing.md,
      marginBottom: spacing.md,
      fontSize: fontSize.base,
      fontFamily: fonts.body,
      color: palette.text1,
    },
    linkButton: {
      marginTop: spacing.md,
      alignItems: "center" as const,
    },
    linkTextMuted: {
      fontFamily: fonts.body,
      fontSize: fontSize.base,
      color: palette.text3,
    },
    linkTextAccent: {
      fontFamily: fonts.body,
      fontSize: fontSize.base,
      color: palette.accent,
    },
  });
}
