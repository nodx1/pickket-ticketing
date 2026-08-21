import { csvResponse, buildCSV } from "@/lib/export/csv-builder";
import { errorResponse } from "@/lib/apiResponse";
import { logAudit } from "@/lib/audit";
import { withRole } from "@/lib/auth/permissions";
import { formatDate } from "@/lib/format";
import { listCheckInLogs, V2CommerceError } from "@/lib/v2/commerce-client";

/**
 * 레벨2 컷오버 W5-ATTENDEE — 체크인 로그 CSV 를 v2 정본에서 읽는다.
 *
 * 표시값(참석자명·티켓번호)은 여전히 **기록 시점 스냅샷**이다(mig247 결정을 v2 로 승계).
 * CSV 한 장에 티켓 수만큼 재조회를 붙이지 않는다 — 현장 원장은 그 시점 값이 정확한 값이다.
 *
 * 🔴 fail-closed: v2 실패를 **빈 CSV** 로 내보내지 않는다. 빈 정산·감사 자료는 "입장자 0명"
 *    이라는 사실 주장이 된다 → 503.
 */
type Params = { eventId: string };

// 현장 원장 전량 — v2 로그 목록 상한(20000) 이내.
const EXPORT_LIMIT = 20000;

export const GET = withRole<Params>("organizer", async (_request, { session, params }) => {
  let rows: Array<{
    createdAt: string | null;
    attendeeName: string | null;
    ticketNumber: string | null;
    method: string;
    listName: string | null;
  }>;
  try {
    const { logs } = await listCheckInLogs(params.eventId, session.accountId, {
      limit: EXPORT_LIMIT,
    });
    rows = logs.map((log) => ({
      createdAt: log.created_at,
      attendeeName: log.attendee_name,
      ticketNumber: log.ticket_number,
      method: log.method,
      listName: log.list_name,
    }));
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      return errorResponse("체크인 기록을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    throw err;
  }

  const csv = buildCSV(rows, [
    { key: "createdAt", label: "시간", format: (value) => formatDate(String(value ?? "")) },
    { key: "attendeeName", label: "참석자명" },
    { key: "ticketNumber", label: "티켓번호" },
    {
      key: "method",
      label: "방법",
      format: (value) =>
        value === "qr" ? "QR" : value === "manual" ? "수동" : value === "offline" ? "오프라인" : "검색",
    },
    { key: "listName", label: "리스트명" },
  ]);

  // 🔴 PII 내려받기 기록 (2026-07-29 감사) — 누가 언제 무엇을 받아갔는지 남긴다.
  //    실패해도 다운로드를 막지 않는다(logAudit 은 내부에서 swallow).
  void logAudit({
    userId: session.id,
    accountId: session.accountId,
    action: "export",
    tableName: "check_in_logs",
    recordId: params.eventId,
    changes: { bytes: csv.length },
  });

  return csvResponse(csv, `check-in-${params.eventId}`);
});
