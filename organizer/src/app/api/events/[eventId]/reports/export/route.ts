import { csvResponse, buildCSV } from "@/lib/export/csv-builder";
import { withRole } from "@/lib/auth/permissions";
import { formatDate, formatKRW } from "@/lib/format";
import { errorResponse } from "@/lib/apiResponse";
import { logAudit } from "@/lib/audit";
import { getEventReports, V2CommerceError } from "@/lib/v2/commerce-client";
import { EventAccessError, resolveOwnedV2EventId } from "@/lib/v2/event-access";

type Params = { eventId: string };

export const GET = withRole<Params>("organizer", async (request, { session, params }) => {
  const type = new URL(request.url).searchParams.get("type") ?? "sales";

  // 레벨2 컷오버 T2-EVT — go events 앵커 조회 폐기(go event id == v2 event id).
  // 테넌트 경계는 이제 v2 가 강제한다(organizer_ref 불일치 → not found).
  let v2EventId: string | null;
  try {
    v2EventId = await resolveOwnedV2EventId(params.eventId, session.accountId);
  } catch (err: unknown) {
    // 이 라우트에는 전역 try/catch 가 없으므로 여기서 명시 처리 — v2 장애를 409 로 뭉개지 않는다.
    if (err instanceof EventAccessError) {
      return errorResponse("리포트를 내려받지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    throw err;
  }
  if (!v2EventId) {
    // 없거나 내 계정 소유가 아님 — 커머스 집계 read 불가(기존 409 동작 보존).
    return errorResponse("이벤트가 커머스 시스템과 연결되지 않았습니다", 409);
  }

  let csv = "";

  try {
    if (type === "products") {
      // order_items 직접 집계 → v2 products 리포트(sold = refunded 제외, revenue = net).
      const report = await getEventReports(v2EventId, "products");
      csv = buildCSV(report.items, [
        { key: "name", label: "상품명" },
        { key: "sold", label: "판매수" },
        { key: "revenue", label: "매출", format: (value) => formatKRW(Number(value ?? 0)) },
      ]);
    } else if (type === "promo") {
      // orders 직접 집계 → v2 promo 리포트(discount_total: 정률은 null).
      const report = await getEventReports(v2EventId, "promo");
      csv = buildCSV(report.items, [
        { key: "code", label: "프로모코드" },
        { key: "usage_count", label: "사용횟수" },
        {
          key: "discount_total",
          label: "할인액",
          format: (value) => (value == null ? "-" : formatKRW(Number(value))),
        },
      ]);
    } else {
      // orders 직접 집계 → v2 sales 리포트(daily_sales: net 기준).
      const report = await getEventReports(v2EventId, "sales");
      csv = buildCSV(report.daily_sales, [
        { key: "date", label: "날짜", format: (value) => formatDate(String(value ?? "")) },
        { key: "amount", label: "매출", format: (value) => formatKRW(Number(value ?? 0)) },
        { key: "count", label: "주문건수" },
      ]);
    }
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      return errorResponse("리포트 집계 조회에 실패했습니다. 잠시 후 다시 시도해주세요.", 502);
    }
    throw err;
  }

  // 🔴 PII 내려받기 기록 (2026-07-29 감사) — 누가 언제 무엇을 받아갔는지 남긴다.
  //    실패해도 다운로드를 막지 않는다(logAudit 은 내부에서 swallow).
  void logAudit({
    userId: session.id,
    accountId: session.accountId,
    action: "export",
    tableName: `reports:${type}`,
    recordId: params.eventId,
    changes: { bytes: csv.length },
  });

  return csvResponse(csv, `report-${type}-${params.eventId}`);
});
