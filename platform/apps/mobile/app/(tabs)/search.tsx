import {
  View,
  Text,
  TextInput,
  StyleSheet,
  useColorScheme,
} from "react-native";
import { useState } from "react";

export default function SearchScreen() {
  const isDark = useColorScheme() === "dark";
  const [query, setQuery] = useState("");

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: isDark ? "#0a0a0a" : "#f5f5f5",
        padding: 16,
      }}
    >
      <TextInput
        style={{
          backgroundColor: isDark ? "#1a1a1a" : "#ffffff",
          color: isDark ? "#ffffff" : "#0a0a0a",
          borderRadius: 12,
          padding: 14,
          fontSize: 15,
          borderWidth: 1,
          borderColor: isDark ? "#2a2a2a" : "#e5e5e5",
        }}
        placeholder="이벤트 검색..."
        placeholderTextColor={isDark ? "#6b7280" : "#9ca3af"}
        value={query}
        onChangeText={setQuery}
      />
      <View style={{ alignItems: "center", justifyContent: "center", flex: 1 }}>
        <Text style={{ color: isDark ? "#6b7280" : "#9ca3af", fontSize: 14 }}>
          {query
            ? `"${query}" 검색 결과가 여기에 표시됩니다`
            : "이벤트를 검색해보세요"}
        </Text>
      </View>
    </View>
  );
}
