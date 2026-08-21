"use client";

import { AlertCircle, BadgeCheck, Info, RotateCcw, ShoppingCart, Sparkles, XCircle, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { DataTable } from "@/components/shared/data-table";
import { ErrorState } from "@/components/shared/error-state";
import { Pagination } from "@/components/shared/pagination";
import { Button } from "@/components/ui/button";
import { fetchWithAuth } from "@/lib/fetchWithAuth";
import { NOTIFICATION_TYPE_LABELS } from "@/lib/constants";

interface NotificationRow {
  id: string;
  // DB CHECK(mig146)·알림 생성부가 쓰는 타입이 6종보다 넓다(ai_*, event_*). 좁게 잡으면
  // 미지 타입 렌더 시 아이콘 undefined → 페이지 크래시. string 으로 넓히고 아래서 폴백 처리.
  type: string;
  title: string;
  message: string;
  isRead: boolean;
  createdAt: string;
}

const iconMap: Record<string, LucideIcon> = {
  refund_request: RotateCcw,
  sold_out: AlertCircle,
  payment_failed: XCircle,
  new_order: ShoppingCart,
  check_in_milestone: ShoppingCart,
  system: Info,
  ai_review: Sparkles,
  ai_complete: Sparkles,
  event_approved: BadgeCheck,
  event_rejected: XCircle,
};

function timeAgo(value: string) {
  const diffMs = Date.now() - new Date(value).getTime();
  const diffMinutes = Math.max(Math.floor(diffMs / 60000), 0);
  if (diffMinutes < 1) return "방금 전";
  if (diffMinutes < 60) return `${diffMinutes}분 전`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}시간 전`;
  return `${Math.floor(diffHours / 24)}일 전`;
}

export function NotificationsClient() {
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const limit = 20;

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const payload = await fetchWithAuth<{
        success: boolean;
        data: NotificationRow[];
        meta: { total: number; page: number; limit: number };
      }>(`/api/notifications?page=${page}&limit=${limit}`);
      setItems(payload.data ?? []);
      setTotal(payload.meta?.total ?? 0);
    } catch {
      // 실패를 빈 목록("알림 없음")으로 위장하지 않고 명시적 에러로 노출(S2).
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    void load();
  }, [load]);

  async function markAllRead() {
    await fetchWithAuth("/api/notifications", { method: "PATCH" });
    await load();
  }

  const totalPages = Math.max(Math.ceil(total / limit), 1);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-black tracking-[-0.04em] text-foreground">알림 센터</h1>
          <p className="mt-2 text-sm text-muted-foreground">주문, 환불, 매진 등 운영 이벤트를 한 곳에서 확인합니다.</p>
        </div>
        <Button variant="outline" onClick={() => void markAllRead()}>
          전체 읽음
        </Button>
      </div>

      <div className="space-y-4">
        {error ? (
          <ErrorState description="알림을 불러오지 못했습니다." onRetry={() => void load()} />
        ) : (
        <>
        <DataTable
          data={items}
          loading={loading}
          emptyMessage="알림이 없습니다"
          getRowClassName={(row) => (!row.isRead ? "bg-primary/5" : undefined)}
          columns={[
            {
              key: "type",
              label: "유형",
              render: (row) => {
                const Icon = iconMap[row.type] ?? Info;
                return (
                  <div className="flex items-center gap-2 text-foreground">
                    <Icon className="size-4" />
                    <span>{NOTIFICATION_TYPE_LABELS[row.type] ?? row.type}</span>
                  </div>
                );
              },
            },
            { key: "title", label: "제목" },
            { key: "message", label: "메시지" },
            { key: "createdAt", label: "시간", render: (row) => timeAgo(row.createdAt) },
            { key: "isRead", label: "읽음 상태", render: (row) => (row.isRead ? "읽음" : "읽지 않음") },
          ]}
        />
        <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
        </>
        )}
      </div>
    </div>
  );
}
