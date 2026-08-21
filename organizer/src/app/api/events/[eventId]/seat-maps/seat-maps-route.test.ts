/**
 * W2-PS 회귀 — 좌석 배치도 목록/생성 + 개별 맵 GET 의 **go `events` 소유 SELECT 제거** 이후 계약.
 *
 * 여기서 고정하는 것:
 *   - 소유 검증이 v2 `organizer_ref` 로 이관됐고 **반드시 전달**된다(크로스테넌트 차단).
 *   - v2 장애 → **503**. 종전 목록은 앵커 미준비를 `listResponse([], 0)` 로 흡수했는데,
 *     v2 가 유일 저장소가 된 지금 빈 목록은 "배치도를 다 지웠다"로 읽힌다.
 *   - 쓰기 경로(POST)는 소유 확인 불가 상태에서 **아무것도 쓰지 않는다**.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  getEvent: vi.fn(),
  updateEvent: vi.fn(),
  upsertSeats: vi.fn(),
  listTierCatalog: vi.fn(),
  upsertTierCatalog: vi.fn(),
  listSeats: vi.fn(),
}));

vi.mock("@/lib/v2/commerce-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/v2/commerce-client")>();
  return {
    ...actual,
    getEvent: h.getEvent,
    updateEvent: h.updateEvent,
    upsertSeats: h.upsertSeats,
    listSeats: h.listSeats,
    listTierCatalog: h.listTierCatalog,
    upsertTierCatalog: h.upsertTierCatalog,
  };
});
vi.mock("@/lib/v2/grid-layout-sync", () => ({ pushGridLayoutToV2: vi.fn() }));
vi.mock("@/lib/auth/permissions", () => ({
  withRole:
    (
      _role: string,
      handler: (request: Request, ctx: { session: unknown; params: unknown }) => Promise<Response>,
    ) =>
    (request: Request, context: { params: Promise<unknown> }) =>
      context.params.then((params) =>
        handler(request, {
          session: { id: "user-1", accountId: "acc-1", role: "organizer" },
          params,
        }),
      ),
}));

import { V2CommerceError } from "@/lib/v2/commerce-client";
import { GET as mapList, POST as mapCreate } from "./route";
import { GET as mapDetail } from "./[mapId]/route";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const MAP_ID = "22222222-2222-4222-8222-222222222222";

const listCtx = { params: Promise.resolve({ eventId: EVENT_ID }) };
const oneCtx = { params: Promise.resolve({ eventId: EVENT_ID, mapId: MAP_ID }) };

const getReq = () => new Request("http://localhost/seat-maps") as unknown as NextRequest;
const postReq = () =>
  new Request("http://localhost/seat-maps", {
    method: "POST",
    body: JSON.stringify({ name: "메인 배치도", sections: ["A"], rowsPerSection: 2, seatsPerRow: 3 }),
  }) as unknown as NextRequest;

function eventWithMaps() {
  return {
    event_id: EVENT_ID,
    title: "행사",
    content: {
      seat_map_data: {
        maps: [{ id: MAP_ID, name: "메인", status: "published", map_data: { mode: "grid" } }],
      },
    },
  };
}

beforeEach(() => {
  h.getEvent.mockResolvedValue(eventWithMaps());
  h.updateEvent.mockResolvedValue({});
  h.upsertSeats.mockResolvedValue({ count: 0, seats: [] });
  h.listSeats.mockResolvedValue({ seats: [], status_counts: {}, total_seats: 0, page_count: 0 });
  h.listTierCatalog.mockResolvedValue({ tiers: [], total: 0 });
  h.upsertTierCatalog.mockResolvedValue({ tiers: [] });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("seat-maps GET (목록)", () => {
  it("정상 — v2 seat_map_data 를 투영하고 organizer_ref 로 경계 강제", async () => {
    const res = await mapList(getReq(), listCtx);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveLength(1);
    expect(h.getEvent).toHaveBeenCalledWith(EVENT_ID, { organizerRef: "acc-1" });
  });

  it("미소유/미존재 → 404", async () => {
    h.getEvent.mockRejectedValue(new V2CommerceError("not found", 404));
    expect((await mapList(getReq(), listCtx)).status).toBe(404);
  });

  it("🔴 v2 장애 → 503 (빈 목록으로 위장 금지)", async () => {
    h.getEvent.mockRejectedValue(new V2CommerceError("bad gateway", 502));
    expect((await mapList(getReq(), listCtx)).status).toBe(503);
  });
});

describe("seat-maps POST (생성)", () => {
  it("정상 — 201 + v2 write-through", async () => {
    const res = await mapCreate(postReq(), listCtx);
    expect(res.status).toBe(201);
    expect(h.updateEvent).toHaveBeenCalled();
  });

  it("미소유/미존재 → 404, write 미수행", async () => {
    h.getEvent.mockRejectedValue(new V2CommerceError("not found", 404));
    expect((await mapCreate(postReq(), listCtx)).status).toBe(404);
    expect(h.updateEvent).not.toHaveBeenCalled();
    expect(h.upsertSeats).not.toHaveBeenCalled();
  });

  it("🔴 v2 장애 → 503, write 미수행 (400 입력오류로 위장 금지)", async () => {
    h.getEvent.mockRejectedValue(new V2CommerceError("bad gateway", 502));
    expect((await mapCreate(postReq(), listCtx)).status).toBe(503);
    expect(h.updateEvent).not.toHaveBeenCalled();
    expect(h.upsertSeats).not.toHaveBeenCalled();
  });
});

describe("seat-maps/[mapId] GET (단건)", () => {
  it("정상 — 맵 헤더 + v2 좌석", async () => {
    const res = await mapDetail(getReq(), oneCtx);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.id).toBe(MAP_ID);
  });

  it("맵이 payload 에 없으면 404", async () => {
    h.getEvent.mockResolvedValue({ event_id: EVENT_ID, content: { seat_map_data: { maps: [] } } });
    expect((await mapDetail(getReq(), oneCtx)).status).toBe(404);
  });

  it("미소유/미존재 → 404", async () => {
    h.getEvent.mockRejectedValue(new V2CommerceError("not found", 404));
    expect((await mapDetail(getReq(), oneCtx)).status).toBe(404);
  });

  it("🔴 v2 장애 → 503", async () => {
    h.getEvent.mockRejectedValue(new V2CommerceError("bad gateway", 502));
    expect((await mapDetail(getReq(), oneCtx)).status).toBe(503);
  });
});
