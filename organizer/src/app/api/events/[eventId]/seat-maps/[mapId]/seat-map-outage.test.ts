/**
 * 레벨2 T2-EVT — 좌석맵 빌더 라우트의 **v2 응답불가 처리** 회귀.
 *
 * 소유/앵커 해석(`resolveV2EventIdFor`·`fetchSeatMapEntry`·`verifySeatMapOwnershipV2`)이 go `events`
 * SELECT 에서 v2 `organizer_ref` 조회로 옮겨가면서, v2 장애는 `V2CommerceError` 가 아니라
 * `EventAccessError(unavailable)` 로 던져진다. 라우트들이 `V2CommerceError` 만 잡고 있었으므로
 * flip 직후 v2 장애는 **정체불명 500**(또는 400 "입력 오류")으로 표면화됐다.
 *
 * 여기서 고정하는 계약:
 *   - v2 장애 → **503**(재시도 가능). 404(영구 없음)·400(입력 오류)·500(정체불명) 어느 쪽도 아니다.
 *   - v2 404(없음/타 계정) → 그대로 **404**. 두 상태를 합치지 않는다.
 *   - 쓰기 경로는 확인 불가 상태에서 **아무것도 쓰지 않는다**(fail-closed).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  getEvent: vi.fn(),
  updateEvent: vi.fn(),
  upsertSeats: vi.fn(),
  query: vi.fn(),
}));

vi.mock("@/lib/v2/commerce-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/v2/commerce-client")>();
  return { ...actual, getEvent: h.getEvent, updateEvent: h.updateEvent, upsertSeats: h.upsertSeats };
});
vi.mock("@/lib/db/pool", () => ({ getPool: () => ({ query: h.query }) }));
vi.mock("@/lib/auth/permissions", () => ({
  withRole:
    (
      _role: string,
      handler: (
        request: Request,
        ctx: { session: { id: string; accountId: string; role: string }; params: unknown },
      ) => Promise<Response>,
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

import { DELETE as mapDelete } from "./route";
import {
  DELETE as landmarkDelete,
  GET as landmarkList,
  PATCH as landmarkBulk,
  POST as landmarkCreate,
} from "./landmarks/route";
import {
  DELETE as groupDelete,
  GET as groupList,
  POST as groupCreate,
} from "./groups/route";
import { GET as versionList, POST as versionCreate } from "./versions/route";
import { GET as versionDetail } from "./versions/[versionId]/route";
import { POST as seatImport } from "./import/route";
import { GET as seatList } from "./seats/route";
import { GET as seatExport } from "./export/route";
import { GET as checkInOverlay } from "./check-in-overlay/route";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const MAP_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ID = "33333333-3333-4333-8333-333333333333";

const ctx = { params: Promise.resolve({ eventId: EVENT_ID, mapId: MAP_ID }) };
const versionCtx = {
  params: Promise.resolve({ eventId: EVENT_ID, mapId: MAP_ID, versionId: "1" }),
};

const url = (suffix = "") => `http://localhost/seat-maps/${MAP_ID}${suffix}`;
// 라우트 시그니처는 NextRequest 를 요구하지만 이 테스트가 쓰는 건 url/method/body 뿐이다.
const get = (suffix = "") => new Request(url(suffix)) as unknown as NextRequest;
const send = (method: string, body: unknown, suffix = "") =>
  new Request(url(suffix), { method, body: JSON.stringify(body) }) as unknown as NextRequest;

/** v2 5xx = 응답불가. getOwnedEvent 가 EventAccessError(unavailable) 로 변환한다. */
function v2Down() {
  h.getEvent.mockRejectedValue(new V2CommerceError("bad gateway", 502));
}
/** v2 404 = 없거나 내 것이 아님. */
function v2NotFound() {
  h.getEvent.mockRejectedValue(new V2CommerceError("not found", 404));
}

afterEach(() => {
  h.getEvent.mockReset();
  h.updateEvent.mockReset();
  h.upsertSeats.mockReset();
  h.query.mockReset();
});

/** [라벨, 호출] — 전부 소유/앵커 해석을 첫 단계로 타는 경로. */
const routes: Array<[string, () => Promise<Response>]> = [
  ["landmarks GET", () => landmarkList(get("/landmarks"), ctx)],
  ["landmarks POST", () => landmarkCreate(send("POST", { type: "stage", x: 1, y: 2 }, "/landmarks"), ctx)],
  ["landmarks PATCH", () => landmarkBulk(send("PATCH", { landmarks: [] }, "/landmarks"), ctx)],
  [
    "landmarks DELETE",
    () => landmarkDelete(send("DELETE", {}, `/landmarks?id=${OTHER_ID}`), ctx),
  ],
  ["groups GET", () => groupList(get("/groups"), ctx)],
  [
    "groups POST",
    () =>
      groupCreate(
        send("POST", { name: "VIP", type: "vip_box", seatIds: [OTHER_ID] }, "/groups"),
        ctx,
      ),
  ],
  ["groups DELETE", () => groupDelete(send("DELETE", {}, `/groups?id=${OTHER_ID}`), ctx)],
  ["versions GET", () => versionList(get("/versions"), ctx)],
  ["versions POST", () => versionCreate(send("POST", { snapshot: {} }, "/versions"), ctx)],
  ["versions/[versionId] GET", () => versionDetail(get("/versions/1"), versionCtx)],
  ["seat-map DELETE", () => mapDelete(send("DELETE", {}, ""), ctx)],
  ["seats GET", () => seatList(get("/seats"), ctx)],
  ["export GET", () => seatExport(get("/export"), ctx)],
  ["check-in-overlay GET", () => checkInOverlay(get("/check-in-overlay"), ctx)],
  [
    "import POST",
    () =>
      seatImport(
        send(
          "POST",
          { seats: [{ section: "A", row: "1", seatNumber: "1", tierId: OTHER_ID }] },
          "/import",
        ),
        ctx,
      ),
  ],
];

describe("v2 응답불가 → 503 (404·400·500 로 뭉개지 않는다)", () => {
  for (const [label, call] of routes) {
    it(`🔴 ${label}`, async () => {
      v2Down();
      const res = await call();
      expect(res.status, `${label} 이 503 이 아님`).toBe(503);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain("잠시 후 다시 시도해주세요");
      // fail-closed: 확인 불가 상태에서 v2 로 아무것도 쓰지 않는다.
      expect(h.updateEvent).not.toHaveBeenCalled();
      expect(h.upsertSeats).not.toHaveBeenCalled();
    });
  }
});

describe("v2 404(없음/타 계정) → 404 유지 (503 으로 승격하지 않는다)", () => {
  // ⚠️ seat-map DELETE 는 "이미 없음"을 멱등 성공(200)으로 흡수하는 계약이라 이 표에서 제외한다.
  //    바로 그 흡수 때문에 위 503 케이스가 중요하다 — 확인 불가가 여기로 흘러들면
  //    "지우지 않은 배치도를 지웠다"고 답하게 된다.
  const notFoundRoutes = routes.filter(([label]) => label !== "seat-map DELETE");
  for (const [label, call] of notFoundRoutes) {
    it(`${label}`, async () => {
      v2NotFound();
      const res = await call();
      expect(res.status, `${label} 이 404 가 아님`).toBe(404);
    });
  }

  it("seat-map DELETE 는 '이미 없음'을 멱등 성공으로 흡수(기존 계약)", async () => {
    v2NotFound();
    const res = await mapDelete(send("DELETE", {}, ""), ctx);
    expect(res.status).toBe(200);
  });
});
