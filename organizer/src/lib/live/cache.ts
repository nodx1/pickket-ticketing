/**
 * 라이브 캐시 — **lazy + single-flight**, 그리고 🔴 **rev 와 본문을 따로 캐시한다**.
 *
 * ```
 * AllSet LiveScore  ──▶  go Redis  ──▶  티켓 페이지
 *                        (여기)         20초마다 우리 캐시만 읽음
 * ```
 *
 * ## 🔴 왜 캐시가 둘인가 (2026-08-06 상대 지적)
 *
 * 처음엔 20초 통합 캐시였다. 그러면 **원천 30초 주기와 어긋나 체감 지연이 최대 50초**가
 * 된다(우리 20초 + 원천 30초). 관중은 15번홀 선수를 13번홀에서 찾는다.
 *
 * ```
 * rev(지문)   5초 캐시   →  12회/분. 상한 30회/분이라 여유         (약 80바이트)
 * 본문        🔴 **시간이 아니라 `data_at` 이 바뀔 때** 무효화   → 분당 2회 수준
 * 연결 확인   지문이 같아도 60초마다 1회는 본문을 받는다 (규약)
 * ```
 *
 * ⚠️ 본문을 시간 기반으로 되돌리면 **`data_at` 이 바뀌었는데 옛 본문이 나온다** — 캐시가
 *    신선하다는 이유로. 지연이 바로 그 자리에서 다시 생긴다(뮤테이션 V8).
 *
 * ## 🔴 왜 크론이 아닌가
 *
 *     go cron   기존 크론은 **1분 주기가 최소**다(CF 경유) → 스코어에 60초 지연
 *     v2 celery 홉이 하나 더 늘고 화면과 캐시가 다른 서비스로 갈린다
 *
 * 요청이 있을 때만 갱신한다. **관중이 아무도 안 보면 원천을 아예 안 때린다.**
 *
 * ## 🔴 락이 없으면 이 설계가 흉기가 된다
 *
 * 갤러리 수천 명이 동시에 경계를 넘으면 **수천 요청이 동시에** 원천을 때린다
 * (thundering herd). ⟹ 락을 잡은 **한 요청만** 갱신하고 나머지는 **옛 값을 즉시** 준다.
 */
import { getPrefixedRedis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { LiveSourceError, liveGameCode, liveSource } from "@/lib/live/source";
import type { LiveBody, LiveSource } from "@/lib/live/source";

/** 🔴 지문 캐시 수명. 원천 30초 주기를 놓치지 않으려면 이보다 길면 안 된다. */
export const REV_FRESH_MS = 5_000;
/** 🔴 지문이 같아도 이만큼 본문을 못 받았으면 받는다 — 스펙 §3 이 요구하는 연결 확인. */
export const BODY_MAX_AGE_MS = 60_000;
/** 락 TTL. 갱신이 죽어도 이 시간이면 다음 요청이 이어받는다. */
const LOCK_TTL_SEC = 10;

export interface LiveSnapshot {
  body: LiveBody;
  /** 본문을 받을 당시의 원천 지문(`/rev` 의 data_at). */
  dataAt: string | null;
  /** 🔴 **원천 본문을 마지막으로 받은** 시각(ms). 우리 폴링 시각이 아니다. */
  contentAt: number;
  /** 마지막 갱신 **시도**가 실패했는가. */
  stale: boolean;
  /** 마지막으로 원천을 확인한 시각(표시용). 정지 판정에 쓰지 않는다. */
  checkedAt: number;
}

/** 지문만 담는 작은 캐시 — 본문과 수명이 다르다. */
interface RevCache {
  dataAt: string | null;
  at: number;
}

function keyOf(suffix: string): string {
  // getPrefixedRedis 가 `go:` 를 붙인다. 게임 코드로 대회를 가른다.
  return `live:${liveGameCode() || "default"}:${suffix}`;
}

const BODY_KEY = "body";
const REV_KEY = "rev";
const LOCK_KEY = "lock";

async function readJson<T>(key: string): Promise<T | null> {
  try {
    const raw = await getPrefixedRedis().get(keyOf(key));
    return raw ? (JSON.parse(raw) as T) : null;
  } catch (err: unknown) {
    logger.warn("라이브 캐시 읽기 실패", {
      key,
      error: err instanceof Error ? err.message : "unknown",
    });
    return null;
  }
}

async function writeJson(key: string, value: unknown, ttlSec: number): Promise<void> {
  try {
    await getPrefixedRedis().set(keyOf(key), JSON.stringify(value), "EX", ttlSec);
  } catch (err: unknown) {
    logger.warn("라이브 캐시 쓰기 실패", {
      key,
      error: err instanceof Error ? err.message : "unknown",
    });
  }
}

/** 락을 잡았으면 true. NX 라 **동시 요청 중 하나만** 참을 받는다. */
async function acquireLock(): Promise<boolean> {
  try {
    const ok = await getPrefixedRedis().set(keyOf(LOCK_KEY), "1", "EX", LOCK_TTL_SEC, "NX");
    return ok === "OK";
  } catch (err: unknown) {
    // 🔴 Redis 가 죽었으면 갱신하지 **않는다**. 락 없이 갱신을 허용하면 정확히
    //    thundering herd 가 된다 — 인프라 장애가 상대 API 장애로 번진다.
    logger.warn("라이브 락 획득 실패", {
      error: err instanceof Error ? err.message : "unknown",
    });
    return false;
  }
}

async function releaseLock(): Promise<void> {
  try {
    await getPrefixedRedis().del(keyOf(LOCK_KEY));
  } catch {
    // TTL 이 있으므로 해제 실패는 치명적이지 않다.
  }
}

/** 원천 응답이 비었는가 — 🔴 비었으면 **덮어쓰지 않는다**. */
function isEmptyBody(body: LiveBody): boolean {
  return body.leaderboard.length === 0 && body.groups.length === 0;
}

/**
 * 캐시를 읽고, 필요하면 이 요청이 갱신한다.
 *
 * 🔴 갱신에 실패해도 **직전 값을 그대로 돌려준다**. 화면을 비우지 않는다 —
 *    상대도 같은 정책이다(스펙 §8). 우리가 비우면 두 겹의 방어가 무의미해진다.
 */
export async function getLiveSnapshot(
  now: number = Date.now(),
  source: LiveSource = liveSource(),
): Promise<LiveSnapshot | null> {
  const [cached, rev] = await Promise.all([
    readJson<LiveSnapshot>(BODY_KEY),
    readJson<RevCache>(REV_KEY),
  ]);

  const revFresh = rev !== null && now - rev.at < REV_FRESH_MS;
  const bodyStaleByFingerprint =
    cached === null || (revFresh && rev !== null && rev.dataAt !== cached.dataAt);
  const bodyTooOld = cached !== null && now - cached.contentAt >= BODY_MAX_AGE_MS;

  // 🔴 지문이 신선하고 본문이 그 지문과 같으면 **원천을 아예 안 때린다**.
  //    본문 나이는 여기서 보지 않는다 — 지문이 같다는 건 원천이 안 바뀌었다는 뜻이다.
  if (revFresh && !bodyStaleByFingerprint && !bodyTooOld) {
    return cached;
  }

  if (!(await acquireLock())) {
    // 🔴 다른 요청이 갱신 중이다. **기다리지 않고** 옛 값을 즉시 준다.
    //    기다리면 갤러리 수천 명이 동시에 4초씩 붙잡힌다.
    return cached;
  }

  try {
    return await refresh(cached, rev, revFresh, now, source);
  } finally {
    await releaseLock();
  }
}

async function refresh(
  cached: LiveSnapshot | null,
  revCache: RevCache | null,
  revFresh: boolean,
  now: number,
  source: LiveSource,
): Promise<LiveSnapshot | null> {
  let dataAt: string | null;
  if (revFresh && revCache !== null) {
    dataAt = revCache.dataAt; // 5초 안이면 지문을 다시 안 묻는다
  } else {
    try {
      dataAt = (await source.fetchRev()).data_at;
    } catch (err: unknown) {
      return onFailure(cached, now, err);
    }
    await writeJson(REV_KEY, { dataAt, at: now } satisfies RevCache, 60);
  }

  // 🔴 본문 무효화 기준은 **지문**이다. 시간이 아니다.
  const fingerprintSame = cached !== null && dataAt !== null && dataAt === cached.dataAt;
  // 다만 지문이 같아도 60초 넘게 본문을 못 받았으면 받는다 — 원천이 지문을 안 바꾼 채
  // 죽어도 우리는 영원히 정상으로 보이기 때문이다(규약이 요구하는 연결 확인).
  const bodyTooOld = cached === null || now - cached.contentAt >= BODY_MAX_AGE_MS;

  if (fingerprintSame && !bodyTooOld) {
    // 본문을 안 받는다. ⚠️ contentAt 은 건드리지 않는다 — 그게 정지 판정의 근거다.
    const next: LiveSnapshot = { ...cached, checkedAt: now, stale: false };
    await writeJson(BODY_KEY, next, 3600);
    return next;
  }

  let body: LiveBody;
  try {
    body = await source.fetchBody();
  } catch (err: unknown) {
    return onFailure(cached, now, err);
  }

  if (isEmptyBody(body) && cached !== null && !isEmptyBody(cached.body)) {
    // 🔴 빈 응답으로 **덮어쓰지 않는다**. 화면이 통째로 비는 사고가 여기서 난다.
    //    다만 `stale` 로 표시해 화면이 "실시간"이라고 말하지 않게 한다.
    logger.warn("라이브 원천이 빈 응답 — 직전 값 유지", { dataAt });
    const next: LiveSnapshot = { ...cached, checkedAt: now, stale: true };
    await writeJson(BODY_KEY, next, 3600);
    return next;
  }

  const next: LiveSnapshot = {
    body,
    dataAt,
    contentAt: now, // 본문을 실제로 받은 시각
    stale: false,
    checkedAt: now,
  };
  // TTL 은 넉넉히 — 만료되면 **직전 값을 지키는 정책 자체가 사라진다**.
  await writeJson(BODY_KEY, next, 3600);
  return next;
}

function onFailure(
  cached: LiveSnapshot | null,
  now: number,
  err: unknown,
): LiveSnapshot | null {
  logger.warn("라이브 원천 갱신 실패 — 직전 값 유지", {
    kind: err instanceof LiveSourceError ? err.kind : "unknown",
    error: err instanceof Error ? err.message : "unknown",
  });
  if (cached === null) return null;
  // 🔴 값은 그대로 두고 stale 만 세운다. contentAt 도 그대로 —
  //    실패했다고 "방금 받았다"로 적으면 정지를 영원히 못 잡는다.
  const next: LiveSnapshot = { ...cached, checkedAt: now, stale: true };
  void writeJson(BODY_KEY, next, 3600);
  return next;
}
