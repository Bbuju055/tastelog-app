import { View, Text } from "react-native";
import { Button } from "./Button";
import { fonts, fontSize, spacing } from "../theme";
import { useTheme } from "../theme/ThemeProvider";

type ErrorStateProps = {
  message: string;
  onRetry: () => void;
};

export function ErrorState({ message, onRetry }: ErrorStateProps) {
  const { palette } = useTheme();
  return (
    <View
      style={{
        flex: 1,
        justifyContent: "center",
        alignItems: "center",
        padding: spacing.xl,
      }}
    >
      <Text
        style={{
          color: palette.error,
          fontSize: fontSize.base,
          fontFamily: fonts.body,
          marginBottom: spacing.md,
          textAlign: "center",
        }}
      >
        {message}
      </Text>
      <Button title="Retry" onPress={onRetry} variant="outline" />
    </View>
  );
}
