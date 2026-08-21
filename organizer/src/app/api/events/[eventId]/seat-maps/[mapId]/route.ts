import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { V2CommerceError } from "@/lib/v2/commerce-client";
import { EventAccessError, requireOwnedEvent } from "@/lib/v2/event-access";
import { pushGridLayoutToV2 } from "@/lib/v2/grid-layout-sync";
import {
  fetchSeatMapEntry,
  pushSeatMapData,
  type SeatMapDelta,
} from "@/lib/v2/seat-map-payload";
import { buildMapHeaderDelta } from "@/lib/seats/seat-map-delta";
import { syncCapacityFromLayout } from "@/lib/seats/capacity";
import {
  generateSeatsFromCanvas,
  type SeatMapCanvas,
} from "@/lib/seats/seat-generator";
import { writeThroughLayoutSeats } from "@/lib/seats/seat-writethrough";
import { fetchV2SeatLiveMap } from "@/lib/seats/v2-status";

type Params = { eventId: string; mapId: string };

const figmaSectionSchema = z.object({
  name: z.string().min(1),
  x: z.number(),
  y: z.number(),
  rotation: z.number().default(0),
  tierId: z.string().uuid().nullable().optional(),
  kind: z.enum(["assigned", "standing", "stage", "console"]).default("assigned"),
  rows: z.number().int().min(1).max(30).optional(),
  seatsPerRow: z.number().int().min(1).max(50).optional(),
  blockedPositions: z.array(z.string()).optional(),
  capacity: z.number().int().min(1).max(10000).optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
});

const schema = z.object({
  name: z.string().min(2).optional(),
  status: z.enum(["draft", "published", "archived"]).optional(),
  sections: z.array(z.string().min(1)).optional(),
  rowsPerSection: z.number().int().min(1).max(26).optional(),
  seatsPerRow: z.number().int().min(1).max(100).optional(),
  // 피그마 모드 레이아웃 전체 교체
  figmaLayout: z
    .object({
      sections: z.array(figmaSectionSchema).min(1),
    })
    .optional(),
  // 트랙 2.1 — 도면 이미지 배경
  backgroundUrl: z.string().url().nullable().optional(),
  backgroundOpacity: z.number().min(0).max(1).optional(),
  backgroundWidth: z.number().int().min(0).optional(),
  backgroundHeight: z.number().int().min(0).optional(),
});

export const GET = withRole<Params>("staff", async (_request, { session, params }) => {
  // ── W2-PS — 마지막 go read(`SELECT 1 FROM events` 소유 확인) 제거 ──
  // 소유 검증 + 맵 헤더 read 를 `requireOwnedEvent` 한 번으로 합친다(v2 organizer_ref 가 경계 강제).
  // 🔴 v2 장애를 404 로 뭉개지 않는다 — "배치도가 사라졌다"로 보이면 주최자가 재작성을 시도한다.
  let detail;
  let byGoSeatId: Awaited<ReturnType<typeof fetchV2SeatLiveMap>>["byGoSeatId"];
  try {
    [detail, { byGoSeatId }] = await Promise.all([
      requireOwnedEvent(params.eventId, session.accountId),
      fetchV2SeatLiveMap(params.eventId),
    ]);
  } catch (err: unknown) {
    if (err instanceof EventAccessError) {
      return err.reason === "not_found"
        ? errorResponse("좌석 배치도를 찾을 수 없습니다", 404)
        : errorResponse("좌석 배치도를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    if (err instanceof V2CommerceError) {
      return errorResponse("좌석 배치도를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    throw err;
  }

  const entry = (detail.content?.seat_map_data?.maps ?? []).find(
    (m) => m.id === params.mapId,
  );
  if (!entry) {
    return errorResponse("좌석 배치도를 찾을 수 없습니다", 404);
  }

  // v2 좌석 live 행(external_ref = 결정적 좌석키) → 빌더 좌석 목록.
  // 단일 맵/이벤트 1:1 이 현 계약(빌더는 이벤트당 활성 맵 1개) → 이벤트 좌석 = 이 맵 좌석으로 투영.
  // 좌석 정본 id = v2 canonical seat_id(레벨2 T1). external_ref 는 멱등키로 함께 노출.
  const seats = [...byGoSeatId.values()].map((live) => ({
    id: live.seatId,
    externalRef: live.externalRef,
    section: live.section ?? "",
    row: live.row ?? "",
    seatNumber: live.seatNumber ?? "",
    status: live.status,
    productId: null,
    tierId: live.tierId,
    x: live.x,
    y: live.y,
    label: live.label,
    isObstructed: live.isObstructed,
    qualityScore: live.qualityScore,
  }));

  return successResponse({
    id: entry.id,
    name: entry.name,
    status: entry.status,
    mapData: entry.map_data ?? null,
    backgroundUrl: entry.background?.url ?? null,
    backgroundOpacity: entry.background?.opacity ?? null,
    backgroundWidth: entry.background?.width ?? null,
    backgroundHeight: entry.background?.height ?? null,
    createdAt: null,
    updatedAt: null,
    seats,
  });
});

export const PATCH = withRole<Params>("organizer", async (request, { session, params }) => {
  try {
    const body = schema.parse(await request.json());

    // ── 레벨2 컷오버 T1 — 현재 맵을 go seat_maps 가 아닌 v2 seat_map_data(SoT)에서 read ──
    // 소유권 판정도 여기서 함께 끝난다(eventId 계정 소유 + mapId 가 v2 payload 에 존재).
    let current: Awaited<ReturnType<typeof fetchSeatMapEntry>>;
    try {
      current = await fetchSeatMapEntry(null, params.eventId, params.mapId, session.accountId);
    } catch (err: unknown) {
      // 🔴 레벨2 T2-EVT — v2 응답불가는 EventAccessError 로 온다. 여기서 rethrow 하면 바깥 catch 의
      //    400 폴백("좌석 배치도를 수정하지 못했습니다")으로 뭉개져 일시 장애가 입력 오류로 보인다.
      if (err instanceof EventAccessError) {
        return errorResponse("이벤트 정보를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
      }
      if (err instanceof V2CommerceError) {
        return errorResponse("좌석 배치도를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.", 502);
      }
      throw err;
    }
    if (!current) {
      return errorResponse("좌석 배치도를 찾을 수 없습니다", 404);
    }

    // ── figmaLayout 전체 교체 ──
    // 이전엔 `DELETE FROM seats` 후 재INSERT 로 축소를 표현했다. go 좌석이 사라진 지금은
    // upsertSeats(replace, scope=이 맵) 가 없어진 좌석을 v2 에서 정리한다(SOLD/HELD 는 v2 가 보호).
    if (body.figmaLayout) {
      const nextCanvas: SeatMapCanvas = { mode: "figma", figmaLayout: body.figmaLayout };
      const layout = generateSeatsFromCanvas(params.mapId, nextCanvas);
      const nextStatus = body.status ?? "published";

      try {
        await pushSeatMapData(
          null,
          params.eventId,
          session.accountId,
          buildMapHeaderDelta({
            id: params.mapId,
            name: body.name,
            status: nextStatus,
            map_data: nextCanvas,
          }),
        );
        await writeThroughLayoutSeats(
          null,
          params.eventId,
          params.mapId,
          layout,
          `seatmap-seats:${params.mapId}:${Date.now()}`,
        );
        // 정원 비정규화 — 좌석 확정 후 산출(판매중지 반영). 산출은 트랜잭션 밖, 반영만 짧은 트랜잭션.
        await syncCapacityFromLayout(null, params.eventId, session.accountId, layout);
      } catch (err: unknown) {
        // 🔴 EventAccessError 를 놓치면 바깥 catch 의 400 폴백으로 뭉개진다(장애→입력오류 위장).
        if (err instanceof EventAccessError) {
          return errorResponse("이벤트 정보를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
        }
        if (err instanceof V2CommerceError) {
          return errorResponse("좌석 동기화에 실패했습니다. 잠시 후 다시 시도해주세요.", 502);
        }
        throw err;
      }

      // 구역 레이아웃(geometry) — 커머스 SoT 아님, 화면 렌더용 → fire-and-forget 유지.
      void pushGridLayoutToV2(params.eventId);
      return successResponse({ updated: true });
    }

    // ── 헤더/배경/격자 파라미터 부분 수정 ──
    // 기존 캔버스는 v2 SoT 에서 읽은 값(current.entry.map_data)을 병합 기준으로 쓴다.
    const currentCanvas = (current.entry.map_data ?? {}) as SeatMapCanvas;
    const nextMap: SeatMapCanvas = {
      ...currentCanvas,
      ...(body.sections ? { sections: body.sections } : {}),
      ...(body.rowsPerSection ? { rowsPerSection: body.rowsPerSection } : {}),
      ...(body.seatsPerRow ? { seatsPerRow: body.seatsPerRow } : {}),
    };

    // ── 맵 헤더/배경/상태 변경을 v2 seat_map_data(SoT)로 delta 전송(draft 포함) ──
    // archived 전환 = 맵 제거 delta(소비자·목록에서 제외). published/draft = 헤더 upsert delta.
    // status 미변경(name/배경/격자 편집만)도 헤더 upsert 로 v2 동기 유지.
    const nextStatus = body.status; // undefined 면 status 미변경(applySeatMapDelta 가 기존 status 보존).
    const archived = nextStatus === "archived";
    let delta: SeatMapDelta;
    if (archived) {
      delta = { removeMapId: params.mapId };
    } else {
      delta = buildMapHeaderDelta({
        id: params.mapId,
        name: body.name,
        status: nextStatus,
        map_data: nextMap,
        background:
          body.backgroundUrl !== undefined
            ? {
                url: body.backgroundUrl,
                opacity: body.backgroundOpacity ?? 0.5,
                width: body.backgroundWidth ?? null,
                height: body.backgroundHeight ?? null,
              }
            : undefined,
      });
    }

    // 격자 파라미터가 바뀌면 좌석 구성도 바뀐다 → 레이아웃 재파생.
    // 보관(archived)은 좌석 전부 정리(빈 레이아웃), 그 외에는 다음 캔버스 기준.
    const layout = generateSeatsFromCanvas(params.mapId, archived ? null : nextMap);
    const gridChanged =
      body.sections !== undefined ||
      body.rowsPerSection !== undefined ||
      body.seatsPerRow !== undefined;

    try {
      await pushSeatMapData(null, params.eventId, session.accountId, delta);
      // 좌석 재전송이 필요한 경우만: published 전환(판매대상 확정)·격자 변경·보관(정리).
      if (nextStatus === "published" || gridChanged || archived) {
        await writeThroughLayoutSeats(
          null,
          params.eventId,
          params.mapId,
          layout,
          `seatmap-seats:${params.mapId}:${Date.now()}`,
        );
        // 정원 재산출은 좌석 구성이 실제로 바뀐 경우만(보관 전환은 기존 동작대로 정원 유지 —
        // 다른 배치도가 남아 있을 때 정원을 0으로 지우지 않기 위함).
        if (!archived) {
          await syncCapacityFromLayout(null, params.eventId, session.accountId, layout);
        }
      }
    } catch (err: unknown) {
      if (err instanceof EventAccessError) {
        return errorResponse("이벤트 정보를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
      }
      if (err instanceof V2CommerceError) {
        return errorResponse("좌석 동기화에 실패했습니다. 잠시 후 다시 시도해주세요.", 502);
      }
      throw err;
    }
    if (nextStatus === "published") {
      void pushGridLayoutToV2(params.eventId);
    }

    return successResponse({ updated: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return errorResponse(error.issues[0]?.message ?? "입력값을 확인해주세요", 400);
    }
    return errorResponse("좌석 배치도를 수정하지 못했습니다", 400);
  }
});

export const DELETE = withRole<Params>("organizer", async (_request, { session, params }) => {
  // ── 레벨2 컷오버 T1 — go seat_maps DELETE 폐기. v2 가 유일 저장소. ──
  // 소유권 확인도 v2 payload 기준(맵이 그 계정 이벤트에 존재하는지).
  let current: Awaited<ReturnType<typeof fetchSeatMapEntry>>;
  try {
    current = await fetchSeatMapEntry(null, params.eventId, params.mapId, session.accountId);
  } catch (err: unknown) {
    // 🔴 레벨2 T2-EVT — v2 응답불가는 EventAccessError 로 온다(안 잡으면 정체불명 500).
    //    ⚠️ 아래 `!current` 는 "이미 없음"을 삭제 성공으로 흡수하는데, 확인 불가를 그리로 흘리면
    //    **지우지 않은 배치도를 지웠다고 답하게 된다** — 반드시 여기서 503 으로 끊는다.
    if (err instanceof EventAccessError) {
      return errorResponse("이벤트 정보를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    if (err instanceof V2CommerceError) {
      return errorResponse("좌석 배치도를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.", 502);
    }
    throw err;
  }
  if (!current) {
    // 이미 없음 — 삭제는 멱등이므로 성공으로 흡수(재시도·중복클릭 안전).
    return successResponse({ deleted: true });
  }

  try {
    // 좌석 먼저 정리(빈 레이아웃 + replace scope=이 맵) → 그 다음 맵 헤더 제거.
    // 순서가 반대면 헤더가 사라진 뒤 좌석만 남아 정리 주체가 없어진다(유령 재고).
    // ⚠️ SOLD/HELD 좌석은 v2 가 삭제를 거부하고 보존한다 — 판매분이 있는 배치도를 지워도
    //    결제·티켓 정합은 깨지지 않는다(잔존 좌석은 환불/취소 경로가 정리).
    await writeThroughLayoutSeats(
      null,
      params.eventId,
      params.mapId,
      { seats: [], standingByTier: new Map(), standingTotal: 0 },
      `seatmap-delete:${params.mapId}:${Date.now()}`,
    );
    await pushSeatMapData(null, params.eventId, session.accountId, {
      removeMapId: params.mapId,
    });
    // 정원(events.max_attendees / seat_tiers.capacity)은 기존 동작대로 건드리지 않는다 —
    // 다른 배치도가 남아 있을 수 있어 여기서 0으로 지우면 과소 산정이 된다.
  } catch (err: unknown) {
    if (err instanceof EventAccessError) {
      return errorResponse("이벤트 정보를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    if (err instanceof V2CommerceError) {
      return errorResponse("좌석 배치도 동기화에 실패했습니다. 잠시 후 다시 시도해주세요.", 502);
    }
    throw err;
  }

  return successResponse({ deleted: true });
});
