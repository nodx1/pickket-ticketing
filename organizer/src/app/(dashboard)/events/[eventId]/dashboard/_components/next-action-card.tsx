"use client";

import Link from "next/link";
import { ArrowRight, Loader2, Sparkles, Target } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  buildPrescriptions,
  type Prescription,
  type PrescriptionPriority,
} from "@/lib/growth/prescriptions";
import { cn } from "@/lib/utils";
import { fetchWithRefresh } from "@/lib/fetchWithAuth";

interface NextActionCardProps {
  eventId: string;
  /** 이벤트 상태(라이브 여부 판정 — SEO 규칙). */
  status: string;
  /** 총 정원(좌석). null 이면 판매율/매진 규칙 비활성. */
  maxAttendees: number | null;
  /** 이벤트 시작 시각(ISO) — D-day 계산. */
  startsAt: string | null;
  /** 이미 로드된 대시보드 지표 재사용(추가 조회 최소화). */
  totalAttendees: number;
  totalOrders: number;
}

/** 우선순위 → 뱃지 표시. */
const PRIORITY_META: Record<
  PrescriptionPriority,
  { label: string; variant: "warning" | "secondary"; dot: string }
> = {
  1: { label: "지금", variant: "warning", dot: "bg-warning" },
  2: { label: "권장", variant: "secondary", dot: "bg-primary" },
  3: { label: "개선", variant: "secondary", dot: "bg-info" },
};

/** 시작 시각 → D-day(일수). 없거나 파싱 실패 시 null. */
function daysUntil(startsAt: string | null): number | null {
  if (!startsAt) return null;
  const start = new Date(startsAt).getTime();
  if (Number.isNaN(start)) return null;
  const diffMs = start - Date.now();
  return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
}

interface SupplementalSignals {
  pendingOrders: number;
  activePromoCount: number;
  openInquiries: number;
  seoComplete: boolean | null;
}

/**
 * 규칙 엔진에 부족한 신호만 경량 조회한다(대시보드 지표는 props 재사용).
 * 각 조회는 독립 실패 허용 — 실패한 신호는 안전값(0/null)으로 폴백해 나머지 규칙은 계속 동작.
 */
async function fetchSupplementalSignals(eventId: string): Promise<SupplementalSignals> {
  const [pendingRes, promoRes, inquiryRes, publishRes] = await Promise.allSettled([
    fetchWithRefresh(`/api/events/${eventId}/orders?status=pending&limit=1`, { credentials: "include" }),
    fetchWithRefresh(`/api/events/${eventId}/promo-codes`, { credentials: "include" }),
    fetchWithRefresh(`/api/events/${eventId}/inquiries?status=open`, { credentials: "include" }),
    fetchWithRefresh(`/api/events/${eventId}/publish-check`, { credentials: "include" }),
  ]);

  // 미결제 주문 수 — listResponse 의 total(전체 건수) 사용.
  let pendingOrders = 0;
  if (pendingRes.status === "fulfilled" && pendingRes.value.ok) {
    const body = (await pendingRes.value.json()) as { total?: number };
    pendingOrders = typeof body.total === "number" ? body.total : 0;
  }

  // 활성 프로모 코드 수 — is_active 만 카운트.
  let activePromoCount = 0;
  if (promoRes.status === "fulfilled" && promoRes.value.ok) {
    const body = (await promoRes.value.json()) as {
      data?: Array<{ isActive?: boolean }>;
    };
    activePromoCount = (body.data ?? []).filter((row) => row.isActive !== false).length;
  }

  // 미답변 문의 수 — status=open 목록의 건수(total).
  let openInquiries = 0;
  if (inquiryRes.status === "fulfilled" && inquiryRes.value.ok) {
    const body = (await inquiryRes.value.json()) as { total?: number };
    openInquiries = typeof body.total === "number" ? body.total : 0;
  }

  // SEO 완료 여부 — publish-check 체크 항목 중 "SEO 메타데이터" status 로 판정.
  let seoComplete: boolean | null = null;
  if (publishRes.status === "fulfilled" && publishRes.value.ok) {
    const body = (await publishRes.value.json()) as {
      data?: Array<{ label?: string; status?: string }>;
    };
    const seoItem = (body.data ?? []).find((item) => item.label === "SEO 메타데이터");
    if (seoItem) seoComplete = seoItem.status === "pass";
  }

  return { pendingOrders, activePromoCount, openInquiries, seoComplete };
}

export function NextActionCard({
  eventId,
  status,
  maxAttendees,
  startsAt,
  totalAttendees,
  totalOrders,
}: NextActionCardProps) {
  const [prescriptions, setPrescriptions] = useState<Prescription[] | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    // 부족 신호 조회 실패 전체를 대비 — 실패해도 대시보드 지표만으로 규칙 산출.
    let signals: SupplementalSignals = {
      pendingOrders: 0,
      activePromoCount: 0,
      openInquiries: 0,
      seoComplete: null,
    };
    try {
      signals = await fetchSupplementalSignals(eventId);
    } catch {
      // 조회 실패 시 안전값 유지 — 규칙 엔진은 계속 동작(처방이 줄어들 뿐).
    }

    const list = buildPrescriptions({
      eventId,
      status,
      maxAttendees,
      totalAttendees,
      totalOrders,
      daysUntilStart: daysUntil(startsAt),
      pendingOrders: signals.pendingOrders,
      activePromoCount: signals.activePromoCount,
      openInquiries: signals.openInquiries,
      seoComplete: signals.seoComplete,
    });
    setPrescriptions(list);
    setLoading(false);
  }, [eventId, status, maxAttendees, startsAt, totalAttendees, totalOrders]);

  useEffect(() => {
    // 초기 setState(setLoading) 를 이펙트 밖으로 지연 — 동기 setState 로 인한 연쇄 렌더 회피
    // (event-dashboard-client 의 동일 패턴).
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <Target className="size-4 text-primary" />
          다음 액션 추천
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-5 animate-spin text-primary" />
            현황 분석 중...
          </div>
        ) : prescriptions && prescriptions.length > 0 ? (
          <ul className="space-y-3">
            {prescriptions.map((p) => {
              const meta = PRIORITY_META[p.priority];
              return (
                <li
                  key={p.id}
                  className="flex flex-col gap-3 rounded-lg border border-border bg-bg-subtle p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={cn("size-1.5 shrink-0 rounded-full", meta.dot)} />
                      <p className="text-sm font-bold text-foreground">{p.title}</p>
                      <Badge variant={meta.variant} className="shrink-0">
                        {meta.label}
                      </Badge>
                    </div>
                    <p className="mt-1 pl-3.5 text-xs leading-5 text-muted-foreground">
                      {p.reason}
                    </p>
                  </div>
                  <Button asChild size="sm" className="shrink-0 self-start sm:self-center">
                    <Link href={p.ctaHref}>
                      {p.ctaLabel}
                      <ArrowRight className="size-4" />
                    </Link>
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <div className="flex size-14 items-center justify-center rounded-full bg-success/12 text-success">
              <Sparkles className="size-7" />
            </div>
            <div>
              <p className="text-sm font-bold text-foreground">지금은 순조롭습니다</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                당장 필요한 조치가 없습니다. 현황을 계속 지켜보고 있습니다.
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
