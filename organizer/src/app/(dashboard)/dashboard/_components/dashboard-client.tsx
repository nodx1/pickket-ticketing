"use client";

import { useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { PageTransition, StaggerItem } from "@/components/ui/page-transition";
import { fetchWithAuth } from "@/lib/fetchWithAuth";
import { ActionCards } from "./action-cards";
import { LivePulse } from "./live-pulse";
import { RecentActivity } from "./recent-activity";
import { UpcomingEvents } from "./upcoming-events";
import { WeekSummary } from "./week-summary";

interface DashboardData {
  live: {
    todayRevenue: number;
    todayOrders: number;
    activeCheckIns: number;
    lastOrderMinutesAgo: number | null;
  };
  thisWeek: {
    revenueTotal: number;
    orderTotal: number;
    revenueVsLastWeek: string;
  };
  actions: Array<{ type: string; count: number; label: string }>;
  recentActivity: Array<{ type: string; message: string; time: string; eventId: string }>;
  upcomingEvents: Array<{
    id: string;
    title: string;
    status: string;
    startsAt: string;
    orderCount: number;
    revenue: number;
  }>;
}

interface DashboardApiResponse {
  success: boolean;
  data: DashboardData;
}

export function DashboardClient() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const result = await fetchWithAuth<DashboardApiResponse>("/api/dashboard");
        setData(result.data);
      } catch {
        setData(null);
      } finally {
        setIsLoading(false);
      }
    }

    void load();
    const interval = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={`dashboard-live-${index}`} className="h-28" />
          ))}
        </div>
        <Skeleton className="h-32" />
        <div className="grid gap-5 lg:grid-cols-2">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        대시보드 데이터를 불러올 수 없습니다
      </div>
    );
  }

  return (
    <PageTransition>
      <StaggerItem index={0}>
        <LivePulse data={data.live} />
      </StaggerItem>

      <StaggerItem index={1}>
        <WeekSummary data={data.thisWeek} />
      </StaggerItem>

      <StaggerItem index={2}>
        <ActionCards actions={data.actions} />
      </StaggerItem>

      <StaggerItem index={3}>
        <div className="grid gap-5 lg:grid-cols-2">
          <RecentActivity items={data.recentActivity} />
          <UpcomingEvents events={data.upcomingEvents} />
        </div>
      </StaggerItem>
    </PageTransition>
  );
}
