import { View, Text } from "react-native";
import { Button } from "./Button";
import { fonts, fontSize, spacing } from "../theme";
import { useTheme } from "../theme/ThemeProvider";

type EmptyStateProps = {
  message: string;
  action?: {
    title: string;
    onPress: () => void;
  };
};

export function EmptyState({ message, action }: EmptyStateProps) {
  const { palette } = useTheme();
  return (
    <View
      style={{
        justifyContent: "center",
        alignItems: "center",
        padding: spacing.xl,
      }}
    >
      <Text
        style={{
          color: palette.text3,
          fontSize: fontSize.base,
          fontFamily: fonts.body,
          textAlign: "center",
        }}
      >
        {message}
      </Text>
      {action ? (
        <View style={{ marginTop: spacing.base }}>
          <Button
            title={action.title}
            onPress={action.onPress}
            variant="outline"
          />
        </View>
      ) : null}
    </View>
  );
}
