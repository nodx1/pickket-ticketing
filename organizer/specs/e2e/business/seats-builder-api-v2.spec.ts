/**
 * 트랙 2.9 / 2.16 / 7.14 — 빌더 신규 API 추가 회귀 spec
 * - templates GET/POST
 * - collab POST presence
 * - print PDF GET (응답 헤더 검증, 내용 X)
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { loginAsDemoApi } from "../helpers/auth";
import { getSeededEventIds } from "../helpers/events";

let request: APIRequestContext;
let eventId: string;
let seatMapId: string;

test.describe.serial("좌석 빌더 v2 신규 API (트랙 2.9 / 2.16 / 7.14)", () => {
  test.beforeAll(async ({ playwright }) => {
    request = await playwright.request.newContext({
      baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3011",
    });
    await loginAsDemoApi(request);
    const ids = await getSeededEventIds(request);
    eventId = ids.liveEventId;

    const mapRes = await request.post(`/api/events/${eventId}/seat-maps`, {
      data: {
        name: `builder-v2 ${Date.now()}`,
        sections: ["MAIN"],
        rowsPerSection: 1,
        seatsPerRow: 4,
      },
    });
    expect(mapRes.ok()).toBeTruthy();
    seatMapId = (await mapRes.json()).data.id;
  });

  test.afterAll(async () => {
    await request.dispose().catch(() => undefined);
  });

  test("templates: 시스템 시드 5종 + 사용자 템플릿 조회", async () => {
    const res = await request.get("/api/seat-map-templates");
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.data)).toBeTruthy();
    // 시스템 시드 5종 이상
    const systemTemplates = body.data.filter(
      (t: { isSystem: boolean }) => t.isSystem === true,
    );
    expect(systemTemplates.length).toBeGreaterThanOrEqual(5);
  });

  test("templates: category 필터", async () => {
    const res = await request.get("/api/seat-map-templates?category=concert");
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(
      body.data.every((t: { category: string }) => t.category === "concert"),
    ).toBeTruthy();
  });

  test("templates: 사용자 템플릿 저장", async () => {
    const res = await request.post("/api/seat-map-templates", {
      data: {
        name: `E2E custom ${Date.now()}`,
        category: "custom",
        layout: { sections: ["A"], rowsPerSection: 5, seatsPerRow: 10 },
      },
    });
    expect(res.ok(), `템플릿 저장 실패: ${await res.text()}`).toBeTruthy();
    const body = await res.json();
    expect(body.data.isSystem).toBe(false);
  });

  test("collab: presence POST cursor", async () => {
    const res = await request.post(
      `/api/events/${eventId}/seat-maps/${seatMapId}/collab`,
      {
        data: {
          type: "cursor",
          x: 100,
          y: 200,
          displayName: "E2E 빌더",
          color: "#6c5ce7",
        },
      },
    );
    expect(res.ok(), `collab POST 실패: ${await res.text()}`).toBeTruthy();
    const body = await res.json();
    expect(body.data.published).toBe(true);
  });

  test("collab: 잘못된 mapId 400", async () => {
    const res = await request.post(
      `/api/events/${eventId}/seat-maps/invalid-uuid/collab`,
      {
        data: { type: "cursor", x: 0, y: 0 },
      },
    );
    expect(res.status()).toBe(400);
  });

  test("print: 좌석맵 PDF 다운로드", async () => {
    const res = await request.get(
      `/api/events/${eventId}/seat-maps/${seatMapId}/print`,
    );
    expect(res.ok(), `print PDF 실패: ${await res.text()}`).toBeTruthy();
    const ct = res.headers()["content-type"];
    expect(ct).toContain("application/pdf");
  });
});
