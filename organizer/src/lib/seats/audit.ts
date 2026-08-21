/**
 * 좌석 감사 로그 헬퍼 — Phase 10 → 레벨2 코덱스 재감사 P1(트랜잭션 아웃박스 이관).
 *
 * DB trigger (migration 138) 가 기본 좌석 상태 변경을 기록하지만,
 * 이 헬퍼는 hold/release 같은 비즈니스 액션 컨텍스트를 추가로 남긴다.
 *
 * 이전: go audit_logs 직접 INSERT + 실패삼킴(catch→warn). 감사 정본이 v2 로 이관되면서
 *   go audit_logs 직접쓰기는 폐지. 상태변경과 원자적이어야 하므로 async HTTP 대신
 *   **트랜잭션 아웃박스**로 적재 → 워커/cron 이 v2 로 드레인.
 *
 * ⚠️ 반드시 상태변경과 **동일 트랜잭션 클라이언트(executor)** 로 호출해야 원자성이 성립한다.
 *    (실패삼킴 제거: 아웃박스 INSERT 실패 시 상위 트랜잭션이 롤백 → 감사 유실 대신 작업 실패).
 */
import type { PoolClient } from "pg";
import { enqueueAuditOutbox } from "@/lib/audit/outbox";

/** 상태변경과 같은 txn 을 공유해야 하므로 executor(client) 를 필수로 받는다. */
type TxExecutor = Pick<PoolClient, "query">;

interface SeatAuditBase {
  accountId: string;
  userId?: string;
  eventId: string;
  seatIds: string[];
}

async function insertSeatAudit(
  executor: TxExecutor,
  action: string,
  args: SeatAuditBase & { changes: Record<string, unknown> },
) {
  if (args.seatIds.length === 0) return;
  await enqueueAuditOutbox(executor, {
    action,
    tableName: "seats",
    accountId: args.accountId,
    userId: args.userId ?? null,
    recordId: args.seatIds[0],
    changes: { eventId: args.eventId, seatIds: args.seatIds, ...args.changes },
  });
}

export async function logSeatHold(
  executor: TxExecutor,
  args: SeatAuditBase & { holdId: string; holdToken?: string },
) {
  await insertSeatAudit(executor, "seat_hold", {
    ...args,
    changes: { holdId: args.holdId },
  });
}

export async function logSeatRelease(
  executor: TxExecutor,
  args: SeatAuditBase & { holdId?: string; reason?: string },
) {
  await insertSeatAudit(executor, "seat_release", {
    ...args,
    changes: { holdId: args.holdId, reason: args.reason },
  });
}

export async function logSeatSold(
  executor: TxExecutor,
  args: SeatAuditBase & { orderId: string },
) {
  await insertSeatAudit(executor, "seat_sold", {
    ...args,
    changes: { orderId: args.orderId },
  });
}

export async function logSeatForceRelease(
  executor: TxExecutor,
  args: SeatAuditBase & { holdId?: string; reason: string },
) {
  await insertSeatAudit(executor, "seat_force_release", {
    ...args,
    changes: { holdId: args.holdId, reason: args.reason },
  });
}
