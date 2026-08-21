"use client";

import { useEffect, useState } from "react";
import { useConfirmAction } from "@/lib/hooks/useConfirmAction";
import { Building2 } from "lucide-react";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { DataTable } from "@/components/shared/data-table";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { showError, showSuccess } from "@/lib/hooks/useToast";
import { fetchWithRefresh } from "@/lib/fetchWithAuth";

interface GroupBookingRow extends Record<string, string | number | boolean | null> {
  id: string;
  organizationName: string;
  contactName: string;
  attendeeCount: number;
  discountRate: number;
  status: string;
  productName: string;
  orderNumber: string | null;
}

const STATUS_LABELS: Record<string, string> = {
  pending: "대기",
  confirmed: "승인됨",
  cancelled: "거절됨",
};

const STATUS_VARIANTS: Record<string, "warning" | "success" | "outline"> = {
  pending: "warning",
  confirmed: "success",
  cancelled: "outline",
};

export function GroupBookingsClient({ eventId }: { eventId: string }) {
  const [items, setItems] = useState<GroupBookingRow[]>([]);
  const [discountRate, setDiscountRate] = useState("10");
  const [confirmTarget, setConfirmTarget] = useState<{ id: string; action: "confirm" | "cancel" } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  async function refresh() {
    setError(false);
    try {
      const response = await fetchWithRefresh(`/api/events/${eventId}/group-bookings`, { credentials: "include" });
      if (!response.ok) {
        setError(true);
        return;
      }
      const payload = (await response.json()) as { data?: GroupBookingRow[] };
      setItems(payload.data ?? []);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  async function confirm(bookingId: string) {
    try {
      const response = await fetchWithRefresh(`/api/events/${eventId}/group-bookings/${bookingId}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "confirmed", discountRate: Number(discountRate) }),
      });
      if (response.ok) {
        await refresh();
        showSuccess("단체 예약을 승인했습니다");
      } else {
        showError("단체 예약 승인에 실패했습니다");
      }
    } catch {
      showError("단체 예약 승인 중 오류가 발생했습니다");
    }
  }

  async function cancel(bookingId: string) {
    try {
      const response = await fetchWithRefresh(`/api/events/${eventId}/group-bookings/${bookingId}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "cancelled", rejectionReason: "운영 사정으로 보류" }),
      });
      if (response.ok) {
        await refresh();
        showSuccess("단체 예약을 거절했습니다");
      } else {
        showError("단체 예약 거절에 실패했습니다");
      }
    } catch {
      showError("단체 예약 거절 중 오류가 발생했습니다");
    }
  }

  // 확인 버튼 잠금 + 재진입 차단 + 실패 시 해제 (S3).
  // 종전엔 `void fn(); setTarget(null)` 라 **요청이 끝나기 전에 창이 닫혔다** —
  // 그 상태로 pending 을 넘겨봐야 보이지도 않는다. 끝난 뒤 닫도록 바꿨다.
  const confirmAction = useConfirmAction(async () => {
    if (!confirmTarget) return;
    if (confirmTarget.action === "confirm") {
      await confirm(confirmTarget.id);
    } else {
      await cancel(confirmTarget.id);
    }
    setConfirmTarget(null);
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-3xl font-black tracking-[-0.04em] text-foreground">단체 예약</h2>
          <p className="mt-2 text-sm text-content-subtle">기업/MICE 단체 티켓 요청을 승인하고 주문으로 전환합니다.</p>
        </div>
        <Input type="number" min={0} max={100} inputMode="numeric" className="max-w-32" value={discountRate} aria-label="단체 할인율 (%)" onChange={(event) => setDiscountRate(event.target.value)} />
      </div>

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-14 animate-pulse rounded-lg border border-border bg-bg-muted" />
          ))}
        </div>
      ) : error ? (
        <ErrorState description="단체 예약 목록을 불러오지 못했습니다." onRetry={() => void refresh()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={Building2}
          title="단체 예약 요청이 없습니다"
          description="기업·MICE·단체 관람 요청이 접수되면 여기에서 승인하고 주문으로 전환할 수 있습니다."
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">단체 예약 요청</CardTitle>
          </CardHeader>
          <CardContent>
            <DataTable
              data={items}
              columns={[
                { key: "organizationName", label: "단체명" },
                { key: "contactName", label: "담당자" },
                { key: "productName", label: "상품" },
                { key: "attendeeCount", label: "인원" },
                { key: "discountRate", label: "할인율" },
                {
                  key: "status",
                  label: "상태",
                  render: (row) => (
                    <Badge variant={STATUS_VARIANTS[row.status] ?? "outline"}>
                      {STATUS_LABELS[row.status] ?? row.status}
                    </Badge>
                  ),
                },
                { key: "orderNumber", label: "주문번호" },
                {
                  key: "id",
                  label: "작업",
                  render: (row) => {
                    // 이미 거절(cancelled)된 예약은 조작 불가. 확정(confirmed)된 예약은 재승인 차단(중복주문 방지) —
                    // 취소만 노출. 대기(pending)만 승인/거절 모두 노출. (감사 P0-9)
                    if (row.status === "cancelled") {
                      return <span className="text-sm text-content-subtle">-</span>;
                    }
                    return (
                      <div className="flex gap-2">
                        {row.status !== "confirmed" ? (
                          <Button size="sm" onClick={() => setConfirmTarget({ id: row.id, action: "confirm" })}>승인</Button>
                        ) : null}
                        <Button size="sm" variant="outline" onClick={() => setConfirmTarget({ id: row.id, action: "cancel" })}>
                          {row.status === "confirmed" ? "취소" : "거절"}
                        </Button>
                      </div>
                    );
                  },
                },
              ]}
            />
          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={confirmTarget !== null}
        title={confirmTarget?.action === "confirm" ? "단체 예약 승인" : "단체 예약 거절"}
        description={confirmTarget?.action === "confirm" ? "이 단체 예약을 승인하시겠습니까?" : "이 단체 예약을 거절하시겠습니까?"}
        pending={confirmAction.pending}
        onConfirm={confirmAction.run}
        onOpenChange={(open) => { if (!open) setConfirmTarget(null); }}
      />
    </div>
  );
}
