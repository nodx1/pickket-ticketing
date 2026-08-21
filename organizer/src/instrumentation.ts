/**
 * Next.js 부팅 훅 (서버 시작 시 1회 실행).
 * - Sentry 서버/엣지 런타임 초기화 (@sentry/nextjs v9는 instrumentation 경유 필수)
 * - 크로스-프로덕트(v2) 계약 env 검증 — 조용히 깨지는 설정을 부팅 시점에 surface
 */
import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("../sentry.server.config");
    const { assertCrossProductEnv, assertNoTestFlagLeak } = await import("@/lib/env.server");
    // 🔴 테스트 플래그가 배포 이미지에 새면 **부팅을 막는다**(경고 아님).
    //    레이트리밋 우회를 넓힌 만큼 이 가드가 전제 조건이다 — 순서상 먼저 본다.
    assertNoTestFlagLeak();
    assertCrossProductEnv();
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
