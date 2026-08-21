import { errorResponse } from "@/lib/apiResponse";
import { logAudit } from "@/lib/audit";
import { withRole } from "@/lib/auth/permissions";
import { ERR } from "@/lib/errors";
import { exportAttendees, V2CommerceError } from "@/lib/v2/commerce-client";
import { EventAccessError, resolveOwnedV2EventId } from "@/lib/v2/event-access";

type Params = { eventId: string };

export const GET = withRole<Params>("organizer", async (_request, { params, session }) => {
  // 빅뱅 flip D — go DB JOIN → v2 참석자 CSV export(ticket SoT=v2). 평문 text/csv 그대로 전달.
  // ⚠️ v2 CSV 헤더/컬럼은 v2 정의(ticket_id,order_id,owner_user_id,product_name,status,checked_in_at)
  //    — go 기존 한글 헤더(티켓번호/이름/이메일/전화/주문번호 등)와 다름. name/email/phone 은 v2 미보유.
  // 참고: 현장 check-in 상세 로그(check_in_logs)는 go-local boundary 로 별도 유지(여긴 참석자 집계 export).
  try {
    // 레벨2 컷오버 T2-EVT — go events 앵커 조회 폐기(go event id == v2 event id).
    // 테넌트 경계는 이제 v2 가 강제한다(organizer_ref 불일치 → not found).
    const v2EventId = await resolveOwnedV2EventId(params.eventId, session.accountId);
    // 없거나 내 계정 소유가 아님 → 기존 404 동작 보존.
    if (!v2EventId) return errorResponse(ERR.NOT_FOUND, 404);

    const csv = await exportAttendees(v2EventId);
    // 🔴 PII 내려받기 기록 (2026-07-29 감사) — 누가 언제 무엇을 받아갔는지 남긴다.
    //    실패해도 다운로드를 막지 않는다(logAudit 은 내부에서 swallow).
    void logAudit({
      userId: session.id,
      accountId: session.accountId,
      action: "export",
      tableName: "attendees",
      recordId: params.eventId,
      changes: { bytes: csv.length },
    });
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="attendees-${params.eventId}.csv"`,
      },
    });
  } catch (err: unknown) {
    // v2 장애를 404("이벤트 없음")로 뭉개지 않는다 — 재시도 가능 신호(503).
    if (err instanceof EventAccessError) {
      return errorResponse("참석자 데이터를 내려받지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    if (err instanceof V2CommerceError) {
      if (err.status === 404) return errorResponse("이벤트를 찾을 수 없습니다", 404);
      return errorResponse("참석자 데이터를 불러오지 못했습니다", 502);
    }
    return errorResponse(err instanceof Error ? err.message : "알 수 없는 오류", 500);
  }
});
