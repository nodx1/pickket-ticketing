/**
 * S2 실동작 검증 — 티켓 로고 폴백 ②(파일 404).
 *
 * ── 왜 E2E 인가 ──
 * 폴백은 **두 갈래고 서로 다른 층**이다.
 *   ① 키가 없다(`logoUrl` 대신 레거시 `logoImageUrl`) → 순수 판정. `lib/ticket/logo.test.ts`.
 *   ② 키는 있는데 **파일이 404** → URL 문자열만 보고는 판별 불가. 브라우저가 실제로 받아보고
 *      `onError` 가 나야 안다. 그래서 이쪽만 여기서 본다.
 *
 * 감추지 않으면 주최자 미리보기와 손님이 받는 초대권에 **깨진 이미지 아이콘**이 박힌다.
 */
import { expect, test } from "@playwright/test";
import { loginAsDemoApi } from "../helpers/auth";

const BROKEN = "https://cdn.pickket.kr/__e2e__/does-not-exist.png";
const OK_PNG = Buffer.from(
  // 1×1 투명 PNG
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

async function firstEventId(request: import("@playwright/test").APIRequestContext) {
  const res = await request.get("/api/events?limit=1");
  if (!res.ok()) return null;
  const body = (await res.json()) as { data?: Array<{ id: string }> };
  return body.data?.[0]?.id ?? null;
}

test.describe("티켓 로고 — 파일이 404 면 감춘다 (S2 폴백 ②)", () => {
  test.use({ viewport: { width: 1440, height: 1100 } });

  test("URL 은 유효한데 파일이 404 면 로고가 렌더되지 않는다", async ({ page }) => {
    await loginAsDemoApi(page.request);
    const eventId = await firstEventId(page.request);
    test.skip(!eventId, "데모 계정에 이벤트가 없어 건너뜀");

    let hits = 0;
    await page.route(BROKEN, async (route) => {
      hits += 1;
      await route.fulfill({ status: 404, contentType: "text/plain", body: "not found" });
    });

    await page.goto(`/events/${eventId}/ticket-designer`);
    const input = page.getByLabel("로고 이미지 URL");
    await expect(input).toBeVisible({ timeout: 15_000 });

    // ── 대조군 먼저: 정상 이미지는 **뜬다** ──
    // 이걸 안 보면 "그냥 항상 안 뜨는 것"과 구분이 안 된다(초록 위장 방지).
    const okUrl = "https://cdn.pickket.kr/__e2e__/ok.png";
    await page.route(okUrl, (route) =>
      route.fulfill({ status: 200, contentType: "image/png", body: OK_PNG }),
    );
    await input.fill(okUrl);
    const logo = page.getByAltText("티켓 로고");
    await expect(logo, "정상 이미지인데도 안 뜬다면 이 테스트는 아무것도 증명하지 못한다").toBeVisible({
      timeout: 10_000,
    });

    // ── 본 검증: 404 로 바꾸면 사라진다 ──
    await input.fill(BROKEN);
    await expect(logo, "파일이 404 인데 로고가 남아 있다 — 깨진 이미지가 박힌다").toBeHidden({
      timeout: 10_000,
    });
    expect(hits, "404 URL 을 실제로 요청하지도 않았다면 onError 경로를 탄 게 아니다").toBeGreaterThan(0);

    // ── 되돌리면 다시 뜬다 (오타 한 번에 영영 안 뜨면 안 된다) ──
    await input.fill(okUrl);
    await expect(logo, "URL 을 고쳤는데 404 표시가 안 풀렸다").toBeVisible({ timeout: 10_000 });
  });
});
