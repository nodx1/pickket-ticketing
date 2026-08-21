/**
 * 좌석 홀드 분산 락 — Redis NX EX 패턴
 *
 * 용도: DB 트랜잭션 진입 직전에 seatId 단위로 Redis 락을 선점하여
 * 다중 인스턴스 환경(ECS 여러 태스크)에서도 좌석 홀드 경합을 줄인다.
 * DB 레벨 FOR UPDATE SKIP LOCKED 가 최종 방어선이지만, Redis 락으로
 * 불필요한 트랜잭션 롤백을 사전 차단한다.
 *
 * 해제는 Lua 스크립트로 "토큰 일치 시에만 삭제" — 다른 요청의 락을
 * 실수로 풀지 않는다.
 */
import crypto from "node:crypto";
import { getPrefixedRedis } from "@/lib/redis";

const RELEASE_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

function seatLockKey(seatId: string): string {
  // getPrefixedRedis() 가 "go:" prefix 자동 부착. 여기선 내부 키만.
  return `seat:lock:${seatId}`;
}

export interface SeatLockHandle {
  seatId: string;
  token: string;
  acquired: boolean;
}

/**
 * 단일 좌석 락 획득.
 * @returns acquired=true 면 락 소유, false 면 다른 요청이 보유 중.
 */
export async function acquireSeatLock(
  seatId: string,
  ttlMs = 5_000,
): Promise<SeatLockHandle> {
  const redis = getPrefixedRedis();
  const token = crypto.randomUUID();
  const result = await redis.set(seatLockKey(seatId), token, "PX", ttlMs, "NX");
  return { seatId, token, acquired: result === "OK" };
}

/**
 * 다수 좌석 락을 원자성 없이 순차 획득.
 * 일부 실패 시 성공한 락은 즉시 해제하고 빈 배열 반환.
 */
export async function acquireSeatLocks(
  seatIds: string[],
  ttlMs = 5_000,
): Promise<SeatLockHandle[]> {
  const handles: SeatLockHandle[] = [];
  for (const sid of seatIds) {
    const h = await acquireSeatLock(sid, ttlMs);
    if (!h.acquired) {
      // 부분 실패 — 획득한 락 모두 해제
      await releaseSeatLocks(handles);
      return [];
    }
    handles.push(h);
  }
  return handles;
}

/**
 * 단일 락 해제 — Lua 스크립트로 토큰 일치 검증.
 */
export async function releaseSeatLock(handle: SeatLockHandle): Promise<boolean> {
  if (!handle.acquired) return false;
  const redis = getPrefixedRedis();
  const result = await redis.eval(
    RELEASE_LUA,
    1,
    seatLockKey(handle.seatId),
    handle.token,
  );
  return Number(result) === 1;
}

/**
 * 다수 락 해제.
 */
export async function releaseSeatLocks(
  handles: SeatLockHandle[],
): Promise<number> {
  let released = 0;
  for (const h of handles) {
    if (await releaseSeatLock(h)) released += 1;
  }
  return released;
}
