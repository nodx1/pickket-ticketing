"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ChevronRight, FileCheck } from "lucide-react";
import { EmptyState } from "@/components/shared/empty-state";
import { StatusBadge } from "@/components/shared/status-badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { EventStatus } from "@/lib/types";
import { fetchWithRefresh } from "@/lib/fetchWithAuth";

interface ComplianceEventItem {
  id: string;
  title: string;
  slug: string;
  status: EventStatus;
}

export function AccountComplianceClient() {
  const [events, setEvents] = useState<ComplianceEventItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      setError(false);
      try {
        const response = await fetchWithRefresh("/api/events?limit=50", { credentials: "include" });
        if (!response.ok) throw new Error("이벤트 목록을 불러오지 못했습니다");
        const payload = (await response.json()) as { data?: ComplianceEventItem[] };
        if (active) setEvents(payload.data ?? []);
      } catch {
        if (active) setError(true);
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <FileCheck className="size-5" />
          </div>
          <h2 className="text-3xl font-black tracking-[-0.04em] text-foreground">컴플라이언스</h2>
        </div>
        <p className="mt-2 text-sm text-content-subtle">
          법적 준수 사항과 감사 추적(감사 로그)을 관리합니다. 감사 로그는 이벤트별로 기록되므로,
          아래에서 이벤트를 선택해 해당 이벤트의 감사 추적을 확인하세요.
        </p>
      </div>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <Card key={`compliance-skeleton-${index}`} className="border-border bg-card">
              <CardContent className="flex items-center gap-4 p-5">
                <Skeleton className="h-5 w-1/3" />
                <Skeleton className="ml-auto h-5 w-16" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : error ? (
        <EmptyState
          title="불러오지 못했습니다"
          description="이벤트 목록을 불러오는 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요."
        />
      ) : events.length === 0 ? (
        <EmptyState
          title="이벤트가 없습니다"
          description="이벤트를 먼저 만들면 감사 로그를 확인할 수 있습니다."
        />
      ) : (
        <div className="space-y-3">
          {events.map((event) => (
            <Link
              key={event.id}
              href={`/events/${event.id}/compliance`}
              className="block rounded-lg border border-border bg-card p-5 transition hover:border-primary/40 hover:shadow-card-hover"
            >
              <div className="flex items-center gap-4">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-foreground">{event.title}</p>
                  <p className="mt-1 truncate text-sm text-content-subtle">@{event.slug}</p>
                </div>
                <StatusBadge status={event.status} />
                <ChevronRight className="size-4 shrink-0 text-content-muted" />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
