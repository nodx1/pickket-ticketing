/**
 * 발송 상세 — 수신자별 도달/오픈/클릭/실패 사유. 실측 기반(가짜지표 아님).
 * status 쿼리로 필터(예: ?status=failed), format=csv 로 내보내기.
 *
 * 원장은 v2 소유(레벨2 컷오버 W5-MSG). go DB SQL 0.
 * 🔴 소유 검증과 연락처 마스킹은 **v2 가** 수행한다 — 원문 연락처는 API 밖으로 나오지 않는다.
 */
import { withRole } from "@/lib/auth/permissions";
import { listResponse, successResponse, errorResponse } from "@/lib/apiResponse";
import {
  listMessageDeliveries,
  ledgerErrorStatus,
  V2MessagingLedgerError,
} from "@/lib/v2/messaging-ledger-client";
import { ERR } from "@/lib/errors";

type Params = { eventId: string; messageId: string };

export const GET = withRole<Params>("organizer", async (request, { session, params }) => {
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const format = url.searchParams.get("format");
  // L-01: NaN/음수 방어 — Number("abc")=NaN 은 ?? 로 안 걸러진다.
  const parsePageInt = (v: string | null, def: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : def;
  };
  const offset = parsePageInt(url.searchParams.get("offset"), 0);
  // CSV 는 전량(최대 5000), JSON 은 페이지(기본 100, 1~500).
  const limit =
    format === "csv"
      ? 5000
      : Math.min(Math.max(parsePageInt(url.searchParams.get("limit"), 100), 1), 500);

  let page: Awaited<ReturnType<typeof listMessageDeliveries>>;
  try {
    page = await listMessageDeliveries(session.accountId, params.eventId, params.messageId, {
      status,
      limit,
      offset,
    });
  } catch (err: unknown) {
    // 🔴 fail-closed: 조회 실패를 빈 목록으로 흘리면 "0명에게 발송"으로 보인다.
    if (err instanceof V2MessagingLedgerError) {
      return errorResponse(err.message, ledgerErrorStatus(err));
    }
    return errorResponse(ERR.SERVER, 500);
  }
  // null = 미소유/미존재 메시지(옛 go 동작과 동일하게 빈 목록).
  if (!page) return listResponse([], 0);

  if (format === "csv") {
    const header = "contact,status,reason,channel,delivered_at,opened_at,clicked_at";
    const csvRows = page.items.map((r) =>
      [
        r.contact_masked,
        r.status,
        (r.reason ?? "").replace(/[",\n]/g, " "),
        r.channel,
        r.delivered_at ?? "",
        r.opened_at ?? "",
        r.clicked_at ?? "",
      ].join(","),
    );
    const csv = `﻿${header}\n${csvRows.join("\n")}`; // BOM(엑셀 한글).
    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="deliveries-${params.messageId}.csv"`,
      },
    });
  }

  return successResponse({
    items: page.items.map((r) => ({
      contact: r.contact_masked,
      status: r.status,
      reason: r.reason,
      channel: r.channel,
      deliveredAt: r.delivered_at,
      openedAt: r.opened_at,
      clickedAt: r.clicked_at,
      updatedAt: r.updated_at,
    })),
    total: page.total,
    pageSize: page.items.length,
    offset,
    summary: page.summary,
  });
});
