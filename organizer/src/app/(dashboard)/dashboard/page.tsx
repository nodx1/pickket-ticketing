"use client";

import { useEffect } from "react";
import { useTutorialStore } from "@/lib/stores/tutorialStore";
import { DashboardClient } from "./_components/dashboard-client";

export default function DashboardPage() {
  const { shouldShowWelcome, startTour, activeTourId } = useTutorialStore();

  useEffect(() => {
    if (shouldShowWelcome() && !activeTourId) {
      const timer = setTimeout(() => startTour("welcome"), 800);
      return () => clearTimeout(timer);
    }
  }, [shouldShowWelcome, startTour, activeTourId]);

  return (
    <div className="space-y-6" data-tutorial="welcome-screen">
      <div data-tutorial="dashboard-stats">
        <p className="text-sm text-muted-foreground">미션 컨트롤</p>
        <h2 className="mt-2 text-3xl font-black tracking-[-0.04em] text-foreground">대시보드</h2>
      </div>

      <DashboardClient />
    </div>
  );
}
