/**
 * 레벨2 3차 3.1 — 배치도 원본 delta 빌더(라우트용, go-read 없음).
 *
 * seat-maps POST/PATCH 라우트는 방금 확정한 맵 헤더(id/name/status/map_data/background/floor)를
 * in-memory 로 알고 있으므로, 그 값으로 upsertMap delta 를 만들어 pushSeatMapData 에 넘긴다.
 * 서브컬렉션(landmarks/groups/versions)은 여기서 미지정 → applySeatMapDelta 가 existing v2 값 보존.
 */
import type { SeatMapDelta, SeatMapEntry } from "@/lib/v2/seat-map-payload";

export interface MapHeaderInput {
  id: string;
  /** 미지정(undefined) 시 v2 기존 이름 보존(applySeatMapDelta). */
  name?: string;
  /** 미지정(undefined) 시 v2 기존 상태 보존(신규면 draft). */
  status?: string;
  map_data?: unknown;
  floor_index?: number | null;
  floor_label?: string | null;
  parent_map_id?: string | null;
  background?: SeatMapEntry["background"];
}

/** 맵 헤더 upsert delta. background NULL 컬럼은 background=null 로 전달. */
export function buildMapHeaderDelta(input: MapHeaderInput): SeatMapDelta {
  return {
    upsertMap: {
      id: input.id,
      name: input.name,
      status: input.status,
      floor_index: input.floor_index ?? 0,
      floor_label: input.floor_label ?? null,
      parent_map_id: input.parent_map_id ?? null,
      map_data: input.map_data ?? null,
      background: input.background ?? null,
    },
  };
}
