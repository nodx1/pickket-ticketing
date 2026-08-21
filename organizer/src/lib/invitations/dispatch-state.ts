/**
 * 초대권 **발송 상태 3분화** — 「대기」와 「누락」을 가른다.
 *
 * ## 🔴 왜 필요한가 (2026-08-04)
 * 종전 화면은 「발권됨」 하나에 성격이 다른 둘을 섞어 보여줬다.
 * ```
 * ㄱ. 큐에서 순서 기다리는 중   → 곧 나간다. 정상
 * ㄴ. 🔴 큐에 못 들어갔다       → 영원히 안 나간다   ← 23시간 멈춰 있던 5건
 * ```
 * 화면이 가진 것이 `status='issued'` + `sent_at=null` 뿐이라 **같은 픽셀**로 보였다.
 * 게다가 이번 5건은 `failure_reason` 도 비어 있었다 — 실패한 게 아니라 **시도조차
 * 안 했기** 때문이다. 그래서 사유를 보여줄 수도 없었다.
 *
 * ## 🔴 세 값을 구분한다
 * ```
 * dispatchStatus === undefined  v2 구버전이라 정보가 없다  → 누락으로 단정하지 않는다
 * dispatchStatus === null       큐 행 자체가 없다          → 🔴 영원히 안 나간다
 * dispatchStatus === "queued"   순서 대기 중               → 정상
 * ```
 * ⚠️ `undefined` 를 누락으로 읽으면 **구버전 v2 에서 전 행이 빨갛게 뜬다.** 거짓 경보는
 *    진짜 경보를 무디게 만든다 — 그래서 정보가 없으면 조용히 있는다.
 */

/** 큐가 가질 수 있는 값(v2 `ck_invitation_dispatch_status`). */
export type DispatchQueueStatus = "queued" | "sending" | "sent" | "failed";

export interface DispatchRow {
  /** 초대 원장 상태 — `issued | sent | viewed | checked_in | failed | revoked`. */
  status: string;
  sentAt?: string | null;
  failureReason?: string | null;
  /** 큐 상태. **없는 필드(undefined)와 null 은 뜻이 다르다** — 위 주석 참고. */
  dispatchStatus?: string | null;
  /**
   * 🔴 보낸 대상이 **지금 주인이 아니다**(양도 뒤 옛 번호로 나감).
   *
   * 상태는 「발송됨」인데 손님은 못 받았다. 이 값이 없으면 화면이 정상으로 읽고
   * 지나간다 — 그래서 prod 8건이 열흘 가까이 방치됐다(2026-08-12).
   */
  dispatchStale?: boolean;
  /**
   * 큐가 마지막으로 움직인 시각(ISO). **대기 경과는 이 값으로 잰다.**
   *
   * 🔴 초대권 생성 시각(`createdAt`)과 다르다. 어제 발급된 초대권을 방금 다시 큐에
   *    넣으면 대기 시간은 0분이다 — `createdAt` 으로 재면 「1470분째 대기」가 된다
   *    (2026-08-04 실사고). 없으면(구버전 v2·큐 없는 행) `createdAt` 으로 되돌아간다.
   */
  dispatchUpdatedAt?: string | null;
}

export type DispatchView =
  /** 회수됨 — 손댈 것 없다. */
  | { kind: "revoked" }
  /** 나갔다(발송·열람·입장). 기존 상태 라벨을 그대로 쓴다. */
  | { kind: "delivered" }
  /** 큐에서 순서를 기다린다. 정상이다. */
  | { kind: "waiting" }
  /** 🔴 워커가 지금 보내는 중 — **손대면 두 번 나간다.** */
  | { kind: "sending" }
  /** 🔴 안 나갔고 앞으로도 안 나간다. 재발송이 필요하다. */
  | { kind: "missing"; why: "not_queued" | "queue_done_but_unsent" }
  /** 실패했다. 사유가 있으면 그대로 보여준다. */
  | { kind: "failed"; reason: string | null };

/** 값이 실제로 들어 있는 문자열인가. */
function filled(v: string | null | undefined): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/**
 * 한 행의 발송 상태를 가른다.
 *
 * ⚠️ 판정 **순서가 계약**이다. 원장이 확정한 사실(회수·발송·열람·입장)이 큐 상태보다
 *    먼저다 — 큐는 흔적이 남을 뿐 정본이 아니다.
 */
export function classifyDispatch(row: DispatchRow): DispatchView {
  if (row.status === "revoked") return { kind: "revoked" };

  // 🔴 원장이 "나갔다" 고 말하면 나간 것이다. 큐가 뭐라 하든 여기서 끝난다.
  if (row.status === "sent" || row.status === "viewed" || row.status === "checked_in") {
    return { kind: "delivered" };
  }
  if (filled(row.sentAt)) return { kind: "delivered" };

  if (row.status === "failed") {
    return { kind: "failed", reason: filled(row.failureReason) ? row.failureReason : null };
  }

  // 여기부터는 원장 기준 미발송이다. 큐가 답을 준다.
  const q = row.dispatchStatus;

  // 정보가 없다 — 구버전 v2 다. 옛 화면과 같이 조용히 대기로 둔다.
  if (q === undefined) return { kind: "waiting" };

  // 🔴 큐 행이 아예 없다. 아무도 이 초대권을 보낼 예정이 아니다.
  if (q === null) return { kind: "missing", why: "not_queued" };

  if (q === "queued") return { kind: "waiting" };
  if (q === "sending") return { kind: "sending" };
  if (q === "failed") {
    return { kind: "failed", reason: filled(row.failureReason) ? row.failureReason : null };
  }
  // 🔴 큐는 "보냈다" 는데 원장에 발송 시각이 없다. 이번 5건이 정확히 이 모양이었다.
  if (q === "sent") return { kind: "missing", why: "queue_done_but_unsent" };

  // 모르는 큐 상태 — 경보하지 않는다. 근거 없는 빨강은 진짜 빨강을 무디게 한다.
  return { kind: "waiting" };
}

/** 화면 라벨 — 「발권됨」 하나로 뭉개지 않는다. */
export function dispatchLabel(view: DispatchView): string {
  switch (view.kind) {
    case "waiting":
      return "발송 대기";
    case "sending":
      return "발송 중";
    case "missing":
      return "발송 누락";
    case "failed":
      return "발송 실패";
    default:
      return "";
  }
}

/**
 * 이 행이 **주최자 개입이 필요한** 상태인가(빨강).
 *
 * ⚠️ `waiting` 은 정상이므로 빨강이 아니다. 오래 기다리는 것은 배너가 따로 말한다.
 */
export function needsAttention(view: DispatchView): boolean {
  return view.kind === "missing" || view.kind === "failed";
}
