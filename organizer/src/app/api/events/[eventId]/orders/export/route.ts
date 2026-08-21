import { errorResponse } from "@/lib/apiResponse";
import { logAudit } from "@/lib/audit";
import { withRole } from "@/lib/auth/permissions";
import { ERR } from "@/lib/errors";
import { exportOrders, V2CommerceError } from "@/lib/v2/commerce-client";
import { EventAccessError, resolveOwnedV2EventId } from "@/lib/v2/event-access";

type Params = { eventId: string };

export const GET = withRole<Params>("organizer", async (_request, { params, session }) => {
  // 빅뱅 flip D — go DB JOIN → v2 주문 CSV export(주문 SoT=v2). 평문 text/csv 그대로 전달.
  // ⚠️ v2 CSV 헤더/컬럼은 v2 정의(order_id,external_ref,buyer_name,buyer_email,total_amount,
  //    total_refunded,status,payment_method,ordered_at) — go 기존 한글 헤더/KRW 포맷과 다름(컬럼 shape 변경).
  try {
    // 레벨2 컷오버 T2-EVT — go events 앵커 조회 폐기(go event id == v2 event id).
    // 테넌트 경계는 이제 v2 가 강제한다(organizer_ref 불일치 → not found).
    const v2EventId = await resolveOwnedV2EventId(params.eventId, session.accountId);
    // 없거나 내 계정 소유가 아님 → 기존 404 동작 보존.
    if (!v2EventId) return errorResponse(ERR.NOT_FOUND, 404);

    const csv = await exportOrders(v2EventId);
    // 🔴 PII 내려받기 기록 (2026-07-29 감사) — 누가 언제 무엇을 받아갔는지 남긴다.
    //    실패해도 다운로드를 막지 않는다(logAudit 은 내부에서 swallow).
    void logAudit({
      userId: session.id,
      accountId: session.accountId,
      action: "export",
      tableName: "orders",
      recordId: params.eventId,
      changes: { bytes: csv.length },
    });
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="orders-${params.eventId}.csv"`,
      },
    });
  } catch (err: unknown) {
    // v2 장애를 404("이벤트 없음")로 뭉개지 않는다 — 재시도 가능 신호(503).
    if (err instanceof EventAccessError) {
      return errorResponse("주문 데이터를 내려받지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    if (err instanceof V2CommerceError) {
      if (err.status === 404) return errorResponse("이벤트를 찾을 수 없습니다", 404);
      return errorResponse("주문 데이터를 불러오지 못했습니다", 502);
    }
    return errorResponse(err instanceof Error ? err.message : "알 수 없는 오류", 500);
  }
});
