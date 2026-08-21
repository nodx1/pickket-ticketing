/**
 * go 발송 세그먼트 → v2 `/internal/lottery/won-entries` 조회.
 *
 * 레벨2: go `bids` write 가 410 으로 폐기(추첨 SoT = v2)되면서, 당첨자 세그먼트를
 * go bids 로 해석하면 **항상 0명**이 된다(조용한 무발송). 당첨자 정본은 v2
 * LotteryEntry(result=WON)이므로 여기서 조회해 go attendees.order_id 와 매칭한다.
 *
 * 반환값 = 당첨 주문의 `order_ref`(= v2 Order.external_ref = go order id) 목록.
 * 조회 실패는 **throw**(fail-closed) — 빈 목록으로 위장하면 다시 조용한 무발송이 된다.
 */
import crypto from "node:crypto";
import { logger } from "@/lib/logger";

const V2_WON_ENTRIES_PATH = "/api/v1/internal/lottery/won-entries";

function sign(secret: string, timestamp: string, body: string): string {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export class V2LotteryWonEntriesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "V2LotteryWonEntriesError";
  }
}

/** v2 당첨자 주문 ref 목록. v2EventId = events.v2_event_id(canonical). */
export async function fetchWonOrderRefs(v2EventId: string): Promise<string[]> {
  const baseUrl = process.env.V2_INTERNAL_BASE_URL;
  const secret = process.env.V2_EVENT_SYNC_SECRET;
  if (!baseUrl || !secret) {
    throw new V2LotteryWonEntriesError(
      "커머스 연동이 설정되지 않아 추첨 당첨자 세그먼트를 사용할 수 없습니다",
    );
  }

  const url = `${baseUrl.replace(/\/$/, "")}${V2_WON_ENTRIES_PATH}`;
  const timestamp = new Date().toISOString();
  const body = JSON.stringify({ eventId: v2EventId });
  const signature = sign(secret, timestamp, body);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Pickket-Signature": signature,
        "X-Pickket-Timestamp": timestamp,
        "X-Pickket-Event": "lottery.won-entries",
        "X-Pickket-Delivery-Id": crypto.randomUUID(),
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err: unknown) {
    throw new V2LotteryWonEntriesError(
      `추첨 당첨자 조회 중 커머스 연결에 실패했습니다: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }
  if (!res.ok) {
    throw new V2LotteryWonEntriesError(
      `추첨 당첨자 조회에 실패했습니다 (커머스 응답 ${res.status})`,
    );
  }

  const data = (await res.json()) as {
    entries?: Array<{ order_ref?: string | null }>;
    total?: number;
  };
  // go attendees.order_id 는 uuid 라 UUID 형태가 아닌 external_ref 는 애초에 매칭될 수
  // 없다. 걸러내지 않으면 `= ANY($n::uuid[])` 캐스팅에서 Postgres 가 에러를 던져 세그먼트
  // 전체가 500 이 된다(무손실 방어).
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const refs = (data.entries ?? [])
    .map((e) => e.order_ref)
    .filter((r): r is string => Boolean(r) && UUID_RE.test(r!));
  logger.info("v2 추첨 당첨자 조회", {
    v2EventId,
    entries: data.entries?.length ?? 0,
    withOrder: refs.length,
  });
  return refs;
}
