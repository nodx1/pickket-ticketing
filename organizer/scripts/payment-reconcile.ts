/**
 * 결제 누락 대사 cron (payment reconciliation).
 *
 * pending-first 재배선(P0): recordPaymentConfirmOutbox 가 go COMMIT 과 원자적으로 남긴 pending outbox 를
 *   drain(트랜잭션 밖·커밋 후) 해 동일 멱등키로 v2 confirm → confirmed 로 수렴. 224 전 completed 는
 *   구형 스캐너가 pending 으로 백필. 정본 로직: src/lib/payment/reconcile.ts. v2 코드 변경 0.
 *
 * 사용:
 *   npx tsx scripts/payment-reconcile.ts             # 1회 실행(최근 48h)
 *   npx tsx scripts/payment-reconcile.ts --dry-run   # 탐지만(복구 안 함)
 *   npx tsx scripts/payment-reconcile.ts --window=0  # 전체 백필(초기 1회)
 *   npx tsx scripts/payment-reconcile.ts --watch     # 300초마다 무한 반복(개발/테스트)
 *
 * 운영: k8s CronJob 5분 주기 권장(infra/cron/payment-reconcile.yaml).
 *   failed>0 누적 = 실결제 누락 위험 → 알림 연동 대상(로그 "ALERT" 라인).
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { reconcileOrphanTossPendingPayments, reconcilePayments } from "@/lib/payment/reconcile";
import { processExpiredPaymentCompensations, reconcileUnknownCompensations } from "@/lib/payment/compensation";

// .env.local 자동 로딩 (seat-hold-reaper 와 동일 패턴)
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

function parseWindow(): number {
  const arg = process.argv.find((a) => a.startsWith("--window="));
  if (!arg) return 48;
  const n = Number(arg.split("=")[1]);
  return Number.isFinite(n) && n >= 0 ? n : 48;
}

const EMPTY_ORPHAN_TOSS = { scanned: 0, refunding: 0, stillPending: 0, lookupFailed: 0 };

export function hasRecoveryFailure(summary: {
  failed: number;
  lookupFailed: number;
  manualReview: number;
  compensation: { failed: number; unknown: number; manualReview: number };
  compensationReconciliation: { manualReview: number };
  orphanToss: { lookupFailed: number };
}): boolean {
  return summary.failed > 0
    || summary.lookupFailed > 0
    || summary.manualReview > 0
    || summary.compensation.failed > 0
    || summary.compensation.unknown > 0
    || summary.compensation.manualReview > 0
    || summary.compensationReconciliation.manualReview > 0
    || summary.orphanToss.lookupFailed > 0;
}

export async function runOnce(dryRun: boolean, windowHours: number) {
  const s = await reconcilePayments({ dryRun, windowHours });
  const compensation = dryRun
    ? { claimed: 0, completed: 0, failed: 0, unknown: 0, manualReview: 0 }
    : await processExpiredPaymentCompensations();
  const compensationReconciliation = dryRun
    ? { checked: 0, resolved: 0, manualReview: 0, remaining: 0 }
    : await reconcileUnknownCompensations();
  // K8s가 실행하는 이 스크립트도 HTTP route와 동일하게 Toss PG-first orphan을 회수한다.
  // --dry-run은 외부 조회/상태변경을 하지 않는 탐지 모드이므로 스캐너를 호출하지 않는다.
  const orphanToss = dryRun ? EMPTY_ORPHAN_TOSS : await reconcileOrphanTossPendingPayments();
  const tag = dryRun ? "[dry-run] " : "";
  const line = `${tag}scanned ${s.scanned} · 드리프트 ${s.mismatched} · 복구 ${s.repaired} · 실패 ${s.failed} · manual_review ${s.manualReview} · 보상환불 ${compensation.completed} · 보상 retry실패 ${compensation.failed} · 보상 unknown ${compensation.unknown} · 보상 manual_review ${compensation.manualReview} · 보상대사해결 ${compensationReconciliation.resolved} · Toss orphan 조회 ${orphanToss.scanned} · orphan 환불큐 ${orphanToss.refunding} · orphan 조회실패 ${orphanToss.lookupFailed}`;
  console.log(`[payment-reconcile] ${new Date().toISOString()} — ${line}`);
  for (const d of s.details) {
    if (d.outcome !== "repaired" || dryRun) {
      console.log(
        `  · ${d.outcome} ${d.orderNumber || d.goOrderId} (₩${d.amount.toLocaleString()})${d.error ? " — " + d.error : ""}`,
      );
    }
  }
  return { ...s, compensation, compensationReconciliation, orphanToss };
}

async function main() {
  const watch = process.argv.includes("--watch");
  const dryRun = process.argv.includes("--dry-run");
  const windowHours = parseWindow();
  const intervalMs = 300_000; // 5분

  if (watch) {
    console.log("[payment-reconcile] watch 모드 시작 (300초 간격)");
    for (;;) {
      try {
        await runOnce(dryRun, windowHours);
      } catch (err: unknown) {
        console.error(
          "[payment-reconcile] 에러:",
          err instanceof Error ? err.message : err,
        );
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  } else {
    const s = await runOnce(dryRun, windowHours);
    // 미복구 실패가 있으면 비정상 종료코드(모니터링 훅용).
    process.exit(hasRecoveryFailure(s) ? 2 : 0);
  }
}

// 테스트에서 runOnce/hasRecoveryFailure를 import할 수 있도록 직접 실행 시에만 main을 시작한다.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  main().catch((err: unknown) => {
    console.error(
      "[payment-reconcile] 치명적 에러:",
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  });
}
