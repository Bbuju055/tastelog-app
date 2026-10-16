import { View, ActivityIndicator, Text } from "react-native";
import { fonts, fontSize, spacing } from "../theme";
import { useTheme } from "../theme/ThemeProvider";

type LoadingStateProps = {
  message?: string;
};

export function LoadingState({ message }: LoadingStateProps) {
  const { palette } = useTheme();
  return (
    <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
      <ActivityIndicator size="large" color={palette.text3} />
      {message ? (
        <Text
          style={{
            color: palette.text3,
            marginTop: spacing.md,
            fontSize: fontSize.base,
            fontFamily: fonts.body,
          }}
        >
          {message}
        </Text>
      ) : null}
    </View>
  );
}
