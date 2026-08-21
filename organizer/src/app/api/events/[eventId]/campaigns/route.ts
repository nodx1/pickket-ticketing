/**
 * 이메일 캠페인 목록 — 원장은 v2 소유(레벨2 컷오버 W5-MSG). go DB SQL 0.
 *
 * ⚠️ 캠페인은 폐기하지 않는다(대표 결정 2026-07-27). 신규 **생성**만 동결(410)돼 메시지
 *   작성기로 수렴했고, 기존 캠페인의 조회·발송·통계는 그대로 살아 있다.
 */
import { withAuth } from "@/lib/auth/withAuth";
import { withRole } from "@/lib/auth/permissions";
import { successResponse, errorResponse } from "@/lib/apiResponse";
import {
  ledgerErrorStatus,
  listCampaigns,
  V2MessagingLedgerError,
} from "@/lib/v2/messaging-ledger-client";

export const GET = withAuth(async (_request, { session, params }) => {
  const { eventId } = params as { eventId: string };
  try {
    const rows = await listCampaigns(session.accountId, eventId);
    return successResponse(
      rows.map((c) => ({
        id: c.id,
        subject: c.subject,
        status: c.status,
        stats: c.stats,
        scheduledAt: c.scheduled_at,
        sentAt: c.sent_at,
        createdAt: c.created_at,
      })),
    );
  } catch (err: unknown) {
    // 🔴 fail-closed: 빈 배열로 흘리면 "캠페인 없음"으로 보여 발송 이력이 사라진 것처럼 된다.
    if (err instanceof V2MessagingLedgerError) {
      return errorResponse(err.message, ledgerErrorStatus(err));
    }
    return errorResponse("캠페인 목록 조회에 실패했습니다", 500);
  }
});

// 캠페인 → 메시지 통합 동결(계획서 §3-3 1단계).
// 신규 캠페인 생성은 메시지 작성기(event_messages)로 수렴한다. 파괴적 폐기가 아니라 진입
// 차단이며, 기존 캠페인 조회(GET)·발송(send)·예약 소진은 유지된다. UI 리다이렉트를 우회한
// 직접 API 호출도 이 fail-safe 로 신규 생성이 막힌다.
export const POST = withRole<{ eventId: string }>("organizer", async () => {
  return errorResponse(
    "이메일 캠페인은 메시지로 통합되었습니다. 메시지 작성기에서 이메일 채널·목적을 홍보로 선택해 발송해주세요.",
    410,
  );
});
