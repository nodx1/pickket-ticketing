"use client";

import { useEffect, useState } from "react";
import { ErrorState } from "@/components/shared/error-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatKRW } from "@/lib/format";
import { KpiCards } from "./kpi-cards";
import { SalesChart } from "./sales-chart";
import { fetchWithRefresh } from "@/lib/fetchWithAuth";

type ReportType = "sales" | "products" | "promo" | "attendees";

interface SalesReportData {
  type: "sales";
  dailySales: Array<{ date: string; amount: number; count: number }>;
  summary: { totalRevenue: number; totalOrders: number; avgOrderValue: number; refundedAmount: number };
}

interface ProductsReportData {
  type: "products";
  items: Array<{ name: string; sold: number; revenue: number; stock: number | null }>;
  summary: { totalSold: number; totalRevenue: number; totalStock: number };
}

interface PromoReportData {
  type: "promo";
  items: Array<{ code: string; promoType: string; usageCount: number; discountTotal: number }>;
}

interface AttendeesReportData {
  type: "attendees";
  dailyRegistrations: Array<{ date: string; count: number }>;
  summary: { totalAttendees: number; checkedInCount: number; checkInRate: number };
}

type ReportResponse = SalesReportData | ProductsReportData | PromoReportData | AttendeesReportData;

export function EventReportsClient({ eventId }: { eventId: string }) {
  const [type, setType] = useState<ReportType>("sales");
  // report 는 {type, data} 쌍으로 관리 — 탭 전환 시 type 불일치 데이터 노출 방지 (#15 수정).
  const [reportWithType, setReportWithType] = useState<{ type: ReportType; data: ReportResponse | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // 재시도 트리거 — 값이 바뀌면 useEffect 재실행 (S2 에러 상태).
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    async function load() {
      setError(false);
      setLoading(true);
      try {
        const response = await fetchWithRefresh(`/api/events/${eventId}/reports?type=${type}`, { credentials: "include" });
        if (!response.ok) {
          throw new Error(`reports load failed: ${response.status}`);
        }
        const payload = (await response.json()) as { data?: ReportResponse };
        if (active) {
          setReportWithType({ type, data: payload.data ?? null });
        }
      } catch {
        if (active) {
          setError(true);
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [eventId, type, reloadKey]);

  // reportWithType.type !== type 이면 이전 탭 데이터 → null 로 처리해 잘못된 KPI 표시 차단 (#15 수정).
  const displayReport = reportWithType?.type === type ? reportWithType.data : null;

  const kpis = [
    {
      label: "총 매출",
      value: displayReport?.type === "sales" ? displayReport.summary.totalRevenue : displayReport?.type === "products" ? displayReport.summary.totalRevenue : 0,
      kind: "currency" as const,
    },
    {
      label: "총 주문",
      value: displayReport?.type === "sales" ? displayReport.summary.totalOrders : 0,
      kind: "number" as const,
    },
    {
      label: "평균 주문액",
      value: displayReport?.type === "sales" ? Math.round(displayReport.summary.avgOrderValue) : 0,
      kind: "currency" as const,
    },
    {
      label: "체크인율",
      value: displayReport?.type === "attendees" ? displayReport.summary.checkInRate : 0,
      kind: "percent" as const,
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-3xl font-black tracking-[-0.04em] text-foreground">리포트</h2>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline">
            <a href={`/api/events/${eventId}/reports/export?type=${type}`}>내보내기</a>
          </Button>
        </div>
      </div>

      <Tabs value={type} onValueChange={(value) => setType(value as ReportType)}>
        <TabsList>
          <TabsTrigger value="sales">매출</TabsTrigger>
          <TabsTrigger value="products">상품</TabsTrigger>
          <TabsTrigger value="promo">프로모</TabsTrigger>
          <TabsTrigger value="attendees">참석자</TabsTrigger>
        </TabsList>
      </Tabs>

      {loading ? (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-28 animate-pulse rounded-lg border border-border bg-bg-muted" />
            ))}
          </div>
          <div className="h-64 animate-pulse rounded-lg border border-border bg-bg-muted" />
        </div>
      ) : error ? (
        <ErrorState
          description="리포트를 불러오지 못했습니다. 잘못된 0원 지표로 오인될 수 있어 표시하지 않습니다."
          onRetry={() => setReloadKey((key) => key + 1)}
        />
      ) : (
        <>
          <KpiCards items={kpis} />

          {displayReport?.type === "sales" ? (
            <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
              <SalesChart
                title="일별 매출 차트"
                points={displayReport.dailySales.map((item) => ({ label: item.date.slice(5), value: item.amount }))}
                variant="bar"
              />
              <Card className="border-border bg-card/95">
                <CardHeader><CardTitle className="text-foreground">매출 요약</CardTitle></CardHeader>
                <CardContent className="space-y-3 text-sm text-muted-foreground">
                  <p>환불액: {formatKRW(displayReport.summary.refundedAmount)}</p>
                  <p>일별 데이터: {displayReport.dailySales.length}일</p>
                </CardContent>
              </Card>
            </div>
          ) : null}

          {displayReport?.type === "products" ? (
            <Card className="border-border bg-card/95">
              <CardHeader><CardTitle className="text-foreground">상품 리포트</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {displayReport.items.map((item) => (
                  <div key={item.name} className="rounded-lg border border-border bg-muted px-4 py-4 text-sm text-muted-foreground">
                    {item.name} · 판매 {item.sold}건 · 매출 {formatKRW(item.revenue)} · 재고 {item.stock === null ? "무제한" : `${item.stock}개`}
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}

          {displayReport?.type === "promo" ? (
            <Card className="border-border bg-card/95">
              <CardHeader><CardTitle className="text-foreground">프로모코드 리포트</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {displayReport.items.map((item) => (
                  <div key={item.code} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted px-4 py-4 text-sm text-muted-foreground">
                    <div className="flex items-center gap-3">
                      <Badge>{item.code}</Badge>
                      <span>{item.promoType === "fixed" ? "정액" : "정률"}</span>
                    </div>
                    <div className="flex items-center gap-4">
                      <span>사용 {item.usageCount}회</span>
                      <span>할인총액 {formatKRW(item.discountTotal)}</span>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}

          {displayReport?.type === "attendees" ? (
            <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
              <SalesChart
                title="일별 참석자 등록 추이"
                points={displayReport.dailyRegistrations.map((item) => ({ label: item.date.slice(5), value: item.count }))}
                variant="line"
              />
              <Card className="border-border bg-card/95">
                <CardHeader><CardTitle className="text-foreground">참석자 요약</CardTitle></CardHeader>
                <CardContent className="space-y-3 text-sm text-muted-foreground">
                  <p>전체 참석자: {displayReport.summary.totalAttendees.toLocaleString("ko-KR")}명</p>
                  <p>체크인 완료: {displayReport.summary.checkedInCount.toLocaleString("ko-KR")}명</p>
                </CardContent>
              </Card>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
