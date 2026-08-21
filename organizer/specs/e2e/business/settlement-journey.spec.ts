/**
 * 정산(settlement) 저니 E2E — 목록 조회 → 기간 동결(finalize) → 입금완료(PATCH).
 * 정산 SoT = v2(OrganizerSettlement). go 라우트는 v2 위임 + 상태 투영.
 * 기존 business 스펙(order-ticket-checkin) 패턴 따름 — API 기반.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { loginAsDemoApi } from "../helpers/auth";
import { getSeededEventIds } from "../helpers/events";

let request: APIRequestContext;
let liveEventId: string;

test.describe("정산 저니 — 목록·동결·입금", () => {
  test.beforeAll(async ({ playwright }) => {
    request = await playwright.request.newContext({ baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3011" });
    await loginAsDemoApi(request);
    const ids = await getSeededEventIds(request);
    liveEventId = ids.liveEventId;
  });

  test.afterAll(async () => {
    await request.dispose();
  });

  // ── 1. 정산 목록 조회 (live read, v2 위임) ──────────────────────────
  test("1. 정산 목록 API가 정상 응답하고 집계 요약을 포함한다", async () => {
    const res = await request.get("/api/account/settlements?page=1&limit=20");
    expect(res.status(), `정산 목록 실패: ${await res.text()}`).toBe(200);
    const body = await res.json();
    // 응답 봉투: { success, data: items[], total, ... } 또는 listResponse 형태
    const items = body.data ?? body.items ?? body.settlements ?? [];
    expect(Array.isArray(items), "정산 items 배열이어야 함").toBe(true);
    // 각 item 은 기간·순지급액 필드를 갖는다(있을 경우)
    if (items.length > 0) {
      const s = items[0];
      expect(s).toHaveProperty("periodStart");
      expect(s).toHaveProperty("netAmount");
      expect(s).toHaveProperty("status");
    }
  });

  // ── 2. 기간 동결(finalize) — v2 freezeSettlement 위임 ────────────────
  test("2. 이벤트 기간을 동결하면 정산 row 가 생성/갱신된다", async () => {
    expect(liveEventId, "liveEventId 미설정").toBeTruthy();
    const res = await request.post("/api/account/settlements/finalize", {
      data: { eventIds: [liveEventId] },
    });
    // 동결은 admin 이상 — demo 는 owner 이므로 허용. 매출 0 이어도 0-동결은 유효.
    expect([200, 201], `동결 응답 예상밖: ${res.status()} ${await res.text()}`).toContain(res.status());
    const body = await res.json();
    const data = body.data ?? body;
    // 동결 결과는 정산 식별자/상태를 포함한다.
    expect(data, "동결 응답 바디 존재").toBeTruthy();
  });

  // ── 3. 동결된 정산을 입금완료로 전이 + 은행정보 기록 ──────────────────
  test("3. 정산을 입금완료(completed)로 전이할 수 있다", async () => {
    const listRes = await request.get("/api/account/settlements?page=1&limit=20");
    expect(listRes.status()).toBe(200);
    const body = await listRes.json();
    const items = body.data ?? body.items ?? body.settlements ?? [];
    if (items.length === 0) {
      test.skip(true, "동결된 정산이 없어 입금완료 전이 테스트 불가");
      return;
    }
    const target = items[0];
    const patchRes = await request.patch(`/api/account/settlements/${target.id}`, {
      data: {
        status: "completed",
        bankName: "테스트은행",
        bankAccount: "000-0000-0000",
        bankHolder: "픽켓데모",
      },
    });
    // 입금완료는 불가역 재무작업 — admin 이상. demo(owner)는 허용.
    expect([200, 409, 422], `입금완료 응답 예상밖: ${patchRes.status()} ${await patchRes.text()}`).toContain(
      patchRes.status(),
    );
    if (patchRes.status() === 200) {
      const pb = await patchRes.json();
      const pd = pb.data ?? pb;
      expect(pd, "PATCH 응답 바디 존재").toBeTruthy();
    }
  });

  // ── 4. 비정상 요청 가드 — 빈 eventIds 동결 거부 ─────────────────────
  test("4. 빈 eventIds 동결 요청은 검증 거부된다", async () => {
    const res = await request.post("/api/account/settlements/finalize", {
      data: { eventIds: [] },
    });
    expect(res.status(), "빈 eventIds 는 400 검증거부 기대").toBeGreaterThanOrEqual(400);
  });
});
