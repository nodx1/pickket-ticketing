/**
 * 트랙 7.14 — 좌석맵 인쇄 PDF (A3/A4)
 *
 * 현장 운영자가 좌석맵을 종이로 출력할 수 있게 한다.
 * - 좌석 번호 + tier 색상 + 매진/예약 상태 색상 표시
 * - 네트워크 끊긴 현장에서도 사용 가능
 *
 * GET /api/events/{eventId}/seat-maps/{mapId}/print?paper=a3|a4
 */
import React from "react";
import { renderToBuffer, type DocumentProps } from "@react-pdf/renderer";
import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";
import { errorResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { seatMetrics } from "@/lib/seats/metrics";
import { fetchV2SeatLiveMap } from "@/lib/seats/v2-status";
import { fetchSeatMapEntry } from "@/lib/v2/seat-map-payload";
import { V2CommerceError } from "@/lib/v2/commerce-client";
import { EventAccessError, requireOwnedEvent } from "@/lib/v2/event-access";

type Params = { eventId: string; mapId: string };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATUS_COLOR: Record<string, string> = {
  available: "#10b981",
  held: "#f59e0b",
  reserved: "#9ca3af",
  sold: "#9ca3af",
  blocked: "#1f2937",
};

const STATUS_LABEL: Record<string, string> = {
  available: "○",
  held: "△",
  reserved: "✕",
  sold: "✕",
  blocked: "■",
};

interface PrintSeat {
  id: string;
  section: string;
  row: string;
  seatNumber: string;
  status: string;
}

interface PrintProps {
  mapName: string;
  eventName: string;
  seats: PrintSeat[];
}

const styles = StyleSheet.create({
  page: { padding: 24, fontSize: 9 },
  header: { fontSize: 14, fontWeight: 700, marginBottom: 4 },
  subtitle: { fontSize: 10, color: "#6b7280", marginBottom: 12 },
  legend: { flexDirection: "row", gap: 12, marginBottom: 8, fontSize: 8 },
  legendItem: { flexDirection: "row", gap: 4 },
  sectionBlock: { marginBottom: 12 },
  sectionTitle: { fontSize: 11, fontWeight: 700, marginBottom: 4 },
  rowLine: { flexDirection: "row", flexWrap: "wrap", gap: 2, marginBottom: 2 },
  seat: {
    width: 38,
    paddingVertical: 2,
    paddingHorizontal: 3,
    borderWidth: 0.5,
    borderColor: "#d1d5db",
    fontSize: 7,
    textAlign: "center",
  },
});

function buildDocument(props: PrintProps): React.ReactElement<DocumentProps> {
  const { mapName, eventName, seats } = props;

  // 섹션별 → 행별 그룹화
  const grouped = new Map<string, Map<string, PrintSeat[]>>();
  for (const s of seats) {
    if (!grouped.has(s.section)) grouped.set(s.section, new Map());
    const rows = grouped.get(s.section)!;
    if (!rows.has(s.row)) rows.set(s.row, []);
    rows.get(s.row)!.push(s);
  }

  const legendItems = (
    [
      ["available", "가능"],
      ["held", "홀드"],
      ["sold", "판매/예약"],
      ["blocked", "차단"],
    ] as const
  ).map(([key, label]) =>
    React.createElement(
      View,
      { key, style: styles.legendItem },
      React.createElement(
        Text,
        { style: { color: STATUS_COLOR[key] } },
        STATUS_LABEL[key],
      ),
      React.createElement(Text, null, label),
    ),
  );

  const sectionBlocks = Array.from(grouped.entries()).map(([section, rows]) => {
    const rowEls = Array.from(rows.entries()).map(([row, rowSeats]) => {
      const seatEls = rowSeats
        .sort((a, b) => Number(a.seatNumber) - Number(b.seatNumber))
        .map((s) =>
          React.createElement(
            Text,
            {
              key: s.id,
              style: [styles.seat, { color: STATUS_COLOR[s.status] ?? "#000" }],
            },
            `${row}-${s.seatNumber}${STATUS_LABEL[s.status] ?? ""}`,
          ),
        );
      return React.createElement(View, { key: row, style: styles.rowLine }, ...seatEls);
    });

    return React.createElement(
      View,
      { key: section, style: styles.sectionBlock },
      React.createElement(Text, { style: styles.sectionTitle }, `${section}섹션`),
      ...rowEls,
    );
  });

  return React.createElement(
    Document,
    null,
    React.createElement(
      Page,
      { size: "A3", style: styles.page, orientation: "landscape" },
      React.createElement(Text, { style: styles.header }, eventName),
      React.createElement(
        Text,
        { style: styles.subtitle },
        `${mapName} · 총 ${seats.length}석 · 발행일 ${new Date().toISOString().slice(0, 10)}`,
      ),
      React.createElement(View, { style: styles.legend }, ...legendItems),
      ...sectionBlocks,
    ),
  );
}

export const GET = withRole<Params>(
  "staff",
  async (_request, { session, params }) => {
    if (!UUID_RE.test(params.mapId)) {
      return errorResponse("잘못된 좌석맵 ID 입니다", 400);
    }
    // ── W2-PS — 맵 헤더·좌석·이벤트명 전부 v2 read(go `events`/`seat_maps`/`seats` 미read) ──
    // 소유권 판정도 fetchSeatMapEntry 가 함께 수행(계정 소유 이벤트 + 맵 존재).
    let owned: Awaited<ReturnType<typeof fetchSeatMapEntry>>;
    let live: Awaited<ReturnType<typeof fetchV2SeatLiveMap>> | null = null;
    let eventName = "";
    try {
      owned = await fetchSeatMapEntry(null, params.eventId, params.mapId, session.accountId);
      if (owned) {
        // 이벤트명은 종전 go `SELECT title FROM events` → v2 상세(소유 검증 포함).
        const [liveSeats, event] = await Promise.all([
          fetchV2SeatLiveMap(owned.v2EventId),
          requireOwnedEvent(params.eventId, session.accountId),
        ]);
        live = liveSeats;
        eventName = event.title;
      }
    } catch (err: unknown) {
      // 🔴 레벨2 T2-EVT — fetchSeatMapEntry 의 소유 검증이 v2 조회로 바뀌면서 v2 응답불가는
      //    V2CommerceError 가 아니라 EventAccessError 로 온다(안 잡으면 정체불명 500).
      //    404(없음)와 분리해 재시도 가능한 503 으로 통지한다.
      if (err instanceof EventAccessError) {
        // not_found 는 소유/존재 실패라 404, 그 외(v2 응답불가)는 503.
        return err.reason === "not_found"
          ? errorResponse("좌석맵을 찾을 수 없습니다", 404)
          : errorResponse("이벤트 정보를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
      }
      if (err instanceof V2CommerceError) {
        return errorResponse("좌석맵을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
      }
      throw err;
    }
    if (!owned || !live) {
      return errorResponse("좌석맵을 찾을 수 없습니다", 404);
    }

    const seats: PrintSeat[] = [...live.byGoSeatId.values()]
      .map((s) => ({
        id: s.seatId,
        section: s.section,
        row: s.row,
        seatNumber: s.seatNumber,
        status: s.status,
      }))
      .sort(
        (a, b) =>
          a.section.localeCompare(b.section) ||
          a.row.localeCompare(b.row) ||
          (Number(a.seatNumber) || 0) - (Number(b.seatNumber) || 0),
      );

    const document = buildDocument({
      mapName: owned.entry.name,
      eventName,
      seats,
    });

    const buffer = await renderToBuffer(document);
    seatMetrics.incrementPrintPdf();

    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="seat-map-${params.mapId}.pdf"`,
      },
    });
  },
);
