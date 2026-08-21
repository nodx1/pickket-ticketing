/**
 * Phase 1-Map / 레벨2 3차 3.1 — 좌석 배치도 원본 write-through (go → v2), **go-read 없음**.
 *
 * ── 3.1 재설계 (go DROP 관문) ──
 * 이전 구현은 collectSeatMapData 가 go seat_maps/seats/landmarks/versions/groups 를 SELECT 해
 * 전량 재구성했다 → seat 8테이블이 살아있는 한 go DROP 불가. 3.1 에서 **go select 를 완전 제거**하고
 * "기존 v2 events.seat_map_data(SoT) + 요청 delta 병합" 으로 전환한다(go 미read).
 *
 *  - 병합 대상(existing): v2 getEvent().content.seat_map_data — v2 가 정본으로 이미 보유한 배치도 원본.
 *  - delta: 라우트가 방금 확정한 변경(요청 body 에서 그대로 유래 — 맵 헤더/랜드마크/그룹/버전/상태).
 *  - 결과: existing.maps 를 mapId 로 upsert/remove·서브컬렉션 교체 → 병합본을 v2 로 write-back(전량 교체).
 *
 * ── draft 계약 (3.1) ──
 * 이전에는 published 맵만 seat_map_data 에 담았다 → draft(격자 기본생성·미발행 편집본) 가 go DROP 시 소실.
 * 3.1 은 **draft 도 담는다**(archived 만 제외). status 필드로 구분하고, SEAT_MAP_DATA_VERSION 을 2 로 올린다.
 * ⚠️ 소비자 격리: draft 가 payload 에 섞이므로 소비자 read 는 **published 만 렌더**하도록 명시 필터해야 한다
 *    (backend event_pages.py·EventResponse 스키마 검증에서 강제 — 이 파일 밖). draft 공개 누출 0.
 *
 * ── 트랜잭션 경계 & 멱등 ──
 * ★ 반드시 go DB COMMIT **후** 호출한다(외부호출은 커밋 뒤). 로컬 쓰기가 먼저 확정되고 delta 로 전송하므로
 *   "외부호출 후 crash" 해도 v2 는 직전 확정 상태로 남고, 다음 저장이 최신 delta 를 재전송한다(수렴).
 *   ⚠️ 좌석 write-through(upsertSeats, 자연키 멱등)와 달리 seat_map_data 는 v2 가 **전량 교체**(PATCH)라
 *   read-modify-write 이다. bulk 저장(landmarks/groups 전체 교체·맵 헤더 upsert)은 baseline 무관하게
 *   최종 리스트를 통째로 실어 보내므로 crash 재전송이 안전하다.
 * ★ "동시 2회 실행":
 *   - 서로 다른 맵 delta(upsert/remove) → 나중 read 가 앞선 write 를 관측(read-after-write) → 둘 다 반영.
 *   - **같은 맵의 단일 append(appendLandmark/Group/Version)** → 두 요청이 같은 baseline 을 읽으면 나중 write 가
 *     앞선 append 를 덮어 **유실 가능**(v2 가 seat_map_data 를 전량 교체하므로). 빌더는 맵당 단일 편집자
 *     (collab=presence-only) + 저장은 bulk PATCH(전체 교체)가 주경로라 실무상 노출 낮음. 고빈도 동시 append 가
 *     필요해지면 v2 에 seat_map_data 서브패치(맵/컬렉션 단위 CAS) API 신설이 정공법(현 범위 밖).
 * @throws V2CommerceError — v2 read/write 실패 시(호출부가 502 등으로 명시 처리). fire-and-forget 아님.
 */
import type { Pool, PoolClient } from "pg";

import {
  getEvent,
  updateEvent,
  goAccountRef,
  type SeatMapDataPayload,
} from "@/lib/v2/commerce-client";
import { resolveOwnedV2EventId, toV2EventId } from "@/lib/v2/event-access";

/** W2-PS: go 미read. 인자만 남은 핸들 — `null` 허용. */
type Queryable = Pool | PoolClient | null;

/** seat_map_data 계약 버전 — 3.1 에서 draft 수용(archived 제외)으로 shape 확장 → 2. */
export const SEAT_MAP_DATA_VERSION = 2;

/**
 * eventId 가 세션 계정 소유일 때만 v2 canonical event_id 반환(아니면 null).
 *
 * 레벨2 T2-EVT — go `events` 소유 SELECT 제거. **테넌트 경계는 사라지지 않는다**:
 * 옛 `AND account_id = $2` 는 v2 `organizer_ref` 인자로 이관됐고(불일치/미존재 → 404 → null),
 * 경계 강제 주체가 go 로컬 투영에서 v2 SoT 로 바뀌었을 뿐이다.
 * ⚠️ 에러 타입 변화: v2 5xx/네트워크 실패는 V2CommerceError 가 아니라
 *    `EventAccessError(reason="unavailable", status=502)` 로 던져진다(호출부 catch 갱신 필요).
 * @param _db 계약 유지를 위해 남긴 인자(호출부 다수). 더 이상 사용하지 않는다.
 */
export async function resolveV2EventIdFor(
  _db: Queryable,
  eventId: string,
  accountId: string,
): Promise<string | null> {
  return resolveOwnedV2EventId(eventId, accountId);
}

/** payload maps[] 한 원소(계약 shape). */
export type SeatMapEntry = SeatMapDataPayload["maps"][number];

/**
 * 레벨2 컷오버 T1 — 배치도 1개를 v2 seat_map_data(SoT)에서 read. go `seat_maps` 미read.
 *
 * 소유권까지 함께 판정한다: (1) eventId 가 세션 계정 소유(go events.account_id — 앵커의 로컬 투영),
 * (2) mapId 가 v2 payload 에 존재. 둘 중 하나라도 아니면 null(호출부가 404).
 * 미앵커(v2_event_id NULL)도 null — 아직 v2 에 배치도가 없다는 뜻.
 *
 * @throws V2CommerceError — v2 read 실패(호출부가 502 로 통지).
 */
export async function fetchSeatMapEntry(
  db: Queryable,
  eventId: string,
  mapId: string,
  accountId: string,
): Promise<{ v2EventId: string; entry: SeatMapEntry } | null> {
  const v2EventId = await resolveV2EventIdFor(db, eventId, accountId);
  if (!v2EventId) return null;
  const detail = await getEvent(v2EventId);
  const entry = (detail.content?.seat_map_data?.maps ?? []).find((m) => m.id === mapId);
  return entry ? { v2EventId, entry } : null;
}

/**
 * 레벨2 컷오버 T1 — **소비자 공개 경로**용 배치도 목록. go `seat_maps` 미read.
 *
 * 공개 경로에는 계정 소유 게이트가 없으므로 **published 만** 노출한다.
 * (3.1 계약: seat_map_data 에는 draft 도 담긴다 → 필터를 빼면 미발행 배치도가 소비자에게 샌다.)
 * 미앵커(v2_event_id NULL)·배치도 없음이면 빈 배열.
 *
 * @throws V2CommerceError — v2 read 실패(호출부가 502 로 통지). swallow 금지.
 */
export async function fetchPublishedMaps(v2EventId: string): Promise<SeatMapEntry[]> {
  const detail = await getEvent(v2EventId);
  return (detail.content?.seat_map_data?.maps ?? []).filter(
    (m) => m.status === "published" && typeof m.id === "string",
  );
}

/** `fetchPublishedMaps` 의 id 만 필요한 호출부용 축약. */
export async function fetchPublishedMapIds(v2EventId: string): Promise<string[]> {
  return (await fetchPublishedMaps(v2EventId)).map((m) => m.id);
}

/**
 * 배치도 원본 delta — 라우트가 방금 확정한 변경. go select 없이 요청 body 에서 그대로 유래.
 *
 *  - upsertMap: 맵 헤더(create/replace). 존재하면 헤더 필드 갱신, 없으면 신규 추가.
 *      landmarks/groups/versions 는 미지정 시 기존 값 보존(신규 맵이면 빈 배열).
 *  - removeMapId: 맵 삭제(archived/DELETE). existing 에서 제거.
 *  - landmarks/groups/versions: 특정 맵의 서브컬렉션 **전체 교체**(빌더가 최종 리스트를 통째로 보냄).
 */
export interface SeatMapDelta {
  /**
   * 맵 헤더 upsert(create/replace). 서브컬렉션은 명시된 것만 교체, 나머지는 existing 보존.
   * name/status 미지정(undefined) 시 기존 맵이면 보존, 신규면 name="" · status="draft".
   */
  upsertMap?: {
    id: string;
    name?: string;
    status?: string;
    floor_index?: number;
    floor_label?: string | null;
    parent_map_id?: string | null;
    map_data?: unknown;
    background?: SeatMapEntry["background"];
    landmarks?: SeatMapEntry["landmarks"];
    groups?: NonNullable<SeatMapEntry["groups"]>;
    versions?: NonNullable<SeatMapEntry["versions"]>;
  };
  /**
   * 특정 맵의 서브컬렉션 변경(맵 헤더는 upsertMap 없이 유지).
   *  - landmarks/groups/versions: 전체 교체(빌더 bulk 저장 — 최종 리스트 통째).
   *  - appendLandmark/appendGroup/appendVersion: 단일 추가(기존 v2 리스트에 push).
   *  - removeLandmarkId/removeGroupId: 안정 id 로 단일 제거.
   * 맵이 existing v2 에 없으면 no-op(upsertMap 선행 필요).
   */
  patchMap?: {
    id: string;
    status?: string;
    landmarks?: SeatMapEntry["landmarks"];
    groups?: NonNullable<SeatMapEntry["groups"]>;
    versions?: NonNullable<SeatMapEntry["versions"]>;
    appendLandmark?: SeatMapEntry["landmarks"][number];
    removeLandmarkId?: string;
    appendGroup?: NonNullable<SeatMapEntry["groups"]>[number];
    removeGroupId?: string;
    appendVersion?: NonNullable<SeatMapEntry["versions"]>[number];
  };
  /** 삭제할 맵 id(DELETE·archived). */
  removeMapId?: string;
}

/** NUMERIC 컬럼은 pg 가 문자열로 반환할 수 있음 → 숫자로 정규화. */
function num(value: string | number | null | undefined, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 랜드마크 행(빌더 요청·go INSERT 파라미터 유래) → 계약 shape. go select 없이 in-memory 변환. */
export function toLandmarkEntries(
  rows: Array<{
    type: string;
    label?: string | null;
    x: string | number;
    y: string | number;
    width?: string | number | null;
    height?: string | number | null;
    rotation?: string | number | null;
    color_hex?: string | null;
    colorHex?: string | null;
    metadata?: unknown;
  }>,
): SeatMapEntry["landmarks"] {
  return rows.map((lm) => ({
    type: lm.type,
    label: lm.label ?? null,
    x: num(lm.x),
    y: num(lm.y),
    width: num(lm.width, 80),
    height: num(lm.height, 40),
    rotation: num(lm.rotation),
    color_hex: lm.color_hex ?? lm.colorHex ?? null,
    metadata: lm.metadata ?? {},
  }));
}

/** 그룹 행 → 계약 shape(seat_refs = go seat id). */
export function toGroupEntries(
  rows: Array<{
    name: string;
    type: string;
    color_hex?: string | null;
    colorHex?: string | null;
    icon?: string | null;
    seat_refs?: string[] | null;
    seatIds?: string[] | null;
  }>,
): NonNullable<SeatMapEntry["groups"]> {
  return rows.map((g) => ({
    name: g.name,
    type: g.type,
    color_hex: g.color_hex ?? g.colorHex ?? null,
    icon: g.icon ?? null,
    seat_refs: g.seat_refs ?? g.seatIds ?? [],
  }));
}

/** 버전 행 → 계약 shape. created_at Date→ISO. */
export function toVersionEntries(
  rows: Array<{
    version: number;
    note?: string | null;
    snapshot?: unknown;
    created_at?: Date | string | null;
    createdAt?: Date | string | null;
  }>,
): NonNullable<SeatMapEntry["versions"]> {
  return rows.map((v) => {
    const ca = v.created_at ?? v.createdAt ?? null;
    return {
      version: v.version,
      note: v.note ?? null,
      snapshot: v.snapshot ?? null,
      created_at: ca instanceof Date ? ca.toISOString() : ca,
    };
  });
}

function normalizeEntry(e: SeatMapEntry): SeatMapEntry {
  return {
    ...e,
    floor_index: e.floor_index ?? 0,
    floor_label: e.floor_label ?? null,
    parent_map_id: e.parent_map_id ?? null,
    map_data: e.map_data ?? null,
    background: e.background ?? null,
    landmarks: e.landmarks ?? [],
    versions: e.versions ?? [],
    groups: e.groups ?? [],
  };
}

/**
 * 순수 함수 — 기존 payload(existing) 에 delta 를 적용해 병합 payload 를 만든다(go 미read).
 * existing 이 null 이면 빈 maps 에서 시작. 결과 maps 가 비면 null 반환(배치도 없음 = v2 NULL 수렴).
 * floor_index 오름차순 정렬(소비자 층 정렬 계약과 정합).
 */
export function applySeatMapDelta(
  existing: SeatMapDataPayload | null,
  delta: SeatMapDelta,
): SeatMapDataPayload | null {
  const byId = new Map<string, SeatMapEntry>();
  for (const m of existing?.maps ?? []) {
    if (m && typeof m.id === "string") byId.set(m.id, normalizeEntry(m));
  }

  if (delta.removeMapId) {
    byId.delete(delta.removeMapId);
  }

  if (delta.upsertMap) {
    const d = delta.upsertMap;
    const prev = byId.get(d.id);
    const merged: SeatMapEntry = normalizeEntry({
      id: d.id,
      name: d.name !== undefined ? d.name : (prev?.name ?? ""),
      status: d.status !== undefined ? d.status : (prev?.status ?? "draft"),
      floor_index: d.floor_index ?? prev?.floor_index ?? 0,
      floor_label: d.floor_label !== undefined ? d.floor_label : (prev?.floor_label ?? null),
      parent_map_id:
        d.parent_map_id !== undefined ? d.parent_map_id : (prev?.parent_map_id ?? null),
      map_data: d.map_data !== undefined ? d.map_data : (prev?.map_data ?? null),
      background: d.background !== undefined ? d.background : (prev?.background ?? null),
      landmarks: d.landmarks !== undefined ? d.landmarks : (prev?.landmarks ?? []),
      groups: d.groups !== undefined ? d.groups : (prev?.groups ?? []),
      versions: d.versions !== undefined ? d.versions : (prev?.versions ?? []),
    });
    byId.set(d.id, merged);
  }

  if (delta.patchMap) {
    const d = delta.patchMap;
    const prev = byId.get(d.id);
    if (prev) {
      // 전체 교체(bulk) 우선, 없으면 단일 append/remove 를 기존 리스트에 적용.
      let landmarks = d.landmarks !== undefined ? d.landmarks : prev.landmarks;
      if (d.removeLandmarkId !== undefined) {
        landmarks = landmarks.filter((lm) => lm.id !== d.removeLandmarkId);
      }
      if (d.appendLandmark !== undefined) {
        landmarks = [...landmarks, d.appendLandmark];
      }

      let groups = d.groups !== undefined ? d.groups : (prev.groups ?? []);
      if (d.removeGroupId !== undefined) {
        groups = groups.filter((g) => g.id !== d.removeGroupId);
      }
      if (d.appendGroup !== undefined) {
        groups = [...groups, d.appendGroup];
      }

      let versions = d.versions !== undefined ? d.versions : (prev.versions ?? []);
      if (d.appendVersion !== undefined) {
        versions = [d.appendVersion, ...versions].slice(0, 30); // 최근 30개(collector 계약).
      }

      byId.set(
        d.id,
        normalizeEntry({
          ...prev,
          status: d.status !== undefined ? d.status : prev.status,
          landmarks,
          groups,
          versions,
        }),
      );
    }
    // prev 없음 = 맵이 existing 에 없음(미앵커였거나 신규) → patch 는 no-op(upsertMap 이 선행돼야 함).
  }

  const maps = [...byId.values()].sort((a, b) => a.floor_index - b.floor_index);
  if (maps.length === 0) return null;
  return { version: SEAT_MAP_DATA_VERSION, maps };
}

/**
 * 좌석 배치도 원본 write-through(delta 병합). go select 없음.
 *
 * v2 getEvent 로 현재 seat_map_data(SoT)를 읽어 delta 를 병합한 뒤 events.seat_map_data 로 write-back.
 * ★ 레벨2 T2-EVT: "앵커 미준비 → 조용한 스킵"은 사라졌다(id 승격). v2 에 이벤트가 없으면 404 로 실패한다.
 * ★ 멱등키: mapId(있으면) + timestamp — 재시도 안전.
 *
 * @throws V2CommerceError — v2 read/write 실패 시(호출부가 502 로 명시 처리).
 */
export async function pushSeatMapData(
  _db: Queryable,
  eventId: string,
  accountId: string,
  delta: SeatMapDelta,
): Promise<{ pushed: boolean }> {
  // 레벨2 T2-EVT — go `events` 앵커 조회 제거(id 승격으로 go id == v2 id, 항등 변환).
  // ⚠️ 미스 시맨틱 변화: 옛 코드는 앵커 미준비 시 `{pushed:false}` 로 조용히 스킵했다. 이 레이어에는
  //    더 이상 그 케이스가 없다 — 이벤트가 v2 에 없으면 아래 getEvent 가 404(V2CommerceError)를 던지고
  //    호출부가 502 로 통지한다(조용한 폴백을 새로 만들지 않는다).
  //    반환 타입의 `pushed:false` 는 호출부 계약 유지를 위해 남겨두지만 실질 도달 불가다.
  const v2EventId = toV2EventId(eventId);

  // 기존 v2 seat_map_data(SoT) read — go 미read. draft 도 포함(3.1 계약).
  const existing = await getEvent(v2EventId);
  const current = existing.content?.seat_map_data ?? null;
  const merged = applySeatMapDelta(current, delta);

  const mapRef = delta.upsertMap?.id ?? delta.patchMap?.id ?? delta.removeMapId ?? "event";
  await updateEvent(
    v2EventId,
    { organizer_ref: goAccountRef(accountId), seat_map_data: merged },
    { idempotencyKey: `event-seatmap:${eventId}:${mapRef}:${Date.now()}` },
  );
  return { pushed: true };
}
