"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { Button } from "@/components/ui/button";
import { showError, showSuccess } from "@/lib/hooks/useToast";
import type { EventStatus } from "@/lib/events/status-machine";
import { fetchWithRefresh } from "@/lib/fetchWithAuth";

/**
 * 삭제 영향 범위.
 *
 * ── 레벨2 컷오버 W3-OPS ──
 *  · `bids`(응모자) 제거 — mig233 에서 go `bids`·`allocation_sessions` 가 DROP 됐다(추첨=v2).
 *    표시할 원천 자체가 없다.
 *  · `seats` 는 v2 live read 라 **조회 실패가 존재**한다. 0 으로 뭉개면 "지워질 좌석 없음"이라는
 *    거짓 안심을 주므로 `null`(=확인 불가)을 별도 상태로 표시한다.
 */
interface Impact {
  attendees: number;
  seats: number | null;
  orders: number;
}

interface Props {
  eventId: string;
  status: EventStatus;
  impact: Impact;
}

const STATUS_LABEL: Record<EventStatus, string> = {
  draft: "초안",
  pending_review: "심사 중",
  rejected: "반려됨",
  live: "판매 중",
  paused: "일시중지",
  archived: "보관됨",
};

export function EventDangerZone({ eventId, status, impact }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // archived 는 더 변경 불가 — 카드 자체 숨김
  if (status === "archived") return null;

  // live/paused 는 환불 플로우가 동반되어야 안전 — 별도 작업 예정. 현재는 노출 차단.
  // (status-card 의 보관 액션도 잠재 위험. 결제 붙기 전까진 수동 운영자가 처리.)
  const showDelete = status === "draft" || status === "rejected" || status === "pending_review";
  if (!showDelete) return null;

  // 좌석수 확인 불가(v2 장애)도 "활동 있음"으로 취급한다 — 모르는 상태에서 조용히 안전하다고
  // 표시하는 쪽이 파괴적 액션에서는 더 위험하다(fail-closed).
  const hasActivity =
    impact.attendees > 0 || impact.orders > 0 || impact.seats === null || impact.seats > 0;

  async function handleDelete() {
    setSubmitting(true);
    try {
      const res = await fetchWithRefresh(`/api/events/${eventId}`, {
        method: "DELETE",
        credentials: "include",
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? "삭제에 실패했습니다");
      }

      showSuccess("이벤트가 삭제되었습니다");
      router.push("/events");
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "이벤트 삭제에 실패했습니다");
      setSubmitting(false);
    }
  }

  return (
    <div className="rounded-lg border border-error/30 bg-error/5 p-6">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 size-5 shrink-0 text-error" />
        <div className="flex-1">
          <h3 className="font-bold text-error">위험 영역</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            잘못 만든 이벤트나 더 이상 진행하지 않는 이벤트를 삭제할 수 있습니다.
            삭제된 이벤트는 보관됨 상태로 전환되며 공개 목록에서 제거됩니다.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-4 border-error/40 text-error hover:bg-error hover:text-white"
            onClick={() => setOpen(true)}
            disabled={submitting}
          >
            이벤트 삭제
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={open}
        onOpenChange={(v) => {
          if (!submitting) setOpen(v);
        }}
        title="이벤트를 삭제할까요?"
        description={
          <div className="space-y-3 text-sm">
            <p>
              현재 상태: <strong>{STATUS_LABEL[status]}</strong>
            </p>
            <div className="rounded-md bg-muted/40 p-3">
              <p className="mb-2 text-xs font-semibold text-muted-foreground">영향 범위</p>
              <ul className="space-y-1 text-foreground">
                <li>• 참석자 {impact.attendees.toLocaleString("ko-KR")}명</li>
                <li>
                  • 좌석{" "}
                  {impact.seats === null
                    ? "확인 불가 (좌석 서버 응답 없음)"
                    : `${impact.seats.toLocaleString("ko-KR")}개`}
                </li>
                <li>• 주문 {impact.orders.toLocaleString("ko-KR")}건</li>
              </ul>
            </div>
            {hasActivity && (
              <p className="rounded-md border border-warning/30 bg-warning/5 p-2 text-xs text-warning">
                ⚠️ 이미 활동(주문/참석자/좌석) 이 있거나 영향 범위를 확인하지 못했습니다. 정말
                삭제하시겠어요?
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              삭제는 되돌릴 수 없습니다. 마켓에서도 즉시 제거됩니다.
            </p>
          </div>
        }
        confirmText="삭제"
        // 🔴 비가역 동작 — 확인 버튼을 잠근다. 종전엔 `confirmText` 만 "삭제 중..." 으로 바뀌고
        //    버튼은 계속 눌려서, 응답이 느리면 삭제 요청이 여러 번 나갈 수 있었다.
        //    (문구 전환은 ConfirmDialog 가 pending 을 받아 "처리 중..." 으로 대체한다.)
        pending={submitting}
        onConfirm={() => void handleDelete()}
      />
    </div>
  );
}
