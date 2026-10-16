import type { ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { spacing } from "../theme";
import { useTheme } from "../theme/ThemeProvider";

type ScreenProps = {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
};

export function Screen({ children, style }: ScreenProps) {
  const { palette } = useTheme();
  return (
    <SafeAreaView
      style={[
        { flex: 1, paddingHorizontal: spacing.screen, backgroundColor: palette.bg },
        style,
      ]}
    >
      {children}
    </SafeAreaView>
  );
}
