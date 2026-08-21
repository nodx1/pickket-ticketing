import { View, Text, useColorScheme } from "react-native";

export default function TicketsScreen() {
  const isDark = useColorScheme() === "dark";

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: isDark ? "#0a0a0a" : "#f5f5f5",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <Text style={{ fontSize: 40, marginBottom: 12 }}>🎫</Text>
      <Text
        style={{
          fontSize: 16,
          fontWeight: "600",
          color: isDark ? "#ffffff" : "#0a0a0a",
        }}
      >
        내 티켓
      </Text>
      <Text
        style={{
          fontSize: 13,
          color: isDark ? "#6b7280" : "#9ca3af",
          marginTop: 4,
          textAlign: "center",
        }}
      >
        로그인 후 구매한 티켓을 확인할 수 있습니다
      </Text>
    </View>
  );
}
