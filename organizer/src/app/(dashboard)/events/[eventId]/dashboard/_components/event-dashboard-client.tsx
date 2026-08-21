"use client";

import { RefreshCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { NextActionCard } from "./next-action-card";
import { RecentOrders } from "./recent-orders";
import { SalesChart } from "./sales-chart";
import { StatsCards } from "./stats-cards";
import { LiveStats } from "../../overview/_components/live-stats";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/shared/error-state";
import { useAutoRefresh } from "@/lib/hooks/useAutoRefresh";
import { showSuccess } from "@/lib/hooks/useToast";
import { fetchWithRefresh } from "@/lib/fetchWithAuth";

interface DashboardPayload {
  totalOrders: number;
  totalAttendees: number;
  totalRevenue: number;
  checkedInCount: number;
  dailySales: Array<{ date: string; amount: number; count: number }>;
  productSales: Array<{ name: string; sold: number; revenue: number }>;
}

interface OrderRow {
  id: string;
  orderNumber: string;
  buyerName: string;
  paidAmount: number;
  orderedAt: string;
  status: string;
}

async function requestDashboard(eventId: string) {
  const [dashboardResponse, ordersResponse] = await Promise.all([
    fetchWithRefresh(`/api/events/${eventId}/dashboard`, { credentials: "include" }),
    fetchWithRefresh(`/api/events/${eventId}/orders?limit=5`, { credentials: "include" }),
  ]);

  // HTTP 에러를 삼켜 0값으로 표시하던 문제(감사 S2) — 실패 시 throw 해 상위 catch 로 전달.
  if (!dashboardResponse.ok) throw new Error(`dashboard ${dashboardResponse.status}`);

  const dashboardPayload = (await dashboardResponse.json()) as { data?: DashboardPayload };
  const ordersPayload = (await ordersResponse.json()) as { data?: OrderRow[] };

  return {
    dashboard: dashboardPayload.data ?? null,
    orders: ordersPayload.data ?? [],
  };
}

interface EventDashboardClientProps {
  eventId: string;
  /** 처방 엔진 신호 — 이벤트 요약에서 서버 전달(추가 조회 없음). */
  status: string;
  maxAttendees: number | null;
  startsAt: string | null;
}

export function EventDashboardClient({
  eventId,
  status,
  maxAttendees,
  startsAt,
}: EventDashboardClientProps) {
  const [dashboard, setDashboard] = useState<DashboardPayload | null>(null);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [error, setError] = useState(false);

  async function loadDashboard() {
    try {
      const nextData = await requestDashboard(eventId);
      setDashboard(nextData.dashboard);
      setOrders(nextData.orders);
      setError(false);
    } catch {
      // 폴링 실패는 기존 데이터 유지(깜빡임 방지) — 초기 로드 실패만 에러 화면으로 노출.
      setError(true);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadDashboard();
    }, 0);

    return () => {
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  useEffect(() => {
    const message = window.sessionStorage.getItem("pickket:event-flash");
    if (message) {
      showSuccess(message);
      window.sessionStorage.removeItem("pickket:event-flash");
    }
  }, []);

  const { refresh, isRefreshing } = useAutoRefresh(loadDashboard, 30000);

  const checkInRate = dashboard && dashboard.totalAttendees > 0
    ? Math.round((dashboard.checkedInCount / dashboard.totalAttendees) * 100)
    : 0;

  // 초기 로드 실패(데이터 없음) — 0값 위장 대신 명시적 에러+재시도.
  if (error && !dashboard) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-black tracking-[-0.04em] text-foreground">이벤트 대시보드</h1>
        <ErrorState description="대시보드 데이터를 불러오지 못했습니다." onRetry={() => void loadDashboard()} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-border bg-[linear-gradient(135deg,rgba(108,92,231,0.08),rgba(139,92,246,0.06),rgba(5,150,105,0.04))] p-6 text-foreground shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-sm uppercase tracking-[0.24em] text-foreground/70">event dashboard</p>
            <h1 className="mt-3 text-3xl font-black tracking-[-0.04em]">이벤트 대시보드</h1>
            <p className="mt-3 text-sm text-foreground/80">주문, 참석자, 체크인 현황을 한눈에 확인할 수 있습니다.</p>
          </div>
          <div className="flex items-center gap-3">
            <p className="text-sm text-foreground/80">30초마다 자동 갱신</p>
            <Button variant="outline" className="border-border-emphasis bg-bg-subtle text-foreground hover:bg-bg-emphasis" onClick={() => void refresh()}>
              <RefreshCcw className={`size-4 ${isRefreshing ? "animate-spin" : ""}`} />
              새로고침
            </Button>
          </div>
        </div>
      </div>

      <StatsCards
        totalRevenue={dashboard?.totalRevenue ?? 0}
        totalOrders={dashboard?.totalOrders ?? 0}
        totalAttendees={dashboard?.totalAttendees ?? 0}
        checkInRate={checkInRate}
      />

      {/* F-1 처방 대시보드 — 히어로 아래·차트 위. 로드된 지표 재사용 + 부족분만 경량 조회. */}
      <NextActionCard
        eventId={eventId}
        status={status}
        maxAttendees={maxAttendees}
        startsAt={startsAt}
        totalAttendees={dashboard?.totalAttendees ?? 0}
        totalOrders={dashboard?.totalOrders ?? 0}
      />

      <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
        <SalesChart items={dashboard?.dailySales ?? []} />
        <RecentOrders eventId={eventId} items={orders} />
      </div>

      <LiveStats eventId={eventId} />
    </div>
  );
}
