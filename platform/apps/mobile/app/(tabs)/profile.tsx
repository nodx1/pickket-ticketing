import {
  View,
  Text,
  Pressable,
  useColorScheme,
  StyleSheet,
} from "react-native";

export default function ProfileScreen() {
  const isDark = useColorScheme() === "dark";
  const fg = isDark ? "#ffffff" : "#0a0a0a";
  const bg = isDark ? "#0a0a0a" : "#f5f5f5";
  const card = isDark ? "#1a1a1a" : "#ffffff";
  const muted = isDark ? "#6b7280" : "#9ca3af";

  const menuItems = [
    "주문 내역",
    "포인트 / AP",
    "알림 설정",
    "언어 설정",
    "고객센터",
    "이용약관",
  ];

  return (
    <View style={{ flex: 1, backgroundColor: bg }}>
      <View style={{ alignItems: "center", paddingVertical: 32 }}>
        <View
          style={{
            width: 64,
            height: 64,
            borderRadius: 32,
            backgroundColor: isDark ? "#2a2a2a" : "#e5e5e5",
            alignItems: "center",
            justifyContent: "center",
            marginBottom: 12,
          }}
        >
          <Text style={{ fontSize: 24 }}>👤</Text>
        </View>
        <Text style={{ fontSize: 16, fontWeight: "600", color: fg }}>
          로그인이 필요합니다
        </Text>
        <Pressable
          style={{
            marginTop: 12,
            backgroundColor: "#6d28d9",
            paddingHorizontal: 24,
            paddingVertical: 10,
            borderRadius: 8,
          }}
        >
          <Text style={{ color: "#ffffff", fontWeight: "600", fontSize: 14 }}>
            로그인
          </Text>
        </Pressable>
      </View>

      <View style={{ paddingHorizontal: 16 }}>
        {menuItems.map((item) => (
          <Pressable
            key={item}
            style={{
              backgroundColor: card,
              padding: 16,
              borderRadius: 10,
              marginBottom: 8,
            }}
          >
            <Text style={{ color: fg, fontSize: 14 }}>{item}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
