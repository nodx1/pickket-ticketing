import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useColorScheme } from "react-native";

export default function RootLayout() {
  const colorScheme = useColorScheme();

  return (
    <>
      <StatusBar style={colorScheme === "dark" ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerStyle: {
            backgroundColor: colorScheme === "dark" ? "#0a0a0a" : "#ffffff",
          },
          headerTintColor: colorScheme === "dark" ? "#ffffff" : "#0a0a0a",
          headerTitleStyle: { fontWeight: "600" },
          contentStyle: {
            backgroundColor: colorScheme === "dark" ? "#0a0a0a" : "#f5f5f5",
          },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="event/[id]" options={{ title: "이벤트 상세" }} />
        <Stack.Screen
          name="auth"
          options={{ title: "로그인", presentation: "modal" }}
        />
      </Stack>
    </>
  );
}
