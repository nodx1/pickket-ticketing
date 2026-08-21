import type { APIRequestContext, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { loginAsDemoApi } from "./auth";

type EventListItem = {
  id: string;
  slug: string;
  title: string;
  status: string;
};

type ApiListResponse<T> = {
  success: boolean;
  data: T[];
};

export async function getSeededEvents(request: APIRequestContext) {
  await loginAsDemoApi(request);
  const response = await request.get("/api/events?limit=20&sort=latest");
  expect(response.ok()).toBeTruthy();

  const payload = (await response.json()) as ApiListResponse<EventListItem>;
  expect(payload.success).toBeTruthy();
  expect(payload.data.length).toBeGreaterThan(0);

  return payload.data;
}

/**
 * v2-백킹 라이브 이벤트를 보장한다(커머스 cutover 후 필수).
 *
 * 빅뱅 flip 후 커머스 SoT=v2 → 시드 이벤트(go DB 직접 INSERT)는 v2_event_id 가 없어
 * 그 위에서 상품/주문 write-through 가 깨진다. 시드 이벤트에 의존하던 기존 동작 대신,
 * **POST /api/events(write-through)로 v2-백킹 라이브 이벤트를 즉석 생성**해 반환한다.
 * (status:"live" 직접 생성 — draft→live PATCH 경로와 무관하게 라이브 보장)
 */
async function createLiveBackedEvent(
  request: APIRequestContext,
): Promise<EventListItem> {
  // host organizer 1개 필요 — 계정의 organizer 조회.
  const orgRes = await request.get("/api/organizers?limit=1");
  expect(orgRes.ok(), "organizer 조회 실패").toBeTruthy();
  const orgPayload = (await orgRes.json()) as ApiListResponse<{ id: string }>;
  const organizerId = orgPayload.data?.[0]?.id;
  expect(organizerId, "계정에 organizer 가 필요합니다").toBeTruthy();

  const slug = `e2e-seed-${Date.now()}-${Math.floor(performance.now())}`;
  const startsAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  const endsAt = new Date(Date.now() + 7 * 24 * 3600 * 1000 + 3 * 3600 * 1000).toISOString();
  const res = await request.post("/api/events", {
    data: {
      organizers: [{ organizerId, role: "host", displayOrder: 0 }],
      title: "E2E 시드 라이브 이벤트",
      slug,
      summary: "getSeededEventIds 자동 생성(v2-백킹)",
      startsAt,
      endsAt,
      venueName: "E2E 시드홀",
      eventType: "concert",
      ageRating: "all",
      isOnline: false,
      // go "live" → v2 "approved" + sale_window(opens_at=now) → v2가 bidding_open 자동전이 → go 투영 live.
      // (EVENT-STATUS-WRITE-CONTRACT 2026-06-03, goToV2WriteEventStatus 배선 후 작동)
      status: "live",
    },
  });
  expect(res.status(), `시드 이벤트 생성 실패 ${await res.text()}`).toBe(201);
  const body = (await res.json()) as { data: { id: string } };
  return { id: body.data.id, slug, title: "E2E 시드 라이브 이벤트", status: "live" };
}

export async function getSeededEventIds(request: APIRequestContext) {
  await loginAsDemoApi(request);
  // 커머스 cutover: v2-백킹 라이브 이벤트를 즉석 생성해 보장(시드 이벤트는 v2 백킹 없음).
  const liveEvent = await createLiveBackedEvent(request);

  return {
    firstEventId: liveEvent.id,
    liveEventId: liveEvent.id,
    liveEventSlug: liveEvent.slug,
  };
}

export async function openFirstEventWorkspace(page: Page) {
  await page.goto("/events");
  const detailLink = page.getByRole("link", { name: "상세 보기" }).first();
  await expect(detailLink).toBeVisible();

  const href = await detailLink.getAttribute("href");
  expect(href).toBeTruthy();

  await detailLink.click();
  await expect(page).toHaveURL(/\/events\/.+\/dashboard$/);

  const eventId = href?.split("/")[2];
  expect(eventId).toBeTruthy();

  return eventId!;
}
