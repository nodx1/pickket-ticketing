/**
 * 트랙 4.1~4.4 — AI 도면 인식 endpoint 회귀
 *
 * 클라이언트 검출 결과를 POST 하면 좌석/랜드마크가 일괄 INSERT 되는지 검증.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { loginAsDemoApi } from "../helpers/auth";
import { getSeededEventIds } from "../helpers/events";

let request: APIRequestContext;
let eventId: string;
let seatMapId: string;

test.describe.serial("AI 도면 인식 (트랙 4.1~4.4)", () => {
  test.beforeAll(async ({ playwright }) => {
    request = await playwright.request.newContext({
      baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3011",
    });
    await loginAsDemoApi(request);
    const ids = await getSeededEventIds(request);
    eventId = ids.liveEventId;

    const mapRes = await request.post(`/api/events/${eventId}/seat-maps`, {
      data: {
        name: `ai-detect ${Date.now()}`,
        sections: ["AI"],
        rowsPerSection: 1,
        seatsPerRow: 1,
      },
    });
    expect(mapRes.ok()).toBeTruthy();
    seatMapId = (await mapRes.json()).data.id;
  });

  test.afterAll(async () => {
    await request.dispose().catch(() => undefined);
  });

  test("ai-detect: 좌석 + 랜드마크 일괄 적용", async () => {
    const res = await request.post(
      `/api/events/${eventId}/seat-maps/${seatMapId}/ai-detect`,
      {
        data: {
          seats: [
            { section: "A", row: "A", seatNumber: "1", x: 100, y: 200 },
            { section: "A", row: "A", seatNumber: "2", x: 130, y: 200 },
            { section: "A", row: "A", seatNumber: "3", x: 160, y: 200 },
          ],
          landmarks: [
            {
              type: "stage",
              label: "MAIN",
              x: 80,
              y: 100,
              width: 200,
              height: 40,
            },
          ],
          replace: false,
        },
      },
    );
    expect(res.ok(), `ai-detect 실패: ${await res.text()}`).toBeTruthy();
    const body = await res.json();
    expect(body.data.inserted).toBe(3);
    expect(body.data.landmarks).toBe(1);
  });

  test("ai-detect: replace=true 모드", async () => {
    const res = await request.post(
      `/api/events/${eventId}/seat-maps/${seatMapId}/ai-detect`,
      {
        data: {
          seats: [
            { section: "B", row: "B", seatNumber: "1", x: 50, y: 50 },
          ],
          landmarks: [],
          replace: true,
        },
      },
    );
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.data.inserted).toBe(1);
    expect(body.data.replaced).toBe(true);

    // 기존 3석 + AI 좌석 1개 교체 → 1개만 남음
    const seatsRes = await request.get(
      `/api/events/${eventId}/seat-maps/${seatMapId}/seats`,
    );
    const seatsBody = await seatsRes.json();
    expect(seatsBody.data.length).toBe(1);
  });

  test("ai-detect: 잘못된 mapId 400", async () => {
    const res = await request.post(
      `/api/events/${eventId}/seat-maps/invalid-uuid/ai-detect`,
      { data: { seats: [], landmarks: [], replace: false } },
    );
    expect(res.status()).toBe(400);
  });
});
