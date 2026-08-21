/**
 * 테스트 플래그 유출 판정 — 배포 이미지에 `PLAYWRIGHT_TEST=1` 이 있는가.
 *
 * ⚠️ 이 파일에 `server-only` 를 붙이지 않는다. 붙이면 vitest 에서 import 자체가 막혀
 *    판정 로직을 검사할 수 없다(실제로 그렇게 한 번 막혔다). 순수 함수라 노출돼도 무해하다.
 *    부팅 시 실제로 던지는 쪽은 `env.server.ts` 의 `assertNoTestFlagLeak()` 이다.
 *
 * ── 이 플래그가 프로덕션에 새면 무엇이 꺼지나 (실측) ──
 *  · `withRateLimit` 라우트 리미터 — **완전 우회** (`withRateLimit.ts:44`)
 *  · `proxy.ts` 전역 리미터 — **완전 우회** (2026-07-30 대칭화 이후. 그전엔 ×10)
 *      ⟹ go 계층 레이트리밋이 **0** 이 된다. 이 가드가 그 우회 확대의 전제 조건이다.
 *  · 🔴 **온라인 결제 self-complete 강제차단 해제** — `api/checkout/complete/route.ts` (감사 P0-5).
 *      결제키가 없으면 `arePaymentsLive()` 도 false 라, 이 판정만 무너지면 카드/토스/카카오/
 *      네이버 주문을 **PG 승인 없이 완료**시킬 수 있다. 셋 중 가장 무겁다.
 *  · 티켓 접근 쿠키 / 내티켓 조회 토큰 쿠키의 `secure` — 꺼진다
 *      (`api/tickets/[ticketNumber]/access/route.ts`, `api/public/my-tickets/verify/route.ts`)
 *      ※ 대시보드 세션(`pickket_session`)은 여기 없다 — v2 가 발급해 `forwardSetCookies` 로
 *        그대로 전달되므로 이 판정을 타지 않는다. 노출되는 건 **티켓/주문 접근 자격**이다.
 *  · `getRuntimeEnv` 의 필수 env 하드체크 — 느슨해진다 (`isStrictRuntime`)
 *
 * 위 넷은 전부 같은 식이었고 지금은 `env/runtime.ts` 의 `isProdRuntime()` 하나로 모았다.
 *
 * 🔴 `NODE_ENV === "production"` 으로 판별하지 않는 이유
 * 라이브 검증을 `npm run build && npm run start` 로 한다(검증 원칙 #11 — dev 서버는
 * 하이드레이션이 안 돼 신뢰 불가). 그래서 **로컬 검증도 NODE_ENV=production** 이다.
 * 그걸로 하드 실패시키면 우리 검증 워크플로가 죽는다.
 *
 * 대신 `.build-info.json` 의 `app` 을 본다. 이 파일은 `deploy-app.sh` 가 **배포 타르볼에만**
 * 주입하므로 `app !== "local"` ⟺ 배포된 이미지다. 로컬 프로덕션 빌드는 항상 `"local"`.
 */
import { isTestFlagEnabled } from "./runtime";

export function testFlagLeakIssue(input: {
  /** `getBuildInfo().app` — 배포 이미지면 앱 이름, 로컬이면 "local". */
  app: string;
  /** `process.env.PLAYWRIGHT_TEST` 원값. */
  playwrightTest: string | undefined;
}): string | null {
  // 우회 판정과 **같은 함수**를 쓴다 — 각자 `"1"` 을 적으면 한쪽만 느슨해졌을 때
  // "가드는 통과하는데 차단만 풀린" 구멍이 생긴다(`runtime.ts` 의 `isTestFlagEnabled` 주석).
  if (!isTestFlagEnabled(input.playwrightTest)) return null;
  if (input.app === "local") return null;
  return (
    `배포 이미지(app="${input.app}")에 PLAYWRIGHT_TEST=1 이 설정돼 있습니다. ` +
    `레이트리밋(라우트·전역 모두)이 완전히 꺼지고 티켓 접근 쿠키의 secure 가 해제됩니다. ` +
    `배포 이미지에 이 플래그의 정당한 용도는 없습니다 — CapRover 앱 환경변수에서 제거하세요.`
  );
}
