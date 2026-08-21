import "server-only";
import { logger } from "@/lib/logger";
import { getBuildInfo } from "@/lib/build-info";
import { testFlagLeakIssue } from "@/lib/env/test-flag-leak";
import { isProdRuntime } from "@/lib/env/runtime";

const cachedValues = new Map<string, string>();
const warnedVariables = new Set<string>();

function isStrictRuntime() {
  // 같은 판정을 공용 함수로 모았다 — 인라인 복제가 네 곳까지 갔던 식이다(`env/runtime.ts` 주석).
  return isProdRuntime();
}

export function getRuntimeEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function getRuntimeFlag(name: string): boolean {
  const value = getRuntimeEnv(name)?.toLowerCase();
  return value === "true" || value === "1";
}

export function getRuntimeSecret(
  name: string,
  developmentFallback: string,
): string {
  if (cachedValues.has(name)) {
    return cachedValues.get(name) ?? developmentFallback;
  }

  const value = process.env[name]?.trim();
  if (value) {
    cachedValues.set(name, value);
    return value;
  }

  if (isStrictRuntime()) {
    throw new Error(`${name} 환경변수가 필요합니다`);
  }

  if (!warnedVariables.has(name)) {
    warnedVariables.add(name);
    logger.warn("[env] 개발용 fallback 사용", { env: name });
  }

  cachedValues.set(name, developmentFallback);
  return developmentFallback;
}

/**
 * 크로스-프로덕트(v2) 계약 env 부팅 검증 (Phase 0b).
 *
 * 오늘 경계감사에서 나온 "조용히 깨지는" 두 클래스를 부팅 시점에 surface 한다:
 *  - 웹훅 시크릿 미설정 → v2→go 웹훅이 전건 401 (이벤트 심사/fcfs 전파 끊김)
 *  - JWT iss/aud 가 v2 발급값과 불일치 → verifyV2AccessToken 이 전 토큰 거부 (인증 전면 실패)
 *
 * production 에서도 하드 throw 는 하지 않는다(의도된 override 여지 + 배포 차단 회피).
 * 대신 error 로 로깅해 모니터링/Sentry 가 즉시 포착하게 한다.
 */
const CANONICAL_V2_ISS = "pickket-api";
const CANONICAL_V2_AUD = "pickket-clients";

export function assertCrossProductEnv(): void {
  const issues: string[] = [];

  if (!getRuntimeEnv("GO_WEBHOOK_SECRET") && !getRuntimeEnv("V2_EVENT_SYNC_SECRET")) {
    issues.push(
      "GO_WEBHOOK_SECRET/V2_EVENT_SYNC_SECRET 둘 다 미설정 — v2→go 웹훅이 전건 401 처리됩니다",
    );
  }

  const iss = getRuntimeEnv("V2_JWT_ISSUER");
  const aud = getRuntimeEnv("V2_JWT_AUDIENCE");
  if (iss && iss !== CANONICAL_V2_ISS) {
    issues.push(
      `V2_JWT_ISSUER="${iss}" — v2 발급값 "${CANONICAL_V2_ISS}"와 다르면 모든 대시보드 인증이 실패합니다`,
    );
  }
  if (aud && aud !== CANONICAL_V2_AUD) {
    issues.push(
      `V2_JWT_AUDIENCE="${aud}" — v2 발급값 "${CANONICAL_V2_AUD}"와 다르면 모든 대시보드 인증이 실패합니다`,
    );
  }

  // V2_JWT_SECRET 미설정 → verifyV2AccessToken 이 전 토큰을 거부해 모든 대시보드 인증이
  // 조용히 401 로 실패한다. iss/aud 는 불일치만 잡던 기존 검증에 '미설정'도 추가. (감사 P1-20)
  if (isStrictRuntime() && !getRuntimeEnv("V2_JWT_SECRET")) {
    issues.push("V2_JWT_SECRET 미설정 — 모든 대시보드 인증이 401 로 실패합니다");
  }

  // 프로덕션 결제 mock 오설정 감지. mode.ts 순환참조 회피 위해 판정 로직 인라인.
  // mock/미연동 상태면 실결제 없이 self-complete 로 주문이 완료될 수 있다. (감사 P1-23)
  const paymentsLive = Boolean(getRuntimeEnv("TOSS_SECRET_KEY"));
  if (isStrictRuntime() && !paymentsLive) {
    issues.push(
      "프로덕션인데 토스페이먼츠 결제가 미연동(TOSS_SECRET_KEY 미설정) — 실결제 없이 주문이 완료될 수 있습니다",
    );
  }

  if (issues.length > 0) {
    const message = `[env] 크로스-프로덕트(v2) 계약 경고:\n  - ${issues.join("\n  - ")}`;
    if (isStrictRuntime()) {
      logger.error(message);
    } else {
      logger.warn(message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 테스트 플래그 유출 가드 — 배포 이미지에 `PLAYWRIGHT_TEST=1` 이 있으면 부팅을 막는다
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 부팅 시 호출. 위반이면 **throw** 한다. (판정 근거·무엇이 꺼지는지는 `env/test-flag-leak.ts`)
 *
 * `assertCrossProductEnv` 는 프로덕션에서도 의도적으로 throw 하지 않는다(다른 항목은 의도된
 * override 여지가 있어서다). 이 건은 다르다 — 배포 이미지에 이 플래그의 정당한 용도가 없다.
 *
 * ⚠️ 한계 1 (fail-open): 배포함정 #1 — 지정 워크트리가 아닌 곳에서 배포하면 `.build-info.json`
 *    이 주입되지 않아 배포본도 `"local"` 로 보이고 **가드가 걸리지 않는다**.
 *    "배포는 지정 워크트리에서" 운영 규칙으로 막고 있어 수용하지만, 이 가드 하나만 믿으면 안 된다.
 *
 * ⚠️ 한계 2 — **누가 이 발화를 보는가**. throw 하면 프로세스가 죽는 대신 전 요청이 500 이 되는데,
 *    `pickket-organizer` 는 CapRover `serviceUpdateOverride` 로 도커 헬스체크가 **`Test: ["NONE"]`**
 *    이다(실조회 확인. `pickket-admin` 도 동일, `pickket-consumer` 는 override 없음).
 *    즉 **스웜은 500 을 뿜는 컨테이너를 healthy 로 둔다.** 실제로 잡아주는 건 배포 스크립트의
 *    헬스 검증(`scripts/ops/deploy-app.sh`, `set -euo pipefail` + `curl -fsS`)뿐이다.
 *      · main 계보: 단발 `curl` — 500 이면 배포는 실패하지만 재시도가 없어 기동 지연과 경합한다
 *      · `fix/tier-capacity` 계보(a3bf65bf): 재시도 + 커밋 일치 확인. **main 에는 없다**
 *    ⟹ **배포 경로로 들어온 오설정만 잡힌다.** CapRover UI 에서 env 만 추가하고 재시작하면
 *       가드는 발화하지만 **관측자가 없다**. 가드를 "자동 차단"으로 신뢰하지 말 것.
 */
export function assertNoTestFlagLeak(): void {
  const issue = testFlagLeakIssue({
    app: getBuildInfo().app,
    playwrightTest: process.env.PLAYWRIGHT_TEST,
  });
  if (issue) {
    logger.error(`[env] ${issue}`);
    throw new Error(`[env] ${issue}`);
  }
}
