/**
 * 스태프 시나리오 — access 쿠키가 만료된 상태로 정상 티켓을 스캔하면
 * **스태프가 아무것도 안 해도** 통과하는가.
 *
 * ── 왜 이렇게까지 하는가 ──
 * "401 처리 코드가 있다" 로는 판정하지 않는다. 체크인은 카메라 스캔만 있고 수동 입력이
 * 없어서, 실제 스캔을 재현하려면 **가짜 카메라**가 필요하다(Y4M 을 만들어 주입한다).
 *
 * ── 무엇을 스텁하는가 ──
 * v2 `validate-qr` 만 `page.route` 로 가로챈다. 이유 둘:
 *   ① 로컬 v2 CORS 허용 오리진이 `localhost:3000` 뿐이라 브라우저가 아예 못 부른다
 *   ② 유효한 회전 QR(60초 freshness)을 로컬에서 만들 수 없다
 * 갱신(`/api/auth/refresh`)은 **실제 v2 로 나간다** — 쿠키 회전이 진짜로 일어나야
 * CSRF 재생성을 검증한 것이 된다.
 *
 * ── 🔴 실행 조건 (이게 없으면 조용히 거짓 결과가 난다) ──
 *   NEXT_PUBLIC_V2_API_URL=<앱과 같은 오리진>  로 **빌드**한 뒤
 *   E2E_CHECKIN_SAMEORIGIN=1  로 실행한다.
 *
 * 플래그가 없으면 **skip 한다**(실패가 아니라). 이유: v2 가 다른 오리진이면 CORS
 * 프리플라이트가 `page.route` 를 **우회**해 실제 v2 로 나가고, 내 스텁은 POST 를 한 번도
 * 못 본다 → 단언이 엉뚱한 것을 보게 된다. 실제로 그렇게 flaky 했다
 * (`[refresh]` 만 두 번 찍히고 `[시도]` 는 0건).
 *
 * ── 로컬에서 교차오리진을 뺀 이유 ──
 * v2 를 다른 오리진으로 두면 **CORS 프리플라이트가 `page.route` 를 우회**해 실제 네트워크로
 * 나가고, 로컬 v2 는 이 오리진을 허용하지 않아 `Failed to fetch` 로 죽는다(실측).
 * 그래서 테스트에서는 `NEXT_PUBLIC_V2_API_URL` 을 동일 오리진으로 둔다 — 페이지 코드는
 * 그대로이고, 검증 대상(401 → 갱신 → 같은 payload + 새 CSRF 로 재시도)도 그대로다.
 *
 * ⟹ 🔴 **미검증으로 남는 것**: prod 에서 `.pickket.kr` 쿠키가 `api.pickket.kr` 까지 실제로
 *    전달되는가. 로컬은 host-only 쿠키라 그 상황 자체가 아니다. **배포 후 prod 에서 확인한다.**
 */
import { expect, test } from "@playwright/test";
import { loginAsDemoApi } from "../helpers/auth";

const V2 = "**/api/v1/tickets/validate-qr";

test.use({
  permissions: ["camera"],
  launchOptions: {
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--use-file-for-fake-video-capture=/tmp/qr.y4m",
    ],
  },
});

test("access 만료 상태로 스캔해도 스태프 개입 없이 통과한다", async ({ page, context }) => {
  test.skip(
    process.env.E2E_CHECKIN_SAMEORIGIN !== "1",
    "NEXT_PUBLIC_V2_API_URL 을 앱과 같은 오리진으로 빌드한 뒤 E2E_CHECKIN_SAMEORIGIN=1 로 실행할 것 " +
      "— 교차오리진이면 프리플라이트가 page.route 를 우회해 스텁이 동작하지 않는다",
  );
  await loginAsDemoApi(page.request);
  await page.goto("/checkin");

  // ── 만료 재현 ──
  // ⚠️ 이 시점 이후 네비게이션 금지 — layout 의 getServerSession 이 /login 으로 튕긴다.
  //
  // 페이지가 안정된 뒤 지운다. `/checkin` 은 **배경 트래픽이 0건**이라(실측: settle 후
  // 3초간 /api 요청 없음) 지운 직후 스캔의 401 이 확실히 첫 번째가 된다.
  // 현장 스태프도 체크인 화면만 띄워둔 상태다 — 같은 조건이다.
  await page.waitForTimeout(1500);
  const all = await context.cookies();
  await context.clearCookies();
  await context.addCookies(all.filter((c) => c.name !== "pickket_access"));

  const seen: Array<{ csrf: string; payload: string }> = [];
  let refreshCalls = 0;
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === "/api/auth/refresh") refreshCalls += 1;
  });
  page.on("response", async (r) => {
    if (new URL(r.url()).pathname === "/api/auth/refresh") {
      const sc = (await r.allHeaders().catch(() => ({}) as Record<string, string>))["set-cookie"] ?? "";
      const csrf = /pickket_csrf=([^;\n]+)/.exec(sc)?.[1] ?? "(없음)";
      console.log(`  [refresh] status=${r.status()} 새 csrf=${csrf.slice(0, 12)}…`);
    }
  });

  const cors = () => ({
    "access-control-allow-origin": new URL(page.url()).origin,
    "access-control-allow-credentials": "true",
    "content-type": "application/json",
  });
  await page.route(V2, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") {
      return route.fulfill({
        status: 204,
        headers: { ...cors(), "access-control-allow-headers": "content-type,x-csrf-token", "access-control-allow-methods": "POST,OPTIONS" },
      });
    }
    const body = JSON.parse(req.postData() ?? "{}") as { qr_payload?: string };
    const csrfHdr = (await req.headerValue("x-csrf-token")) ?? "";
    seen.push({ csrf: csrfHdr, payload: body.qr_payload ?? "" });
    console.log(`  [시도 ${seen.length}] csrf=${csrfHdr.slice(0, 12)}… payload=${(body.qr_payload ?? "").slice(0, 24)}`);
    if (seen.length === 1) return route.fulfill({ status: 401, headers: cors(), body: "{}" });
    return route.fulfill({
      status: 200,
      headers: cors(),
      body: JSON.stringify({ status: "ok", message: "입장 처리되었습니다", attendee_name: "테스트" }),
    });
  });

  // 스캐너는 버튼을 눌러야 시작한다(권한 요청 → 카메라 부착 → 가짜 QR 즉시 인식).
  // ⚠️ `#qr-reader video` 로 대조군을 잡으면 안 된다 — 가짜 카메라는 2초 안에 인식하고
  //    화면이 result 단계로 넘어가면서 video 가 **사라진다**(실측). 그걸 기다리면
  //    모든 게 정상인데도 테스트가 죽는다. 대조군은 아래 `seen.length` 로 잡는다.
  await page.getByRole("button", { name: "스캐너 시작" }).click();

  // ── 스태프는 아무것도 안 한다. 화면이 스스로 통과해야 한다 ──
  await expect(
    page.getByText(/입장 처리되었습니다/).first(),
    "만료 상태 스캔이 통과되지 않았다 — 스태프가 정상 손님을 돌려보내게 된다",
  ).toBeVisible({ timeout: 30_000 });

  // 대조군 — 스캔이 실제로 일어나 검증 호출이 나갔는가(가짜 카메라가 동작했는가).
  expect(seen.length, "검증 호출이 0건 — 스캔 자체가 안 일어났다").toBeGreaterThanOrEqual(1);
  expect(refreshCalls, "갱신을 안 거치고 통과했다면 이 테스트는 아무것도 증명하지 않는다").toBeGreaterThan(0);
  expect(seen.length, "재시도가 없었다").toBeGreaterThanOrEqual(2);

  // 🔴 재시도는 **찍힌 그 payload** 로 — 회전 QR 을 다시 읽으면 안 된다
  expect(seen[1]!.payload, "재시도가 다른 payload 를 보냈다").toBe(seen[0]!.payload);
  // 🔴 CSRF 는 갱신으로 회전하므로 **새 값**이어야 한다 (같으면 실전에서 403)
  expect(seen[1]!.csrf, "재시도가 낡은 CSRF 를 보냈다 — 실전에서 403 이 된다").not.toBe(seen[0]!.csrf);
  expect(seen[1]!.csrf).not.toBe("");
});
