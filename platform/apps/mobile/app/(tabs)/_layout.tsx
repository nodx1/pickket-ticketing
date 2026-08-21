import { Tabs } from "expo-router";
import { useColorScheme } from "react-native";

export default function TabLayout() {
  const colorScheme = useColorScheme();
  const active = colorScheme === "dark" ? "#7c3aed" : "#6d28d9";
  const inactive = colorScheme === "dark" ? "#6b7280" : "#9ca3af";
  const bg = colorScheme === "dark" ? "#0a0a0a" : "#ffffff";

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: active,
        tabBarInactiveTintColor: inactive,
        tabBarStyle: {
          backgroundColor: bg,
          borderTopColor: colorScheme === "dark" ? "#1f1f1f" : "#e5e5e5",
        },
        headerStyle: { backgroundColor: bg },
        headerTintColor: colorScheme === "dark" ? "#ffffff" : "#0a0a0a",
      }}
    >
      <Tabs.Screen name="index" options={{ title: "홈", tabBarLabel: "홈" }} />
      <Tabs.Screen
        name="search"
        options={{ title: "검색", tabBarLabel: "검색" }}
      />
      <Tabs.Screen
        name="tickets"
        options={{ title: "티켓", tabBarLabel: "티켓" }}
      />
      <Tabs.Screen
        name="profile"
        options={{ title: "프로필", tabBarLabel: "프로필" }}
      />
    </Tabs>
  );
}
