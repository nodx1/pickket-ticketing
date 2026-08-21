/**
 * Liveness probe — 프로세스가 살아있는지 최소 확인.
 *
 * 외부 의존성 확인 없이 즉시 200 반환.
 * k8s/Docker healthcheck에서 재시작 판단에 사용.
 */
import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({ status: "alive", timestamp: new Date().toISOString() });
}
