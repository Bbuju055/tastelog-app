import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Easing, View } from "react-native";
import { fonts, fontSize, motion } from "../../../theme";
import { useTheme } from "../../../theme/ThemeProvider";
import { useReducedMotion } from "../../../lib/hooks";

function TabIcon({
  name,
  color,
  focused,
}: {
  name: React.ComponentProps<typeof Ionicons>["name"];
  color: string;
  focused: boolean;
}) {
  const { palette } = useTheme();
  return (
    <View style={{ alignItems: "center", paddingTop: 2 }}>
      {focused && (
        <View
          style={{
            position: "absolute",
            top: -8,
            width: 24,
            height: 3,
            borderRadius: 1.5,
            backgroundColor: palette.primary,
          }}
        />
      )}
      <Ionicons name={name} size={20} color={color} />
    </View>
  );
}

export default function TabsLayout() {
  const { palette } = useTheme();
  const reduceMotion = useReducedMotion();
  return (
    <Tabs
      screenOptions={{
        // 15.1.4 — tab scene cross-fade. The spec is omitted via conditional
        // spread under reduced motion: bottom-tabs runs a supplied
        // transitionSpec even when animation is "none" (phantom timing +
        // delayed transitionEnd); an absent spec gets the 0ms "none" preset.
        animation: reduceMotion ? "none" : "fade",
        ...(reduceMotion
          ? {}
          : {
              transitionSpec: {
                animation: "timing" as const,
                config: {
                  duration: motion.duration.base,
                  easing: Easing.bezier(...motion.easing.inOut),
                },
              },
            }),
        headerStyle: { backgroundColor: palette.surface },
        headerTintColor: palette.text1,
        headerTitleStyle: { fontFamily: fonts.bodySemiBold },
        headerShadowVisible: false,
        tabBarStyle: {
          backgroundColor: palette.tabBarBg,
          borderTopColor: palette.tabBarBorder,
          borderTopWidth: 1,
        },
        tabBarActiveTintColor: palette.primary,
        tabBarInactiveTintColor: palette.text4,
        tabBarLabelStyle: {
          fontFamily: fonts.bodyMedium,
          fontSize: fontSize.sm,
          letterSpacing: 0.3,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Recipes",
          headerShown: false,
          tabBarLabel: "Recipes",
          tabBarIcon: ({ color, focused }) => (
            <TabIcon
              name={focused ? "book" : "book-outline"}
              color={color}
              focused={focused}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="grocery"
        options={{
          title: "Grocery",
          tabBarLabel: "Grocery",
          tabBarIcon: ({ color, focused }) => (
            <TabIcon
              name={focused ? "cart" : "cart-outline"}
              color={color}
              focused={focused}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="add"
        options={{
          title: "Add",
          tabBarLabel: "Add",
          tabBarIcon: ({ color, focused }) => (
            <TabIcon
              name={focused ? "add-circle" : "add-circle-outline"}
              color={color}
              focused={focused}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarLabel: "Settings",
          tabBarIcon: ({ color, focused }) => (
            <TabIcon
              name={focused ? "settings" : "settings-outline"}
              color={color}
              focused={focused}
            />
          ),
        }}
      />
    </Tabs>
  );
}
