import { expect, test, type APIRequestContext } from "@playwright/test";
import { loginAsDemoApi } from "../helpers/auth";
import { expectNoCriticalConsoleErrors, trackCriticalConsoleErrors } from "../helpers/assertions";

/**
 * RSVP(무료 참석) ↔ 유료 티켓 판매 배타 렌더 + 정합 가드 회귀.
 *
 * 대상 변경(개선작업 Phase 1·2·4):
 *  - getPublicEventBySlug 가 rsvpEnabled 를 노출하고, 랜딩(/e/[slug])이 RSVP 폼과
 *    티켓 판매를 **배타** 렌더한다(rsvp_enabled=true → RSVP 폼만, false → 티켓만).
 *  - 이벤트 생성/수정 스키마가 rsvpEnabled 를 받는다.
 *  - 정합 가드: RSVP 이벤트에는 유료 티켓 상품을 추가할 수 없다(products POST 409).
 *
 * ⚠️ v2-백킹 라이브 이벤트가 필요하다(커머스 SoT=v2). 로컬 번들 브라우저·v2 미가동 시 CI 에서 실행.
 */

type CreatedEvent = { id: string; slug: string };

async function createLiveEvent(
  request: APIRequestContext,
  opts: { rsvpEnabled: boolean },
): Promise<CreatedEvent> {
  const orgRes = await request.get("/api/organizers?limit=1");
  expect(orgRes.ok(), "organizer 조회 실패").toBeTruthy();
  const orgPayload = (await orgRes.json()) as { data?: Array<{ id: string }> };
  const organizerId = orgPayload.data?.[0]?.id;
  expect(organizerId, "계정에 organizer 가 필요합니다").toBeTruthy();

  const suffix = `${Date.now()}-${Math.floor(performance.now())}`;
  const slug = `e2e-rsvp-${opts.rsvpEnabled ? "on" : "off"}-${suffix}`;
  const startsAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  const endsAt = new Date(Date.now() + 7 * 24 * 3600 * 1000 + 3 * 3600 * 1000).toISOString();

  const res = await request.post("/api/events", {
    data: {
      organizers: [{ organizerId, role: "host", displayOrder: 0 }],
      title: opts.rsvpEnabled ? "E2E RSVP 이벤트" : "E2E 유료 이벤트",
      slug,
      summary: "RSVP/유료 배타 렌더 회귀",
      startsAt,
      endsAt,
      venueName: "E2E 시드홀",
      eventType: "networking",
      ageRating: "all",
      isOnline: false,
      status: "live",
      rsvpEnabled: opts.rsvpEnabled,
    },
  });
  expect(res.status(), `이벤트 생성 실패 ${await res.text()}`).toBe(201);
  const body = (await res.json()) as { data: { id: string } };
  return { id: body.data.id, slug };
}

test.describe("RSVP ↔ 유료 배타", () => {
  test("RSVP 이벤트: 랜딩에 참석 등록 폼이 노출되고 유료 티켓 추가는 차단된다", async ({ page, request }) => {
    await loginAsDemoApi(request);
    const event = await createLiveEvent(request, { rsvpEnabled: true });

    // 정합 가드 — RSVP 이벤트에 유료 티켓 추가 시 409.
    const paidRes = await request.post(`/api/events/${event.id}/products`, {
      data: {
        name: "유료 티켓(가드 테스트)",
        type: "ticket",
        price: "10000",
        isFree: false,
        unlimitedStock: true,
        minPerOrder: "1",
        taxIncluded: true,
      },
    });
    expect(paidRes.status(), "RSVP 이벤트 유료 티켓은 차단되어야 함").toBe(409);

    // 랜딩 — RSVP 폼 노출.
    const errors = trackCriticalConsoleErrors(page);
    await page.goto(`/e/${encodeURIComponent(event.slug)}`);
    await expect(page.getByText("참석 등록 (RSVP)")).toBeVisible();
    await expectNoCriticalConsoleErrors(errors);
  });

  test("유료 이벤트: 랜딩에 RSVP 폼이 노출되지 않는다", async ({ page, request }) => {
    await loginAsDemoApi(request);
    const event = await createLiveEvent(request, { rsvpEnabled: false });

    const errors = trackCriticalConsoleErrors(page);
    await page.goto(`/e/${encodeURIComponent(event.slug)}`);
    await expect(page.locator("body")).toBeVisible();
    await expect(page.getByText("참석 등록 (RSVP)")).toHaveCount(0);
    await expectNoCriticalConsoleErrors(errors);
  });

  test("이벤트 랜딩 헤더는 주최자 CTA(무료로 시작)를 노출하지 않는다(compact chrome)", async ({ page, request }) => {
    await loginAsDemoApi(request);
    const event = await createLiveEvent(request, { rsvpEnabled: false });

    await page.goto(`/e/${encodeURIComponent(event.slug)}`);
    await expect(page.locator("header")).toBeVisible();
    // /e/* 에서는 주최자 전환 CTA를 숨긴다(구매자 중심 compact 헤더).
    await expect(page.locator("header").getByRole("link", { name: "무료로 시작" })).toHaveCount(0);
  });
});
