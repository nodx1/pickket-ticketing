"use client";

/**
 * 이벤트 상태 카드 — 현재 상태 배지 + 주최자가 가능한 전이 액션 버튼.
 *
 * 드롭다운 대신 버튼 기반 UX — 상태머신 `allowedNextStates()` 에 따라 동적으로 렌더링.
 * 상태 변경은 PATCH /api/events/{id} 로 위임 (서버에서 canTransition 검증).
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { showError, showSuccess } from "@/lib/hooks/useToast";
import type { EventStatus } from "@/lib/events/status-machine";
import { fetchWithRefresh } from "@/lib/fetchWithAuth";
import { formatDateTimeSecKst } from "@/lib/format";

interface Props {
  eventId: string;
  status: EventStatus;
  rejectionReason?: string | null;
  approvedAt?: string | null;
}

interface ActionDef {
  key: string;
  targetStatus: EventStatus;
  label: string;
  confirmTitle: string;
  confirmDescription: string;
  confirmText: string;
  successMessage: string;
}

const STATUS_LABEL: Record<EventStatus, string> = {
  draft: "초안",
  pending_review: "심사 중",
  rejected: "반려됨",
  live: "판매 중",
  paused: "일시중지",
  archived: "보관됨",
};

const STATUS_BADGE_CLASS: Record<EventStatus, string> = {
  draft: "bg-muted text-muted-foreground",
  pending_review: "bg-warning/10 text-warning",
  rejected: "bg-error/10 text-error",
  live: "bg-success/10 text-success",
  paused: "bg-primary/10 text-primary",
  archived: "bg-muted text-muted-foreground",
};

function actionsFor(status: EventStatus): ActionDef[] {
  switch (status) {
    case "live":
      return [
        {
          key: "pause",
          targetStatus: "paused",
          label: "일시중지",
          confirmTitle: "판매를 일시중지할까요?",
          confirmDescription:
            "팬들이 더 이상 티켓을 구매할 수 없게 됩니다. 언제든 재개할 수 있어요.",
          confirmText: "일시중지",
          successMessage: "이벤트가 일시중지되었습니다",
        },
        {
          key: "archive-from-live",
          targetStatus: "archived",
          label: "보관하기",
          confirmTitle: "이벤트를 보관할까요?",
          confirmDescription:
            "보관된 이벤트는 공개 목록에서 사라지고 되돌릴 수 없습니다.",
          confirmText: "보관",
          successMessage: "이벤트가 보관되었습니다",
        },
      ];
    case "paused":
      return [
        {
          key: "resume",
          targetStatus: "live",
          label: "판매 재개",
          confirmTitle: "판매를 재개할까요?",
          confirmDescription: "팬들이 다시 티켓을 구매할 수 있게 됩니다.",
          confirmText: "재개",
          successMessage: "이벤트 판매가 재개되었습니다",
        },
        {
          key: "archive-from-paused",
          targetStatus: "archived",
          label: "보관하기",
          confirmTitle: "이벤트를 보관할까요?",
          confirmDescription:
            "보관된 이벤트는 공개 목록에서 사라지고 되돌릴 수 없습니다.",
          confirmText: "보관",
          successMessage: "이벤트가 보관되었습니다",
        },
      ];
    case "pending_review":
      return [
        {
          key: "withdraw",
          targetStatus: "draft",
          label: "심사 요청 철회",
          confirmTitle: "심사 요청을 철회할까요?",
          confirmDescription:
            "초안으로 돌아갑니다. 다시 심사를 받으려면 게시 준비에서 재요청해 주세요.",
          confirmText: "철회",
          successMessage: "심사 요청이 철회되었습니다",
        },
      ];
    case "rejected":
      return [
        {
          key: "to-draft",
          targetStatus: "draft",
          label: "수정하기",
          confirmTitle: "초안으로 돌리시겠어요?",
          confirmDescription:
            "수정 후 게시 준비에서 다시 심사를 요청할 수 있습니다.",
          confirmText: "수정하기",
          successMessage: "초안 상태로 돌아갔습니다",
        },
        {
          key: "resubmit",
          targetStatus: "pending_review",
          label: "재심사 요청",
          confirmTitle: "반려된 내용으로 재심사를 요청할까요?",
          confirmDescription:
            "반려 사유를 해결했다면 바로 재요청할 수 있어요. 수정이 더 필요하면 먼저 수정하기를 선택하세요.",
          confirmText: "재심사 요청",
          successMessage: "재심사가 요청되었습니다",
        },
        {
          key: "archive-from-rejected",
          targetStatus: "archived",
          label: "보관하기",
          confirmTitle: "이벤트를 보관할까요?",
          confirmDescription:
            "보관된 이벤트는 공개 목록에서 사라지고 되돌릴 수 없습니다.",
          confirmText: "보관",
          successMessage: "이벤트가 보관되었습니다",
        },
      ];
    case "draft":
    case "archived":
    default:
      return [];
  }
}

function guideText(status: EventStatus): string | null {
  switch (status) {
    case "draft":
      return "이 이벤트를 공개하려면 게시 준비에서 체크리스트를 완료하고 심사 요청을 진행하세요.";
    case "pending_review":
      return "운영팀이 이벤트를 검토하고 있어요. 승인되면 자동으로 판매가 시작됩니다.";
    case "rejected":
      return "반려 사유를 확인하고 수정 후 재심사를 요청하세요.";
    case "live":
      return "팬들이 티켓을 구매할 수 있는 상태입니다.";
    case "paused":
      return "판매가 일시 중단되었습니다. 재개하기 전까지 구매가 불가합니다.";
    case "archived":
      return "보관된 이벤트입니다. 더 이상 상태를 변경할 수 없습니다.";
    default:
      return null;
  }
}

export function EventStatusCard({ eventId, status, rejectionReason, approvedAt }: Props) {
  const router = useRouter();
  const [pending, setPending] = useState<ActionDef | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const actions = actionsFor(status);
  const guide = guideText(status);

  async function doTransition(action: ActionDef) {
    setSubmitting(true);
    try {
      const res = await fetchWithRefresh(`/api/events/${eventId}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: action.targetStatus }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "상태 변경에 실패했습니다");
      }
      showSuccess(action.successMessage);
      setPending(null);
      router.refresh();
    } catch (err) {
      showError(err instanceof Error ? err.message : "상태 변경에 실패했습니다");
      // 🔴 실패해도 서버 상태를 다시 읽는다 (2026-07-30 감사).
      //    응답이 유실됐을 뿐 서버가 전이를 완료한 경우, 옛 화면을 보고 재시도하면 중복 전이가
      //    나간다. refresh 로 실제 status 를 가져오면 그 전이 버튼이 사라지거나 바뀌어,
      //    사용자가 잘못된 재시도를 하지 않게 된다. (성공 경로와 동일한 호출)
      //    ※ 클라이언트 state 는 refresh 로 지워지지 않는다 — 프로덕션 빌드로 실측 확인.
      setPending(null);
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle>공개 상태</CardTitle>
          <span
            className={`rounded-full px-3 py-1 text-xs font-semibold ${STATUS_BADGE_CLASS[status]}`}
          >
            {STATUS_LABEL[status]}
          </span>
        </CardHeader>
        <CardContent className="space-y-4">
          {guide && <p className="text-sm text-muted-foreground">{guide}</p>}

          {status === "rejected" && rejectionReason && (
            <div className="rounded-md border border-error/30 bg-error/5 p-3 text-sm">
              <p className="font-semibold text-error">반려 사유</p>
              <p className="mt-1 text-foreground/80">{rejectionReason}</p>
            </div>
          )}

          {status === "live" && approvedAt && (
            <p className="text-xs text-muted-foreground">
              승인일: {formatDateTimeSecKst(approvedAt)}
            </p>
          )}

          {status === "draft" && (
            <div>
              <Button onClick={() => router.push(`/events/${eventId}/publish`)}>
                게시 준비로 이동 →
              </Button>
            </div>
          )}

          {actions.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {actions.map((a) => (
                <Button
                  key={a.key}
                  variant={a.targetStatus === "archived" ? "outline" : "secondary"}
                  onClick={() => setPending(a)}
                  disabled={submitting}
                >
                  {a.label}
                </Button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={pending?.confirmTitle ?? ""}
        description={pending?.confirmDescription ?? ""}
        confirmText={pending?.confirmText ?? "확인"}
        // 🔴 비가역 동작(게시·취소·보관) — 확인 버튼을 잠근다.
        //    종전엔 바깥 액션 버튼만 `disabled={submitting}` 이라, 확인창 안에서는 응답을
        //    기다리는 동안 몇 번이든 다시 눌려 같은 전이 요청이 중복으로 나갈 수 있었다.
        //    ⚠️ 로컬 state `pending`(어떤 액션을 확인 중인가)과 이 prop `pending`(진행 중인가)은
        //       **이름만 같고 뜻이 다르다.** 넘기는 값은 `submitting` 이다.
        pending={submitting}
        onConfirm={() => {
          if (pending) void doTransition(pending);
        }}
      />
    </>
  );
}
