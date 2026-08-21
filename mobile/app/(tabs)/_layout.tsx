/**
 * 탭 레이아웃 — 4탭 (Home · Schedule · Tickets · Me) + 자동 숨김 AnimatedTabBar
 */
import { useEffect } from "react";
import { Tabs } from "expo-router";
import { useTranslation } from "react-i18next";
import { AnimatedTabBar } from "@/components/navigation/AnimatedTabBar";
import { useScrollDirection } from "@/stores/scrollDirection";

export default function TabsLayout() {
  const { t } = useTranslation();
  const resetDirection = useScrollDirection((s) => s.resetDirection);

  useEffect(() => {
    resetDirection();
  }, [resetDirection]);

  return (
    <Tabs
      screenOptions={{ headerShown: false }}
      tabBar={(props) => <AnimatedTabBar {...props} />}
    >
      <Tabs.Screen name="index" options={{ title: t("tabs.home") }} />
      <Tabs.Screen name="schedule" options={{ title: t("tabs.schedule") }} />
      <Tabs.Screen name="tickets" options={{ title: t("tabs.tickets") }} />
      <Tabs.Screen name="me" options={{ title: t("tabs.me") }} />
    </Tabs>
  );
}
