import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  useColorScheme,
  Pressable,
} from "react-native";

export default function HomeScreen() {
  const isDark = useColorScheme() === "dark";
  const styles = createStyles(isDark);

  return (
    <ScrollView style={styles.container}>
      <View style={styles.hero}>
        <Text style={styles.heroTitle}>Pickket</Text>
        <Text style={styles.heroSubtitle}>공정한 티켓 플랫폼</Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>인기 이벤트</Text>
        {[1, 2, 3].map((i) => (
          <View key={i} style={styles.eventCard}>
            <View style={styles.eventImage} />
            <View style={styles.eventInfo}>
              <Text style={styles.eventTitle}>이벤트 {i}</Text>
              <Text style={styles.eventDate}>2026년 4월 {10 + i}일</Text>
              <Text style={styles.eventVenue}>장소 정보</Text>
            </View>
          </View>
        ))}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>카테고리</Text>
        <View style={styles.categoryGrid}>
          {["콘서트", "뮤지컬", "스포츠", "전시", "페스티벌", "클래식"].map(
            (cat) => (
              <Pressable key={cat} style={styles.categoryChip}>
                <Text style={styles.categoryText}>{cat}</Text>
              </Pressable>
            ),
          )}
        </View>
      </View>
    </ScrollView>
  );
}

function createStyles(isDark: boolean) {
  const fg = isDark ? "#ffffff" : "#0a0a0a";
  const bg = isDark ? "#0a0a0a" : "#f5f5f5";
  const card = isDark ? "#1a1a1a" : "#ffffff";
  const muted = isDark ? "#6b7280" : "#9ca3af";
  const accent = isDark ? "#7c3aed" : "#6d28d9";

  return StyleSheet.create({
    container: { flex: 1, backgroundColor: bg },
    hero: { padding: 24, paddingTop: 60, alignItems: "center" },
    heroTitle: { fontSize: 32, fontWeight: "800", color: accent },
    heroSubtitle: { fontSize: 14, color: muted, marginTop: 4 },
    section: { padding: 16 },
    sectionTitle: {
      fontSize: 18,
      fontWeight: "700",
      color: fg,
      marginBottom: 12,
    },
    eventCard: {
      flexDirection: "row",
      backgroundColor: card,
      borderRadius: 12,
      marginBottom: 12,
      overflow: "hidden",
    },
    eventImage: {
      width: 80,
      height: 80,
      backgroundColor: isDark ? "#2a2a2a" : "#e5e5e5",
    },
    eventInfo: { flex: 1, padding: 12, justifyContent: "center" },
    eventTitle: { fontSize: 14, fontWeight: "600", color: fg },
    eventDate: { fontSize: 12, color: muted, marginTop: 2 },
    eventVenue: { fontSize: 12, color: muted, marginTop: 2 },
    categoryGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    categoryChip: {
      backgroundColor: card,
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: isDark ? "#2a2a2a" : "#e5e5e5",
    },
    categoryText: { fontSize: 13, color: fg, fontWeight: "500" },
  });
}
