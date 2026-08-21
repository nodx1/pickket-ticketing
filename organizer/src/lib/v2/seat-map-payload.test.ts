import { describe, it, expect } from "vitest";

import type { SeatMapDataPayload } from "@/lib/v2/commerce-client";
import { applySeatMapDelta, SEAT_MAP_DATA_VERSION } from "./seat-map-payload";

function baseMap(overrides: Partial<SeatMapDataPayload["maps"][number]> = {}) {
  return {
    id: "m1",
    name: "1층",
    status: "published",
    floor_index: 0,
    floor_label: null,
    parent_map_id: null,
    map_data: { mode: "figma" },
    background: null,
    landmarks: [],
    versions: [],
    groups: [],
    ...overrides,
  };
}

describe("applySeatMapDelta", () => {
  it("버전 2 계약 — draft 도 담는다(archived 만 소비자 격리에서 제외)", () => {
    const out = applySeatMapDelta(null, {
      upsertMap: { id: "m1", name: "격자", status: "draft", map_data: { mode: "grid" } },
    });
    expect(out).not.toBeNull();
    expect(out!.version).toBe(SEAT_MAP_DATA_VERSION);
    expect(out!.version).toBe(2);
    expect(out!.maps).toHaveLength(1);
    expect(out!.maps[0].status).toBe("draft");
  });

  it("upsertMap — 신규 맵 추가, 기존 맵 헤더 갱신(서브컬렉션 보존)", () => {
    const existing: SeatMapDataPayload = {
      version: 2,
      maps: [baseMap({ landmarks: [{ type: "stage", label: null, x: 1, y: 2, width: 3, height: 4, rotation: 0, color_hex: null, metadata: {} }] })],
    };
    // 헤더만 갱신(name/map_data) → 기존 landmarks 보존.
    const out = applySeatMapDelta(existing, {
      upsertMap: { id: "m1", name: "새이름", status: "published", map_data: { v: 2 } },
    });
    expect(out!.maps[0].name).toBe("새이름");
    expect(out!.maps[0].map_data).toEqual({ v: 2 });
    expect(out!.maps[0].landmarks).toHaveLength(1); // 보존
  });

  it("upsertMap — name/status 미지정 시 기존 값 보존(격자 편집이 발행상태 안 바꿈)", () => {
    const existing: SeatMapDataPayload = { version: 2, maps: [baseMap({ name: "원본", status: "published" })] };
    const out = applySeatMapDelta(existing, {
      upsertMap: { id: "m1", map_data: { edited: true } },
    });
    expect(out!.maps[0].name).toBe("원본");
    expect(out!.maps[0].status).toBe("published");
    expect(out!.maps[0].map_data).toEqual({ edited: true });
  });

  it("removeMapId — 맵 제거(삭제·archived). 마지막 맵 제거 시 null", () => {
    const existing: SeatMapDataPayload = { version: 2, maps: [baseMap()] };
    expect(applySeatMapDelta(existing, { removeMapId: "m1" })).toBeNull();
  });

  it("patchMap.landmarks — 전체 교체(빌더 bulk 저장)", () => {
    const existing: SeatMapDataPayload = { version: 2, maps: [baseMap()] };
    const out = applySeatMapDelta(existing, {
      patchMap: {
        id: "m1",
        landmarks: [
          { id: "l1", type: "exit", label: "출구", x: 5, y: 5, width: 40, height: 40, rotation: 0, color_hex: null, metadata: {} },
        ],
      },
    });
    expect(out!.maps[0].landmarks).toHaveLength(1);
    expect(out!.maps[0].landmarks[0].type).toBe("exit");
  });

  it("patchMap.appendLandmark / removeLandmarkId — 단일 add/remove(id 매칭)", () => {
    const existing: SeatMapDataPayload = {
      version: 2,
      maps: [baseMap({ landmarks: [{ id: "l1", type: "stage", label: null, x: 0, y: 0, width: 1, height: 1, rotation: 0, color_hex: null, metadata: {} }] })],
    };
    const added = applySeatMapDelta(existing, {
      patchMap: { id: "m1", appendLandmark: { id: "l2", type: "exit", label: null, x: 9, y: 9, width: 1, height: 1, rotation: 0, color_hex: null, metadata: {} } },
    });
    expect(added!.maps[0].landmarks.map((l) => l.id)).toEqual(["l1", "l2"]);

    const removed = applySeatMapDelta(added, { patchMap: { id: "m1", removeLandmarkId: "l1" } });
    expect(removed!.maps[0].landmarks.map((l) => l.id)).toEqual(["l2"]);
  });

  it("patchMap.appendGroup / removeGroupId — id 매칭 제거", () => {
    const existing: SeatMapDataPayload = { version: 2, maps: [baseMap()] };
    const added = applySeatMapDelta(existing, {
      patchMap: { id: "m1", appendGroup: { id: "g1", name: "VIP", type: "vip_box", color_hex: "#fff", icon: null, seat_refs: ["s1"] } },
    });
    expect(added!.maps[0].groups).toHaveLength(1);
    const removed = applySeatMapDelta(added, { patchMap: { id: "m1", removeGroupId: "g1" } });
    expect(removed!.maps[0].groups).toHaveLength(0);
  });

  it("patchMap.appendVersion — 최근 30개로 트림(desc)", () => {
    let payload: SeatMapDataPayload | null = { version: 2, maps: [baseMap()] };
    for (let v = 1; v <= 35; v += 1) {
      payload = applySeatMapDelta(payload, {
        patchMap: { id: "m1", appendVersion: { version: v, note: null, snapshot: {}, created_at: null } },
      });
    }
    const versions = payload!.maps[0].versions!;
    expect(versions).toHaveLength(30);
    expect(versions[0].version).toBe(35); // 최신이 앞
    expect(versions[29].version).toBe(6); // 30개 유지, 1~5 는 트림
  });

  it("patchMap — 존재하지 않는 맵은 no-op(upsertMap 선행 필요)", () => {
    const existing: SeatMapDataPayload = { version: 2, maps: [baseMap()] };
    const out = applySeatMapDelta(existing, {
      patchMap: { id: "unknown", landmarks: [] },
    });
    expect(out!.maps).toHaveLength(1);
    expect(out!.maps[0].id).toBe("m1");
  });

  it("floor_index 오름차순 정렬(다층 소비자 정렬 계약)", () => {
    const existing: SeatMapDataPayload = { version: 2, maps: [baseMap({ id: "m1", floor_index: 1 })] };
    const out = applySeatMapDelta(existing, {
      upsertMap: { id: "m2", name: "지하", status: "published", floor_index: 0 },
    });
    expect(out!.maps.map((m) => m.id)).toEqual(["m2", "m1"]);
  });
});
