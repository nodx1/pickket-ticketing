/**
 * 좌석 이벤트 버스 — SSE 브로드캐스트 (Phase 4)
 *
 * - Pub/Sub: 실시간 알림용 (`seat:events:<mapId>`)
 * - Stream: Last-Event-ID 기반 catch-up 재생 (`seat:stream:<mapId>`)
 *   P0-C2: 네트워크 끊김 후 재연결 시 누락 이벤트 복구.
 */
import { getRedis } from "@/lib/redis";

// 공유 Redis 네임스페이스 분리 — getRedis()는 keyPrefix가 없고 ioredis keyPrefix는
// Pub/Sub 채널에 적용되지 않으므로, 키·채널명에 `go:`를 직접 박는다. (cross-team 충돌 방지)
const SEAT_STREAM_PREFIX = "go:seat:stream:";
const SEAT_EVENTS_PREFIX = "go:seat:events:";

export interface SeatUpdateMessage {
  type: "seat_update" | "snapshot";
  mapId: string;
  seats?: Array<{ id: string; status: string }>;
  available?: number;
  held?: number;
  reserved?: number;
  ts: string;
  sequence: number;
}

type PublishPayload = Omit<SeatUpdateMessage, "ts" | "sequence">;

/**
 * 좌석 업데이트 발행.
 * - Redis Stream 에 append (MAXLEN ~1000 캡, XADD id=*)
 * - Pub/Sub 로 실시간 브로드캐스트
 *
 * Stream ID 가 곧 sequence 역할 (Redis 가 단조 증가 보장).
 */
export async function publishSeatUpdate(
  mapId: string,
  payload: PublishPayload,
): Promise<void> {
  const redis = getRedis();
  const ts = new Date().toISOString();
  // ioredis xadd 시그니처:
  //   xadd(key, "MAXLEN", "~", 1000, "*", field, value, ...)
  const streamId = await redis.xadd(
    `${SEAT_STREAM_PREFIX}${mapId}`,
    "MAXLEN",
    "~",
    "1000",
    "*",
    "data",
    JSON.stringify({ ...payload, ts }),
  );

  const fullMessage: SeatUpdateMessage = {
    ...payload,
    ts,
    // sequence: Redis stream ID (ms-seq) → number 로 근사.
    // 재접속 catch-up 은 streamId 자체(문자열)를 Last-Event-ID 로 사용.
    sequence: streamId ? Date.now() : 0,
  };

  await redis.publish(
    `${SEAT_EVENTS_PREFIX}${mapId}`,
    JSON.stringify({ ...fullMessage, streamId }),
  );
}

/**
 * mapId 에 대한 좌석 업데이트 구독.
 *
 * 주의: 구독 전용 ioredis 인스턴스를 duplicate() 로 생성한다.
 * unsubscribe() 반환 함수 호출 시 구독 해제 + 연결 종료.
 */
export function subscribeSeatUpdates(
  mapId: string,
  handler: (msg: SeatUpdateMessage & { streamId?: string }) => void,
): () => void {
  const redis = getRedis().duplicate();
  const channel = `${SEAT_EVENTS_PREFIX}${mapId}`;

  void redis.subscribe(channel).catch(() => {});

  redis.on("message", (_channel, raw) => {
    try {
      const parsed = JSON.parse(raw) as SeatUpdateMessage & {
        streamId?: string;
      };
      handler(parsed);
    } catch {
      // JSON 파싱 실패 — 무시
    }
  });

  return () => {
    void redis.unsubscribe(channel).catch(() => {});
    void redis.quit().catch(() => {});
  };
}

/**
 * Last-Event-ID 이후의 누락 이벤트를 Redis Stream 에서 재생.
 * SSE catch-up 시 사용.
 *
 * @param mapId   좌석맵 ID
 * @param afterId 클라이언트가 마지막으로 수신한 stream id (없으면 "0-0")
 * @param limit   한 번에 재생할 최대 개수
 */
export async function replaySeatUpdates(
  mapId: string,
  afterId: string,
  limit = 100,
): Promise<Array<{ streamId: string; message: SeatUpdateMessage }>> {
  const redis = getRedis();
  // XRANGE key exclusive-start +  → exclusive start 는 `(` 접두어.
  const startId = afterId === "0" || afterId === "" ? "-" : `(${afterId}`;
  try {
    const entries = (await redis.xrange(
      `${SEAT_STREAM_PREFIX}${mapId}`,
      startId,
      "+",
      "COUNT",
      limit,
    )) as Array<[string, string[]]>;
    const out: Array<{ streamId: string; message: SeatUpdateMessage }> = [];
    for (const [streamId, fields] of entries) {
      // fields 는 ["data", "<json>"] 꼴
      const idx = fields.indexOf("data");
      if (idx >= 0 && idx + 1 < fields.length) {
        try {
          const parsed = JSON.parse(fields[idx + 1]) as Omit<
            SeatUpdateMessage,
            "sequence"
          > & { sequence?: number };
          out.push({
            streamId,
            message: {
              ...parsed,
              sequence: parsed.sequence ?? 0,
            },
          });
        } catch {
          // JSON 파싱 실패 — 무시
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}
