/**
 * "진짜 프로덕션 런타임인가" — E2E 플래그가 켜진 실행은 제외한다.
 *
 * ── 왜 공용 함수인가 ──
 * 같은 식(`NODE_ENV === "production" && PLAYWRIGHT_TEST !== "1"`)이 **세 곳에 각자 인라인**돼
 * 있었다. 셋 다 "테스트 실행에서는 보안 제약을 완화한다"는 같은 뜻인데, 각자 적혀 있으니
 * 네 번째가 생겨도 아무도 모른다. 클라이언트 IP 유도가 계층마다 갈라진 것과 같은 패턴이라
 * 통로를 하나로 모은다. (새 인라인 복제는 `no-inline-prod-runtime.guard.test.ts` 가 잡는다)
 *
 * ── 이 값이 false 가 되면 무엇이 풀리나 ──
 *  · 티켓 접근 쿠키 `secure` 해제 — `api/tickets/[ticketNumber]/access/route.ts`
 *  · 내티켓 조회 토큰 쿠키 `secure` 해제 — `api/public/my-tickets/verify/route.ts`
 *  · 🔴 온라인 결제 self-complete 강제차단 해제 — `api/checkout/complete/route.ts` (감사 P0-5).
 *    결제키가 없으면 `arePaymentsLive()` 도 false 라, 이 값만 무너지면 카드/토스/카카오/네이버
 *    주문을 PG 승인 없이 완료시킬 수 있다. **셋 중 가장 무겁다.**
 *
 * 노출되는 건 프로덕션이 아니라 **테스트 실행**뿐이므로, 배포 이미지에 `PLAYWRIGHT_TEST=1` 이
 * 새지 않게 막는 것이 전제다 — `env/test-flag-leak.ts` + 부팅 가드.
 *
 * ⚠️ `server-only` 를 붙이지 않는다. 붙이면 vitest 에서 import 가 막혀 검사할 수 없다.
 *
 * ⚠️ 구조 검사(`runtime.guard.test.ts` — 인라인 복제 없음)와 **동작 검사**(`runtime.test.ts`)는
 *    다른 것을 증명한다. 판정을 뒤집어도 구조 가드는 초록이다. 둘을 짝으로 유지할 것.
 */

/**
 * E2E 테스트 플래그가 켜졌는가 — **이 리터럴이 유일한 정의부**다.
 *
 * 🔴 왜 함수로 빼는가
 * `isProdRuntime()`(우회 판정)과 `testFlagLeakIssue()`(유출 가드)가 각자 `"1"` 을 적고 있었다.
 * 한쪽만 느슨해지면(예: truthy 판정) **가드는 통과하는데 차단만 풀린 상태**가 생긴다 —
 * CapRover 에 `PLAYWRIGHT_TEST=true` 한 줄이면 결제 self-complete 강제차단이 풀리는데
 * 부팅 가드는 조용하다. 두 곳이 같은 함수를 쓰면 갈라질 수가 없다.
 *
 * 정확히 `"1"` 만이다. `"true"`·`"01"`·`" 1"` 은 전부 우회가 아니다.
 */
export function isTestFlagEnabled(raw: string | undefined): boolean {
  return raw === "1";
}

export function isProdRuntime(): boolean {
  return process.env.NODE_ENV === "production" && !isTestFlagEnabled(process.env.PLAYWRIGHT_TEST);
}
