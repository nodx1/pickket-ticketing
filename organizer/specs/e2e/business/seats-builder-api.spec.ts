/**
 * 트랙 2.6 / 2.11 / 2.12 / 2.15 — 빌더 신규 API 스목
 * - landmarks CRUD
 * - versions (snapshot save + list)
 * - groups (블록 생성)
 * - export (JSON / CSV)
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { loginAsDemoApi } from "../helpers/auth";
import { getSeededEventIds } from "../helpers/events";

let request: APIRequestContext;
let eventId: string;
let seatMapId: string;
let seatIds: string[] = [];

test.describe.serial("좌석 빌더 신규 API (트랙 2.6/2.11/2.12/2.15)", () => {
  test.beforeAll(async ({ playwright }) => {
    request = await playwright.request.newContext({
      baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3011",
    });
    await loginAsDemoApi(request);
    const ids = await getSeededEventIds(request);
    eventId = ids.liveEventId;

    const mapRes = await request.post(`/api/events/${eventId}/seat-maps`, {
      data: {
        name: `builder-api ${Date.now()}`,
        sections: ["BUILDER"],
        rowsPerSection: 2,
        seatsPerRow: 4,
      },
    });
    expect(mapRes.ok()).toBeTruthy();
    seatMapId = (await mapRes.json()).data.id;

    const seatsRes = await request.get(
      `/api/events/${eventId}/seat-maps/${seatMapId}/seats`,
    );
    const body = await seatsRes.json();
    seatIds = (body.data ?? []).map((s: { id: string }) => s.id);
  });

  test.afterAll(async () => {
    await request.dispose().catch(() => undefined);
  });

  test("landmarks: 빈 목록 조회 → 200 + []", async () => {
    const res = await request.get(
      `/api/events/${eventId}/seat-maps/${seatMapId}/landmarks`,
    );
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.data)).toBeTruthy();
  });

  test("landmarks: POST 단일 생성 → 201", async () => {
    const res = await request.post(
      `/api/events/${eventId}/seat-maps/${seatMapId}/landmarks`,
      {
        data: {
          type: "stage",
          label: "MAIN STAGE",
          x: 500,
          y: 50,
          width: 200,
          height: 40,
        },
      },
    );
    expect(res.ok(), `landmark 생성 실패: ${await res.text()}`).toBeTruthy();
    const body = await res.json();
    expect(body.data.type).toBe("stage");
    expect(body.data.label).toBe("MAIN STAGE");
  });

  test("landmarks: PATCH 일괄 upsert", async () => {
    const res = await request.patch(
      `/api/events/${eventId}/seat-maps/${seatMapId}/landmarks`,
      {
        data: {
          landmarks: [
            { type: "stage", label: "STAGE", x: 500, y: 50, width: 200, height: 40 },
            { type: "exit", label: "EXIT A", x: 50, y: 600, width: 60, height: 60 },
          ],
        },
      },
    );
    expect(res.ok()).toBeTruthy();
  });

  test("versions: 스냅샷 저장 + 조회", async () => {
    const saveRes = await request.post(
      `/api/events/${eventId}/seat-maps/${seatMapId}/versions`,
      {
        data: {
          snapshot: { seats: [], landmarks: [], tiers: [] },
          note: "initial",
        },
      },
    );
    expect(saveRes.ok(), `version 저장 실패: ${await saveRes.text()}`).toBeTruthy();
    const saveBody = await saveRes.json();
    expect(saveBody.data.version).toBe(1);

    const listRes = await request.get(
      `/api/events/${eventId}/seat-maps/${seatMapId}/versions`,
    );
    expect(listRes.ok()).toBeTruthy();
    const listBody = await listRes.json();
    expect(listBody.data.length).toBeGreaterThanOrEqual(1);
  });

  test("groups: 좌석 블록 생성 + 조회", async () => {
    if (seatIds.length === 0) {
      test.skip(true, "좌석 미확보");
      return;
    }
    const createRes = await request.post(
      `/api/events/${eventId}/seat-maps/${seatMapId}/groups`,
      {
        data: {
          name: "VIP BOX 1",
          type: "vip_box",
          colorHex: "#6c5ce7",
          icon: "★",
          seatIds: seatIds.slice(0, 2),
        },
      },
    );
    expect(createRes.ok(), `그룹 생성 실패: ${await createRes.text()}`).toBeTruthy();
    const createBody = await createRes.json();
    expect(createBody.data.name).toBe("VIP BOX 1");
    expect(createBody.data.seatIds.length).toBe(2);

    const listRes = await request.get(
      `/api/events/${eventId}/seat-maps/${seatMapId}/groups`,
    );
    expect(listRes.ok()).toBeTruthy();
    const listBody = await listRes.json();
    expect(listBody.data.length).toBeGreaterThanOrEqual(1);
  });

  test("export: JSON 전체 내보내기", async () => {
    const res = await request.get(
      `/api/events/${eventId}/seat-maps/${seatMapId}/export?format=json`,
    );
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.map?.id).toBe(seatMapId);
    expect(Array.isArray(body.seats)).toBeTruthy();
    expect(Array.isArray(body.landmarks)).toBeTruthy();
    expect(Array.isArray(body.groups)).toBeTruthy();
  });

  test("export: CSV 내보내기", async () => {
    const res = await request.get(
      `/api/events/${eventId}/seat-maps/${seatMapId}/export?format=csv`,
    );
    expect(res.ok()).toBeTruthy();
    const text = await res.text();
    expect(text).toContain("section,row,seat_number");
  });
});
