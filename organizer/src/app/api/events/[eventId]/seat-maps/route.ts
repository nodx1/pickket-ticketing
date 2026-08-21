import crypto from "node:crypto";

import { z } from "zod";
import { listResponse, errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { V2CommerceError } from "@/lib/v2/commerce-client";
import { EventAccessError, requireOwnedEvent } from "@/lib/v2/event-access";
import { pushGridLayoutToV2 } from "@/lib/v2/grid-layout-sync";
import { pushSeatMapData } from "@/lib/v2/seat-map-payload";
import { buildMapHeaderDelta } from "@/lib/seats/seat-map-delta";
import { syncCapacityFromLayout } from "@/lib/seats/capacity";
import { writeThroughLayoutSeats } from "@/lib/seats/seat-writethrough";
import { generateSeatsFromCanvas } from "@/lib/seats/seat-generator";

type Params = { eventId: string };

const figmaSectionSchema = z.object({
  name: z.string().min(1),
  x: z.number(),
  y: z.number(),
  rotation: z.number().default(0),
  tierId: z.string().uuid().nullable().optional(),
  kind: z.enum(["assigned", "standing", "stage", "console"]).default("assigned"),
  // 지정석 전용
  rows: z.number().int().min(1).max(30).optional(),
  seatsPerRow: z.number().int().min(1).max(50).optional(),
  blockedPositions: z.array(z.string()).optional(), // "rowIdx-seatIdx"
  // 스탠딩 전용
  capacity: z.number().int().min(1).max(10000).optional(),
  // stage/standing 커스텀 크기
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
});

const schema = z
  .object({
    name: z.string().min(2, "배치도 이름을 입력해주세요"),
    sections: z.array(z.string().min(1)).optional(),
    rowsPerSection: z.number().int().min(1).max(26).optional(),
    seatsPerRow: z.number().int().min(1).max(100).optional(),
    figmaLayout: z
      .object({
        sections: z.array(figmaSectionSchema).min(1),
      })
      .optional(),
  })
  .refine(
    (data) =>
      data.figmaLayout !== undefined ||
      (data.sections !== undefined &&
        data.rowsPerSection !== undefined &&
        data.seatsPerRow !== undefined),
    { message: "격자(sections + rowsPerSection + seatsPerRow) 또는 figmaLayout 중 하나는 필요합니다" },
  );

export const GET = withRole<Params>("staff", async (_request, { session, params }) => {
  // ── W2-PS — 마지막 go read(`SELECT 1 FROM events` 소유 확인) 제거 ──
  // 소유 검증과 배치도 read 를 v2 한 번의 호출로 합친다(`requireOwnedEvent` 가 상세를 그대로 반환).
  // 테넌트 경계는 v2 `organizer_ref` 가 강제한다(불일치/미존재 → 404).
  // 🔴 v2 장애를 **빈 목록으로 위장하지 않는다** — 종전엔 앵커 미준비를 `listResponse([], 0)` 로
  //    흡수했는데, 이제 v2 가 유일 저장소라 빈 목록은 "배치도를 다 지웠다"로 읽힌다 → 503.
  try {
    const event = await requireOwnedEvent(params.eventId, session.accountId);
    const maps = event.content?.seat_map_data?.maps ?? [];
    const rows = maps.map((m) => ({
      id: m.id,
      name: m.name,
      status: m.status,
      mapData: m.map_data ?? null,
      createdAt: null,
      updatedAt: null,
    }));
    return listResponse(rows, rows.length);
  } catch (err: unknown) {
    if (err instanceof EventAccessError) {
      if (err.reason === "not_found") return errorResponse("이벤트를 찾을 수 없습니다.", 404);
      return errorResponse("좌석 배치도를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    if (err instanceof V2CommerceError) {
      return errorResponse("좌석 배치도를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    throw err;
  }
});

export const POST = withRole<Params>("organizer", async (request, { session, params }) => {
  try {
    const body = schema.parse(await request.json());

    // 피그마 모드는 저장 즉시 published — 퍼블릭 구매 페이지 노출 목적
    const initialStatus = body.figmaLayout ? "published" : "draft";
    // 레벨2 3차 3.1 — 배치도 원본(map_data) 캔버스. delta 로 v2 에 전송(draft 도 항상).
    const mapDataObj = body.figmaLayout
      ? { mode: "figma", figmaLayout: body.figmaLayout }
      : {
          mode: "grid",
          sections: body.sections,
          rowsPerSection: body.rowsPerSection,
          seatsPerRow: body.seatsPerRow,
        };
    // ── 레벨2 컷오버 T1 — go seat_maps/seats INSERT 폐기 ──
    // 맵 id 는 앱에서 발급하고(이전엔 go INSERT ... RETURNING id), 좌석은 캔버스에서 파생해
    // v2 로 직접 보낸다. go 는 정원 비정규화(events.max_attendees / seat_tiers.capacity)만 담당.
    const mapId = crypto.randomUUID();
    const layout = generateSeatsFromCanvas(mapId, mapDataObj);

    // 소유권 가드(W2-PS: go `events` SELECT → v2). 크로스테넌트 방지.
    // 🔴 확인 불가(v2 장애)를 404 로 뭉개지 않는다 — 소유 검증에 실패한 채 아래 write 로 넘어가면
    //    타 테넌트 이벤트에 배치도를 쓸 수 있다. 503 으로 끊는다.
    try {
      await requireOwnedEvent(params.eventId, session.accountId);
    } catch (err: unknown) {
      if (err instanceof EventAccessError) {
        return err.reason === "not_found"
          ? errorResponse("이벤트를 찾을 수 없습니다.", 404)
          : errorResponse("이벤트 정보를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
      }
      throw err;
    }

    // ── v2 write-through — 이제 v2 가 유일한 저장소다(go 스테이징 없음). ──
    // 순서가 중요하다: **맵 헤더 먼저, 좌석 나중**.
    //  - 헤더만 성공하고 좌석이 실패하면 "빈 배치도"가 남아 사용자가 다시 저장(PATCH)하면 복구된다.
    //  - 반대 순서면 헤더 없는 유령 좌석이 남아 화면에 보이지도, 정리되지도 않는다.
    // 실패 시 502 로 명시 통지(미러처럼 swallow 금지) — 백업 저장소가 없으므로 조용한 유실 금지.
    try {
      // 레벨2 3차 3.1 — draft 도 항상 배치도 원본을 v2 events.seat_map_data(SoT)로 전송.
      // 소비자 격리는 backend read 필터가 담당(published 만 렌더).
      await pushSeatMapData(
        null,
        params.eventId,
        session.accountId,
        buildMapHeaderDelta({ id: mapId, name: body.name, status: initialStatus, map_data: mapDataObj }),
      );
      await writeThroughLayoutSeats(
        null,
        params.eventId,
        mapId,
        layout,
        `seatmap-seats:${mapId}`,
      );
      // 정원 반영 — v2 좌석 확정 후 산출(판매중지 반영). W2-PS 이후 go write 없음(v2 티어 capacity).
      await syncCapacityFromLayout(null, params.eventId, session.accountId, layout);
    } catch (err: unknown) {
      // 🔴 EventAccessError 를 여기서 잡지 않으면 바깥 catch 의 400 폴백으로 뭉개져
      //    v2 일시 장애가 "입력 오류"로 보인다(wave1 실제 결함 유형).
      if (err instanceof EventAccessError) {
        return errorResponse("이벤트 정보를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
      }
      if (err instanceof V2CommerceError) {
        return errorResponse(
          "좌석 동기화에 실패했습니다. 잠시 후 다시 시도해주세요.",
          502,
        );
      }
      throw err;
    }

    // 구역 레이아웃(geometry) 동기화 — 커머스 SoT 아님, 화면 렌더용 → fire-and-forget 유지.
    if (initialStatus === "published") {
      void pushGridLayoutToV2(params.eventId);
    }

    return successResponse({ id: mapId }, 201);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return errorResponse(error.issues[0]?.message ?? "입력값을 확인해주세요", 400);
    }
    return errorResponse(error instanceof Error ? error.message : "좌석 배치도를 생성하지 못했습니다", 400);
  }
});
