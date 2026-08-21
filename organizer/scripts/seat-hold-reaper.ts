/**
 * 좌석 홀드 만료 처리 (seat hold reaper).
 *
 * 빅뱅 flip B5: go DB 직접변이(UPDATE seats / UPDATE orders) 폐기 →
 *   v2 commerce-client.reapInventory() 가 만료 hold·미결제주문·좌석해제를 원자/멱등 처리.
 *   (정본: pickket.v2 internal_commerce.py _do_reap — holds_reaped/orders_expired/seats_released)
 *
 * ★ DROP 대상 테이블(seats 상태/orders 데이터컬럼)을 더 이상 직접 read/write 하지 않는다.
 *   advisory lock·legacy reserved 정리·go orders 만료도 v2 가 소유하므로 제거.
 *
 * 사용:
 *   npx tsx scripts/seat-hold-reaper.ts         # 1회 실행 (전체 이벤트)
 *   npx tsx scripts/seat-hold-reaper.ts --watch # 60초마다 무한 반복 (개발/테스트용)
 *
 * 운영 환경은 k8s CronJob (infra/cron/seat-hold-reaper.yaml) 으로 5분 주기 실행.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { reapInventory } from "@/lib/v2/commerce-client";
import { seatMetrics } from "@/lib/seats/metrics";

// .env.local 자동 로딩
const envLocalPath = path.resolve(process.cwd(), ".env.local");
if (fs.existsSync(envLocalPath)) {
  for (const line of fs.readFileSync(envLocalPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

interface ReapResult {
  releasedSeats: number;
  expiredOrders: number;
  holdsReaped: number;
}

async function reapOnce(): Promise<ReapResult> {
  // v2 가 만료 hold 회수 + 만료 미결제주문 EXPIRED + 좌석 SOLD→AVAILABLE 을
  // 단일 트랜잭션으로 처리(중첩기동 방어/advisory lock 도 v2 측 책임).
  // event_id 미지정 = 전체 이벤트 대상. limit 기본 500(최대 2000).
  const { holds_reaped, orders_expired, seats_released } = await reapInventory();

  // 만료로 회수된 hold + 환불/만료로 release 된 좌석 = 메트릭상 "릴리즈"로 집계.
  const releasedSeats = holds_reaped + seats_released;
  seatMetrics.incrementReaper(releasedSeats);

  return {
    releasedSeats,
    expiredOrders: orders_expired,
    holdsReaped: holds_reaped,
  };
}

async function main() {
  const watch = process.argv.includes("--watch");
  const intervalMs = 60_000;

  if (watch) {
    console.log("[seat-hold-reaper] watch 모드 시작 (60초 간격)");
    while (true) {
      try {
        const result = await reapOnce();
        if (result.releasedSeats > 0 || result.expiredOrders > 0) {
          console.log(
            `[seat-hold-reaper] ${new Date().toISOString()} — 좌석 ${result.releasedSeats}개 릴리즈(hold ${result.holdsReaped}), 주문 ${result.expiredOrders}개 만료`,
          );
        }
      } catch (err: unknown) {
        console.error(
          "[seat-hold-reaper] 에러:",
          err instanceof Error ? err.message : err,
        );
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  } else {
    const result = await reapOnce();
    console.log(
      `[seat-hold-reaper] 완료 — 좌석 ${result.releasedSeats}개 릴리즈(hold ${result.holdsReaped}), 주문 ${result.expiredOrders}개 만료`,
    );
    process.exit(0);
  }
}

main().catch((err: unknown) => {
  console.error(
    "[seat-hold-reaper] 치명적 에러:",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
