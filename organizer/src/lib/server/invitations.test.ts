import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 레벨2 컷오버 W5-ATTENDEE — 초대권 원장이 go DB → v2 정본으로 옮겨졌다.
 * 이 테스트는 옛 인메모리 **pg 스텁** 대신 인메모리 **v2 원장 fake** 로 같은 불변식을 검증한다.
 *
 * 회귀 축:
 *  · 발급 멱등(2회 호출 1장) — reserve 의 `created` 게이팅
 *  · CSV dedup / 재업로드 스킵 / 용량 캡
 *  · 타테넌트 vs v2 장애 구분(문구 분리) — "이벤트 없음" 위장 금지
 *  · 캡 집계 조회 실패를 0 으로 강등하지 않음(초과발권 차단)
 *  · claim-lease 로 두 번째 드레인이 재발송하지 않음
 *  · 🔴 **안정 멱등키** — 리스 만료 재클레임(crash 재시도)은 같은 NCP 멱등키,
 *    명시적 재발송(send_epoch+1)만 다른 키
 *  · go DB(pool) 를 **한 번도 만지지 않음** — 이관 완료의 물증
 */

const {
  createOrder, ensureCompProduct, sendAlimtalkBatch, hasAlimtalkCredentials, fetchAlimtalkDeliveryStatus,
  getOwnedEvent, getEvent, FakeEventAccessError, FakeV2CommerceError, redisStore, redisState,
  reserveInvitation, invitationNextSeq, markInvitationIssued, markInvitationFailedV2, listEventInvitations,
  claimInvitationDispatch, requeueInvitationDispatch, completeInvitationDispatch,
  listPendingDeliveryCheck, reportInvitationDeliveryResult,
  getPool,
  revokeInvitationV2,
} = vi.hoisted(() => ({
  createOrder: vi.fn(),
  ensureCompProduct: vi.fn(),
  revokeInvitationV2: vi.fn(),
  sendAlimtalkBatch: vi.fn(),
  fetchAlimtalkDeliveryStatus: vi.fn(),
  hasAlimtalkCredentials: vi.fn(() => false),
  getOwnedEvent: vi.fn(),
  getEvent: vi.fn(),
  reserveInvitation: vi.fn(),
  invitationNextSeq: vi.fn(),
  markInvitationIssued: vi.fn(),
  markInvitationFailedV2: vi.fn(),
  listEventInvitations: vi.fn(),
  claimInvitationDispatch: vi.fn(),
  requeueInvitationDispatch: vi.fn(),
  completeInvitationDispatch: vi.fn(),
  listPendingDeliveryCheck: vi.fn(),
  reportInvitationDeliveryResult: vi.fn(),
  /**
   * 인메모리 Redis — 배치 멱등 래퍼가 쓰는 `SET key v EX n NX` / `GET` 만 흉내낸다.
   * 🔴 진짜처럼 동작해야 한다. `set` 이 항상 "OK" 를 돌려주는 stub 이면 멱등 자체가
   *    검증되지 않고(항상 첫 실행처럼 보임) 재사용 경로가 죽은 코드가 된다.
   */
  redisStore: new Map<string, string>(),
  /** true 면 Redis 호출이 던진다 — fail-closed 경로 검증용. */
  redisState: { fail: false },
  getPool: vi.fn(() => {
    throw new Error("go DB 접근이 남아 있다(W5-ATTENDEE 이관 위반)");
  }),
  FakeEventAccessError: class EventAccessError extends Error {
    constructor(message: string, readonly reason: "not_found" | "unavailable", readonly status: number) {
      super(message);
    }
  },
  FakeV2CommerceError: class V2CommerceError extends Error {
    constructor(
      message: string,
      readonly status: number,
      /** v2 표준 에러 봉투 원문 — `v2ErrorCode` 가 여기서 `error.code` 를 뽑는다. */
      readonly body?: string,
    ) {
      super(message);
    }
  },
}));

vi.mock("@/lib/server/orders", () => ({
  createOrder,
  V2CommerceError: FakeV2CommerceError,
  EventAccessError: FakeEventAccessError,
}));
vi.mock("@/lib/v2/event-access", () => ({ getOwnedEvent, EventAccessError: FakeEventAccessError }));
vi.mock("@/lib/redis", () => ({
  getPrefixedRedis: () => ({
    async set(key: string, value: string, ...rest: unknown[]) {
      if (redisState.fail) throw new Error("redis down");
      const nx = rest.includes("NX");
      if (nx && redisStore.has(key)) return null; // ioredis: NX 실패는 null
      redisStore.set(key, value);
      return "OK";
    },
    async get(key: string) {
      if (redisState.fail) throw new Error("redis down");
      return redisStore.get(key) ?? null;
    },
    async del(key: string) {
      if (redisState.fail) throw new Error("redis down");
      return redisStore.delete(key) ? 1 : 0;
    },
  }),
}));

vi.mock("@/lib/v2/commerce-client", () => ({
  getEvent,
  reserveInvitation,
  invitationNextSeq,
  markInvitationIssued,
  markInvitationFailedV2,
  listEventInvitations,
  claimInvitationDispatch,
  requeueInvitationDispatch,
  completeInvitationDispatch,
  listPendingDeliveryCheck,
  reportInvitationDeliveryResult,
  markInvitationByTicketNumber: vi.fn(async () => ({ updated: 0 })),
  revokeInvitationV2,
  resendInvitationV2: vi.fn(),
  V2CommerceError: FakeV2CommerceError,
  /**
   * 🔴 실구현과 **같은 로직**으로 mock 한다. 빼면 undefined 가 되어 호출 즉시 TypeError 이고,
   *    `() => null` 로 채우면 `INVITATION_LIMIT` 종료 경로가 **영원히 검증되지 않는다.**
   *    선례: `apply-promo-route.test.ts:27-33`.
   */
  v2ErrorCode: (err: unknown): string | null => {
    if (!(err instanceof FakeV2CommerceError) || !err.body) return null;
    try {
      const parsed = JSON.parse(err.body) as { error?: { code?: unknown } };
      return typeof parsed?.error?.code === "string" ? parsed.error.code : null;
    } catch {
      return null;
    }
  },
}));
// 🔴 go DB 를 건드리면 즉시 throw — 이관 완료의 회귀 가드.
vi.mock("@/lib/db/pool", () => ({ getPool }));
vi.mock("@/lib/server/rsvp-product", () => ({ ensureCompProduct }));
vi.mock("@/lib/notification/alimtalk", async () => {
  const actual = await vi.importActual<typeof import("@/lib/notification/alimtalk")>("@/lib/notification/alimtalk");
  return { ...actual, sendAlimtalkBatch, hasAlimtalkCredentials, fetchAlimtalkDeliveryStatus };
});

import {
  invitationBatchFingerprint,
  invitationBatchKey,
} from "@/lib/server/invitation-batch-key";
import {
  bulkIssueInvitations,
  deriveDispatchIdempotencyKey,
  drainInvitationDispatch,
  reconcileInvitationDelivery,
  revokeInvitation,
} from "@/lib/server/invitations";

/**
 * 인메모리 v2 초대 원장 fake — 서버측 불변식만 재현한다.
 *  · UNIQUE(event_id, phone_normalized, **seq**) → reserve 의 created=false
 *    (2026-07-30: 1인 최대 5장 요건으로 순번이 추가됐다. 종전엔 phone 까지였다)
 *  · UNIQUE(invitation_id)              → 발송 큐 1개
 *  · claim-lease(조건부 UPDATE)          → 이중 클레임 불가 + 리스 만료 시 재클레임
 *  · send_epoch                          → 클레임 불변, 재발송에서만 +1
 */
/**
 * v2 `INVITATION_MAX_PER_PHONE` 의 **테스트 측 거울**. 정본은 v2 다.
 * 🔴 2026-08-09: 5 → **50**(발주처 요청).
 * ⚠️ go 구현 코드에는 이 숫자가 없어야 한다 — 여기 있는 이유는 페이크 v2 를 실구현과
 *    같은 로직으로 돌리기 위해서다. 테스트가 숫자를 알아야 경계를 겨눌 수 있다.
 */
const MAX_PER_PHONE = 50;

function makeLedger() {
  interface Inv {
    id: string; event_id: string; recipient_name: string; phone_normalized: string;
    phone_display: string; admission_day: string | null; admission_mode: string | null;
    ticket_number: string | null; token_version: number; status: string;
    /** 같은 번호의 몇 번째 초대권인가 — v2 UNIQUE(event,phone,seq) 를 모형화한다. */
    seq: number;
  }
  interface Disp {
    id: string; invitation_id: string; event_id: string; phone: string; recipient_name: string;
    status: string; attempt_count: number; send_epoch: number;
    claim_token: string | null; claim_expires_at: number | null;
    // v2 invitation_dispatch 실제 컬럼 — 발송 결과 추적의 유일한 근거다.
    request_id?: string | null; last_error?: string | null;
  }
  const invitations: Inv[] = [];
  const dispatch: Disp[] = [];

  /**
   * v2 `POST /invitations/reserve` 모형 — **순번(seq) 을 반영한다.**
   *
   * 🔴 종전 mock 은 `phone_normalized` 만 보고 `created=false` 를 돌려줬다. 1인 다장 요건
   *    이후로는 그 픽스처가 "빈 순번을 찾는다" 는 분기를 아예 지나가지 않아, 루프가 방어
   *    상한까지 올라가는 것만 확인하게 된다(검증 원칙 #10 — 픽스처가 결함 자리를 비껴간다).
   *
   * 계약(`internal_attendee_ledger.py:538-660`):
   *   같은 (event, phone, seq) 존재 → created=false (멱등 재생)
   *   그 순번이 **회수됨** → 부활시켜 created=true
   *   그 번호의 미회수 장수가 상한 → 409 `INVITATION_LIMIT`
   *   seq 자체가 상한 초과 → 409 `INVITATION_LIMIT` (조회·INSERT 전)
   */
  reserveInvitation.mockImplementation(async (eventId: string, _acct: string, input: {
    invitation_id: string; recipient_name: string; phone_normalized: string;
    phone_display: string; admission_day?: string | null; admission_mode?: string | null;
    seq?: number;
  }) => {
    const seq = input.seq ?? 1;
    const limitError = () =>
      new FakeV2CommerceError(
        "limit",
        409,
        JSON.stringify({
          ok: false,
          error: { code: "INVITATION_LIMIT", message: `최대 ${MAX_PER_PHONE}장`, field: "seq" },
        }),
      );

    if (seq > MAX_PER_PHONE) throw limitError();

    const prior = invitations.find(
      (i) => i.event_id === eventId && i.phone_normalized === input.phone_normalized && i.seq === seq,
    );
    if (prior) {
      // 🔴 v2 실동작(`internal_attendee_ledger` reserve)을 그대로 모형화한다.
      //    · revoked          → 되살린다(자리 재사용). token_version 은 회수 때 이미 +1 됐다.
      //    · failed + 티켓없음 → 되살린다. token_version 은 **올리지 않는다**
      //                          (failed 는 큐 미적재라 딥링크가 나간 적이 없다).
      //    · failed + 티켓있음 → 409 INVITATION_ORPHAN_TICKET (되살리면 티켓이 고아가 된다).
      if (prior.status === "failed" && prior.ticket_number !== null) {
        throw new FakeV2CommerceError(
          "발권은 됐으나 초대권 원장 반영이 실패한 행입니다",
          409,
          JSON.stringify({ error: { code: "INVITATION_ORPHAN_TICKET" } }),
        );
      }
      if (prior.status === "revoked" || prior.status === "failed") {
        prior.status = "issued";
        prior.ticket_number = null;
        prior.recipient_name = input.recipient_name;
        prior.admission_day = input.admission_day ?? null;
        return { created: true, invitation: prior };
      }
      return { created: false, invitation: prior };
    }

    const active = invitations.filter(
      (i) =>
        i.event_id === eventId &&
        i.phone_normalized === input.phone_normalized &&
        i.status !== "revoked",
    ).length;
    if (active >= MAX_PER_PHONE) throw limitError();

    const row: Inv = {
      id: input.invitation_id, event_id: eventId, recipient_name: input.recipient_name,
      phone_normalized: input.phone_normalized, phone_display: input.phone_display,
      admission_day: input.admission_day ?? null, admission_mode: input.admission_mode ?? null,
      ticket_number: null, token_version: 0, status: "issued", seq,
    };
    invitations.push(row);
    return { created: true, invitation: row };
  });

  markInvitationIssued.mockImplementation(async (invId: string, _acct: string, tn: string | null) => {
    const inv = invitations.find((i) => i.id === invId);
    if (inv) inv.ticket_number = tn;
    if (!dispatch.some((d) => d.invitation_id === invId)) {
      dispatch.push({
        id: `disp-${invId}`, invitation_id: invId, event_id: inv!.event_id,
        phone: inv!.phone_display, recipient_name: inv!.recipient_name,
        status: "queued", attempt_count: 0, send_epoch: 0,
        claim_token: null, claim_expires_at: null,
      });
      return { invitation: inv, queued: true };
    }
    return { invitation: inv, queued: false };
  });

  markInvitationFailedV2.mockImplementation(async (invId: string) => {
    const inv = invitations.find((i) => i.id === invId);
    if (inv) inv.status = "failed";
    return { invitation: inv };
  });

  listEventInvitations.mockImplementation(async (eventId: string) => {
    const rows = invitations.filter((i) => i.event_id === eventId);
    return {
      invitations: rows,
      summary: {},
      active_count: rows.filter((i) => i.status !== "revoked").length,
    };
  });

  claimInvitationDispatch.mockImplementation(async (input: {
    claim_token: string; limit?: number; lease_minutes?: number;
  }) => {
    const now = Date.now();
    const claimable = dispatch.filter(
      (d) => d.status === "queued" ||
        (d.status === "sending" && (d.claim_expires_at === null || d.claim_expires_at < now)),
    );
    const claimed = claimable.slice(0, input.limit ?? 100);
    for (const d of claimed) {
      d.status = "sending";
      d.claim_token = input.claim_token;
      d.claim_expires_at = now + (input.lease_minutes ?? 5) * 60_000;
      d.attempt_count += 1;
    }
    return {
      items: claimed.map((d) => {
        const inv = invitations.find((i) => i.id === d.invitation_id)!;
        return {
          dispatch_id: d.id, invitation_id: d.invitation_id, event_id: d.event_id,
          phone: d.phone, recipient_name: d.recipient_name,
          send_epoch: d.send_epoch, attempt_count: d.attempt_count,
          ticket_number: inv.ticket_number, admission_day: inv.admission_day,
          token_version: inv.token_version, invitation_status: inv.status,
        };
      }),
    };
  });

  requeueInvitationDispatch.mockImplementation(async (input: { claim_token: string; dispatch_ids: string[] }) => {
    let n = 0;
    for (const d of dispatch) {
      if (input.dispatch_ids.includes(d.id) && d.claim_token === input.claim_token) {
        d.status = "queued"; d.claim_token = null; d.claim_expires_at = null; n += 1;
      }
    }
    return { requeued: n };
  });

  completeInvitationDispatch.mockImplementation(async (input: {
    claim_token: string; dispatch_ids: string[]; invitation_ids: string[];
    sent: boolean; request_id?: string | null; error?: string | null;
  }) => {
    let n = 0;
    for (const d of dispatch) {
      if (input.dispatch_ids.includes(d.id) && d.claim_token === input.claim_token) {
        d.status = input.sent ? "sent" : "failed"; n += 1;
        // 실제 v2(complete_dispatch)는 request_id·last_error 를 저장한다. 가짜가 이걸
        // 버리면 "사유가 원장에 남는가" 를 테스트가 검증할 수 없다.
        d.request_id = input.request_id ?? null;
        d.last_error = input.sent ? null : (input.error ?? "알림톡 배치 발송 실패");
      }
    }
    for (const i of invitations) {
      if (input.invitation_ids.includes(i.id) && i.status === "issued") {
        i.status = input.sent ? "sent" : "failed";
      }
    }
    return { updated: n };
  });

  return {
    invitations,
    dispatch,
    /** 리스 강제 만료 — 발송 직후 워커가 죽어 결과를 못 남긴 상황 재현. */
    expireLeases() {
      for (const d of dispatch) d.claim_expires_at = Date.now() - 1;
    },
    /** 주최자의 명시적 재발송(v2 resend 와 동일 의미). */
    resend(invId: string) {
      const inv = invitations.find((i) => i.id === invId)!;
      inv.status = "issued";
      const d = dispatch.find((x) => x.invitation_id === invId)!;
      d.status = "queued"; d.claim_token = null; d.claim_expires_at = null;
      d.send_epoch += 1;
    },
  };
}

/** v2 이벤트 상세(EventDetail 부분) — 제목/장소/기간·comp 캡의 정본. */
function v2Event(over: Record<string, unknown> = {}) {
  return {
    event_id: "ev-1",
    title: "테스트 대회",
    venue: "테스트 경기장",
    event_date: "2026-08-20T00:00:00Z",
    event_date_end: "2026-08-23T00:00:00Z",
    comp_capacity_cap: null,
    ...over,
  };
}

let ledger: ReturnType<typeof makeLedger>;

beforeEach(() => {
  vi.clearAllMocks();
  redisStore.clear();
  redisState.fail = false;
  ledger = makeLedger();
  /**
   * 🔴 출발 순번 프리페치 — v2 와 **같은 규칙**으로 답한다 (2026-08-09).
   *    회수분은 빈 자리로 센다(reserve 의 부활 분기와 짝). 페이크가 이 규칙을 어기면
   *    힌트가 자리를 건너뛰는 결함을 테스트가 못 잡는다.
   */
  invitationNextSeq.mockImplementation(async (_e: string, _a: string, phones: string[]) => {
    const next: Record<string, number> = {};
    const atLimit: string[] = [];
    for (const phone of [...new Set(phones)]) {
      // 🔴 v2 와 같은 **보수적** 규칙 — 되살아날 수 있는 상태는 빈 자리로 센다.
      //    (낮은 힌트는 왕복 몇 번, 높은 힌트는 중복 발급이다.)
      const taken = new Set(
        ledger.invitations
          .filter((i) => i.phone_normalized === phone
            && i.status !== "revoked" && i.status !== "failed")
          .map((i) => i.seq),
      );
      let free: number | null = null;
      for (let n = 1; n <= MAX_PER_PHONE; n += 1) {
        if (!taken.has(n)) { free = n; break; }
      }
      if (free === null) { atLimit.push(phone); next[phone] = MAX_PER_PHONE + 1; }
      else next[phone] = free;
    }
    return { next, at_limit: atLimit };
  });
  ensureCompProduct.mockResolvedValue({ productId: "comp-product-1" });
  getOwnedEvent.mockResolvedValue(v2Event());
  getEvent.mockResolvedValue(v2Event());
  let seq = 0;
  /**
   * 🔴 v2 의 **멱등 계약을 모형화**한다 (2026-07-31 실사고 후 보강).
   *
   * 종전 목은 호출할 때마다 새 주문을 돌려줬다 — 그래서 "회수→재발급" 테스트가 **초록인데
   * prod 는 409 IDEMPOTENCY_KEY_MISMATCH** 로 실패했다. 목이 검증한 것은 v2 의 동작이 아니라
   * 내가 v2 라고 믿은 것이었다.
   *
   * 실제 v2(`internal_commerce._assert_order_replay_owner`):
   *   · 같은 `external_order_id` 재사용 → 기존 주문을 **재생**하려 한다
   *   · 재생 전에 **저장된 게스트 이메일과 요청 이메일을 대조** → 다르면 409 MISMATCH
   * ⟹ 멱등키가 같은데 이메일이 매번 달라지면(옛 코드의 `Date.now()`) 정당한 재시도도 막힌다.
   * ⟹ 부활은 같은 invitation id 를 되살리므로, 키에 세대(`token_version`)가 없으면
   *    회수된 옛 주문을 재생하려다 막힌다.
   */
  const placedOrders = new Map<string, { buyerEmail: string; result: Record<string, unknown> }>();
  createOrder.mockImplementation(async (input: { idempotencyToken?: string; buyerEmail?: string }) => {
    const token = input.idempotencyToken ?? "";
    const prior = placedOrders.get(token);
    if (prior) {
      if (prior.buyerEmail !== input.buyerEmail) {
        throw new FakeV2CommerceError(
          "동일한 주문 식별자가 다른 구매자 정보로 재사용되었습니다",
          409,
          JSON.stringify({ error: { code: "IDEMPOTENCY_KEY_MISMATCH" } }),
        );
      }
      return prior.result; // 같은 키 + 같은 구매자 → 옛 주문 재생(새 티켓 아님)
    }
    const n = ++seq;
    const result = {
      id: `order-${n}`, orderNumber: `ORD${n}`, ticketIds: [`t-${n}`],
      ticketNumbers: [`TKT-order-${n}`],
      v2OrderId: "v2", totalAmount: 0, paidAmount: 0, raffleNumbers: {},
    };
    placedOrders.set(token, { buyerEmail: input.buyerEmail ?? "", result });
    return result;
  });
  // 실제 SENS 응답과 같은 형태로 — **수신자별 접수 결과**를 함께 돌려준다.
  // 이 필드가 없던 옛 픽스처가 "부분 실패를 성공으로 기록" 하는 결함을 못 잡았다.
  sendAlimtalkBatch.mockImplementation(async (_tpl: string, items: Array<{ to: string }>) => ({
    requestId: "req-1",
    count: items.length,
    results: items.map((i) => ({ to: i.to.replace(/[^0-9]/g, ""), ok: true, code: "A000", desc: "성공" })),
  }));
  hasAlimtalkCredentials.mockReturnValue(false);
});

import type { BulkRecipientInput } from "@/lib/server/invitations";

const RECIPIENT: BulkRecipientInput = { name: "홍길동", phone: "010-1111-2222" };

function bulk(recipients: BulkRecipientInput[] = [RECIPIENT], eventId = "ev-1", force?: boolean) {
  return bulkIssueInvitations({ accountId: "acc-1", eventId, recipients, force });
}

describe("bulkIssueInvitations — 대량 초대권 발권", () => {
  it("동기 발송 왕복 없이 발권+큐적재만 한다(NCP 미호출)", async () => {
    const res = await bulk();
    expect(res.issued).toBe(1);
    expect(sendAlimtalkBatch).not.toHaveBeenCalled(); // 발송은 cron 이 — bulk 은 큐적재만.
    expect(ledger.dispatch).toHaveLength(1);
    expect(ledger.dispatch[0].status).toBe("queued");
    expect(getPool).not.toHaveBeenCalled(); // go DB 미접근(이관 완료의 물증)
  });

  /**
   * ══ 1인 다장 발급 (2026-07-30, 대회 요건) ══
   *
   * 🔴 종전 이 자리에 정반대 단언이 있었다 — "CSV 내부 중복은 1건만 발권한다(dedup)",
   *    "재업로드는 스킵한다", "같은 명단 2회 = 1장". phone 중복제거를 없앤 것이 이 변경의
   *    실제 관문이었고, 그 테스트들이 요건과 정면으로 반대였다.
   *    재업로드 방어는 dedup 이 아니라 **배치 멱등키**가 맡는다(아래 별도 describe).
   */
  it("🔴 같은 번호를 여러 줄 넣으면 그만큼 발급한다 — 순번이 1부터 올라간다", async () => {
    const res = await bulk([
      { name: "홍길동", phone: "010-1111-2222" },
      { name: "홍길동", phone: "01011112222" },   // 정규화 시 동일 — 종전엔 버려졌다.
      { name: "홍길동", phone: "010 1111 2222" },
    ]);
    expect(res.issued).toBe(3);
    expect(createOrder).toHaveBeenCalledTimes(3);
    expect(ledger.invitations.map((i) => i.seq)).toEqual([1, 2, 3]);
    expect(ledger.dispatch).toHaveLength(3); // 3통이 큐에 적재된다
  });

  /**
   * 🔴 메인세션 지적(§5-8): `nextSeq` Map 키가 번호별로 독립인지.
   *    키가 잘못되면 다른 번호의 순번을 이어써 **엉뚱한 seq 로 발급**되는데,
   *    같은 번호만 넣는 테스트와 다른 번호만 넣는 테스트로는 **둘 다 통과**한다.
   *    섞어야 드러난다 — 내 기존 테스트가 정확히 그 상태였다.
   */
  it("🔴 번호가 섞인 배치에서 순번이 번호별로 독립이다", async () => {
    const res = await bulk([
      { name: "홍길동", phone: "010-1111-2222" },
      { name: "김철수", phone: "010-3333-4444" },
      { name: "홍길동", phone: "010-1111-2222" },
      { name: "김철수", phone: "010-3333-4444" },
      { name: "홍길동", phone: "010-1111-2222" },
    ]);
    expect(res.issued).toBe(5);

    const byPhone = (p: string) =>
      ledger.invitations.filter((i) => i.phone_normalized === p).map((i) => i.seq).sort();
    expect(byPhone("01011112222")).toEqual([1, 2, 3]);
    expect(byPhone("01033334444")).toEqual([1, 2]); // 홍길동 순번을 이어쓰면 [4,5] 가 된다
  });

  /**
   * 🔴 상한 5 → 50 (2026-08-09). 이 테스트가 **X2 를 잡는 자리**다.
   *
   * `SEQ_LOOP_GUARD` 는 업무 규칙이 아니라 폭주 방어선인데, 상한보다 작으면
   * **거기서 조용히 멈춘다** — 상한만 올리고 가드를 두면 20장에서 잘린다.
   */
  it("🔴 한 번호에 50장을 요청하면 50장 다 발급된다 (루프 가드에 안 잘린다)", async () => {
    const rows = Array.from({ length: MAX_PER_PHONE }, () => ({
      name: "홍길동", phone: "010-1111-2222",
    }));
    const res = await bulk(rows);
    expect(res.issued, "🔴 루프 가드가 상한보다 작아 잘렸다").toBe(MAX_PER_PHONE);
    expect(res.atLimit).toBe(0);
    const seqs = ledger.invitations.map((i) => i.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: MAX_PER_PHONE }, (_, i) => i + 1));
  });

  /**
   * 🔴 왕복 축소 (X4) — 이미 자리가 찬 번호에 1장 더 넣을 때.
   *
   * 프리페치가 없으면 seq 1..40 을 전부 두드리고 41 에서 성공한다(41회). 있으면 1회다.
   * bulk 상한이 10,000명이라 이 차이가 **50만 회 대 1만 회**가 된다.
   */
  it("🔴 이미 40장인 번호에 1장 더 — 왕복이 **1회**다", async () => {
    const phone = "010-1111-2222";
    await bulk(Array.from({ length: 40 }, () => ({ name: "홍길동", phone })));
    redisStore.clear();               // 배치 멱등 캐시를 비워 재처리시킨다
    reserveInvitation.mockClear();

    const res = await bulk([{ name: "홍길동", phone }]);
    expect(res.issued).toBe(1);
    expect(ledger.invitations).toHaveLength(41);
    // ⚠️ "빨라졌다" 가 아니라 **횟수**를 센다 — 프리페치를 지우면 41 이 된다.
    expect(reserveInvitation).toHaveBeenCalledTimes(1);
  });

  /**
   * 🔴 X5 — 재업로드 멱등의 **진짜 경계**가 어디인지 고정한다.
   *
   * ⚠️ 지시서는 *"재업로드 멱등의 열쇠는 클라가 준 seq — 같은 (event,phone,seq) 면
   *    created=false 로 호출자가 스킵한다"* 라고 했다. **실측 결과 그렇지 않다.**
   *    go 의 루프는 `created=false` 를 "이 자리는 찼다" 로 읽고 `seq += 1` 해서
   *    **다음 자리에 새로 발급**한다(:479 부근). 스킵 분기가 없다.
   *
   * ⟹ 재업로드를 막는 것은 **배치 지문 하나뿐**이고, 그건 명단이 **완전히 같을 때만**
   *    작동한다. 한 명만 추가하면 지문이 바뀌어 **전원에게 한 장씩 더** 나간다.
   *
   * 🔴 이 성질은 상한 5 → 50 으로 **더 커진다**(같은 실수의 상한이 5장에서 50장으로).
   *    다만 이번 변경이 만든 것은 아니다 — 프리페치를 꺼도 결과가 같은 것으로 확인했다.
   *    고치려면 "이 번호에 이미 N장 있으면 추가 발급하지 않는다" 같은 **요구 정의**가
   *    먼저 필요하다(의도적 다장 발급과 구분할 수 없다). 범위 밖으로 보고한다.
   */
  it("🔴 한 명 추가해 재업로드하면 기존 인원에게도 한 장 더 나간다 (현행 동작 고정)", async () => {
    const first = await bulk([
      { name: "홍길동", phone: "010-1111-2222" },
      { name: "김철수", phone: "010-3333-4444" },
    ]);
    expect(first.issued).toBe(2);

    // 한 명 추가 → 지문이 바뀌어 배치 캐시가 안 걸린다(전원 재처리)
    const again = await bulk([
      { name: "홍길동", phone: "010-1111-2222" },
      { name: "김철수", phone: "010-3333-4444" },
      { name: "이영희", phone: "010-5555-6666" },
    ]);
    expect(again.replayed).toBeUndefined();
    // 🔴 현행: 3장이 더 나간다(기존 2명 + 신규 1명). 이 수가 1 로 바뀌면 요구가 바뀐 것이다.
    expect(again.issued).toBe(3);
    const byPhone = (p: string) =>
      ledger.invitations.filter((i) => i.phone_normalized === p).map((i) => i.seq).sort();
    expect(byPhone("01011112222")).toEqual([1, 2]);
    expect(byPhone("01033334444")).toEqual([1, 2]);
    expect(byPhone("01055556666")).toEqual([1]);
  });

  it("🔴 **똑같은** 명단 재업로드는 배치 지문이 막는다 — 유일하게 작동하는 방어", async () => {
    const rows = [
      { name: "홍길동", phone: "010-1111-2222" },
      { name: "김철수", phone: "010-3333-4444" },
    ];
    expect((await bulk(rows)).issued).toBe(2);
    const again = await bulk(rows);
    expect(again.replayed).toBe(true);
    expect(ledger.invitations).toHaveLength(2);
  });

  it("🔴 이미 꽉 찬 번호는 **한 번도** 두드리지 않는다 (at_limit 소비)", async () => {
    const phone = "010-1111-2222";
    await bulk(Array.from({ length: MAX_PER_PHONE }, () => ({ name: "홍길동", phone })));
    redisStore.clear();
    reserveInvitation.mockClear();

    const res = await bulk([{ name: "홍길동", phone }]);
    expect(res.issued).toBe(0);
    expect(res.atLimit).toBe(1);
    // ⚠️ at_limit 을 무시하면 51 부터 가드(60)까지 헛되이 왕복한다 — 횟수를 센다.
    expect(reserveInvitation).toHaveBeenCalledTimes(0);
  });

  it("🔴 프리페치가 실패해도 발권은 진행된다 — 최적화가 장애가 되면 안 된다", async () => {
    invitationNextSeq.mockRejectedValueOnce(new Error("v2 일시 장애"));
    const res = await bulk([{ name: "홍길동", phone: "010-1111-2222" }]);
    expect(res.issued).toBe(1);
    expect(ledger.invitations).toHaveLength(1);
  });

  it("🔴 상한을 넘긴 줄은 atLimit 으로 집계한다 — 숫자는 v2 가 판정한다", async () => {
    const rows = Array.from({ length: MAX_PER_PHONE + 2 }, () => ({
      name: "홍길동", phone: "010-1111-2222",
    }));
    const res = await bulk(rows);
    expect(res.issued).toBe(MAX_PER_PHONE);   // v2 INVITATION_MAX_PER_PHONE
    expect(res.atLimit).toBe(2);
    expect(res.failed).toBe(0);   // 상한은 실패가 아니다 — 정상 안내 대상
    // 상한을 한 번 확인했으면 남은 줄은 **왕복 없이** 집계한다(MAX장 + 상한확인 1회).
    expect(reserveInvitation).toHaveBeenCalledTimes(MAX_PER_PHONE + 1);
  });

  it("🔴 상한 판정은 error.code 로 한다 — 같은 409 의 CONFLICT 는 실패로 남는다", async () => {
    reserveInvitation.mockRejectedValue(
      new FakeV2CommerceError("conflict", 409, JSON.stringify({
        ok: false, error: { code: "CONFLICT", message: "invitation conflict" },
      })),
    );
    const res = await bulk();
    expect(res.atLimit).toBe(0); // 상한으로 오인하면 조용히 미발급이 된다
    expect(res.failed).toBe(1);
    expect(createOrder).not.toHaveBeenCalled();
  });

  /**
   * 🔴 실제 회수를 흉내낸다 — v2 `revoke_invitation` 은 `token_version` 을 **+1** 한다
   *    (기 발송 링크 무효화). 이 증가를 빼먹은 옛 픽스처 때문에 아래 테스트가 초록인데도
   *    prod 는 409 로 실패했다.
   */
  function revokeInLedger(idx: number) {
    ledger.invitations[idx].status = "revoked";
    ledger.invitations[idx].token_version += 1;
    ledger.invitations[idx].ticket_number = null;
  }

  it("회수된 순번은 v2 가 부활시킨다 — 재업로드하면 **새** 티켓이 나간다", async () => {
    await bulk();
    const firstTicket = ledger.invitations[0].ticket_number;
    expect(firstTicket).toBeTruthy();

    revokeInLedger(0);
    redisStore.clear();                       // 다른 배치로 취급(멱등키는 별도 테스트)
    const again = await bulk();

    expect(again.issued).toBe(1);
    expect(again.atLimit).toBe(0);
    expect(again.failed).toBe(0);             // 🔴 409 로 죽으면 여기가 1 이 된다(prod 실사고)
    expect(ledger.invitations).toHaveLength(1); // 새 행이 아니라 그 순번이 되살아난다
    expect(ledger.invitations[0].status).toBe("issued");
    // 🔴 옛 주문이 **재생**되면 티켓번호가 그대로다 = 회수돼 죽은 티켓을 다시 보내는 것.
    expect(ledger.invitations[0].ticket_number).not.toBe(firstTicket);
  });

  /**
   * 🔴 발권은 됐는데 원장 기록이 실패한 뒤 재업로드 — **옛 주문을 재생**해야 한다.
   *
   * 이 경로가 `buyerEmail` 을 결정적으로 만들어야 하는 이유다. v2 는 재생 전에
   * **저장된 게스트 이메일과 요청 이메일을 대조**하므로(`_assert_order_replay_owner`),
   * 이메일에 `Date.now()` 가 들어 있으면 정당한 재시도가 409 로 막힌다.
   * (2026-07-31 prod 실사고와 같은 계열 — 그때는 회수 후 재발급이었다.)
   */
  /**
   * 🔴 전건 실패한 배치는 **캐시하지 않는다** (2026-07-31 prod 실사고).
   *
   * 종전엔 결과를 무조건 7일 보관했다. 발권이 전부 실패한 배치도 저장돼서, 원인을 고쳐
   * 배포해도 **같은 명단은 7일간 재시도가 막혔다**("이미 처리한 명단입니다 · 앞서 0장 발급됨").
   * 이 캐시의 목적은 중복 발송 방지 하나뿐인데, 나간 게 없으면 막을 중복도 없다.
   */
  it("🔴 전건 실패는 캐시하지 않는다 — 고친 뒤 곧바로 재시도할 수 있어야 한다", async () => {
    reserveInvitation.mockRejectedValueOnce(new Error("일시 장애"));
    const first = await bulk();
    expect(first.issued).toBe(0);
    expect(first.failed).toBe(1);

    // 🔴 재업로드가 저장된 실패 결과를 재생하면 안 된다(redisStore 를 비우지 않는다).
    const again = await bulk();
    expect(again.replayed).toBeUndefined();
    expect(again.issued).toBe(1);
  });

  it("일부라도 발급됐으면 캐시한다 — 재업로드가 성공분을 두 번 보내면 안 된다", async () => {
    const res = await bulk();
    expect(res.issued).toBe(1);
    const again = await bulk();
    expect(again.replayed).toBe(true);   // 저장된 결과 재생
    expect(ledger.invitations).toHaveLength(1);
  });

  it("🔴 원장 기록 실패 후 재업로드 — 409 없이 옛 주문이 재생된다", async () => {
    /**
     * 🔴 시각을 **고정하고 벌린다**. 안 하면 두 시도가 같은 밀리초에 일어나
     * `Date.now()` 기반 이메일도 우연히 같아져 **결함이 무해해 보인다**
     * (실제로 이 테스트가 실행할 때마다 통과/실패를 오갔다 — 2026-07-31).
     * prod 의 재시도는 분 단위로 벌어져 있다.
     */
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    markInvitationIssued.mockRejectedValueOnce(new Error("원장 기록 실패"));
    const first = await bulk();
    expect(first.failed).toBe(1);
    expect(ledger.invitations[0].status).toBe("failed");
    expect(ledger.invitations[0].ticket_number).toBeNull(); // 기록 실패라 티켓번호가 안 붙었다

    redisStore.clear();
    nowSpy.mockReturnValue(1_700_000_060_000); // 60초 뒤 재시도
    const again = await bulk();
    nowSpy.mockRestore();

    expect(again.failed).toBe(0);   // 🔴 이메일이 매번 달라지면 여기서 409 로 죽는다
    expect(again.issued).toBe(1);
    expect(ledger.invitations).toHaveLength(1);
    expect(ledger.invitations[0].status).toBe("issued");
  });

  it("🔴 같은 세대의 재시도는 옛 주문을 재생한다 — 중복 발권이 아니다", async () => {
    await bulk();
    const ticket = ledger.invitations[0].ticket_number;
    redisStore.clear();                       // 배치 멱등을 지나쳐 발권 경로까지 도달시킨다
    const again = await bulk();
    // 회수하지 않았으므로 순번이 점유된 상태 → 2번째 순번으로 새로 나간다.
    // 핵심은 **409 로 죽지 않는다**는 것(옛 코드는 Date.now() 때문에 여기서 깨졌다).
    expect(again.failed).toBe(0);
    expect(ledger.invitations[0].ticket_number).toBe(ticket); // 1번 순번은 건드리지 않는다
  });

  it("전화번호가 없는 줄은 invalid 로 집계하고 발권하지 않는다", async () => {
    const res = await bulk([
      { name: "정상", phone: "010-1111-2222" },
      { name: "번호없음", phone: "" },
      { name: "문자만", phone: "없음" },
    ]);
    expect(res.issued).toBe(1);
    expect(res.invalid).toBe(2);
    expect(createOrder).toHaveBeenCalledTimes(1);
  });

  it("용량 캡 초과분은 차단한다", async () => {
    getOwnedEvent.mockResolvedValue(v2Event({ comp_capacity_cap: 2 }));
    const res = await bulk([
      { name: "A", phone: "010-0000-0001" },
      { name: "B", phone: "010-0000-0002" },
      { name: "C", phone: "010-0000-0003" }, // 캡(2) 초과 — 차단.
    ]);
    expect(res.issued).toBe(2);
    expect(res.capExceeded).toBe(true);
  });

  /**
   * ══ 배치 멱등 — 같은 파일 재업로드 방어 ══
   *
   * 🔴 phone 중복제거를 없앤 대가로 "같은 파일 두 번" 방어가 사라졌다. 붙여넣기 실수는
   *    한 사람이지만 파일 재업로드는 **명단 전체**이고 알림톡은 회수할 수 없다.
   *    5장 상한은 사고 크기만 줄인다 — 4번 올리면 상한에 도달한다.
   */
  describe("배치 멱등", () => {
    it("🔴 같은 명단을 두 번 올리면 저장된 결과를 재사용한다 — 추가 발급 없음", async () => {
      const rows = [{ name: "홍길동", phone: "010-1111-2222" }];
      const first = await bulk(rows);
      const second = await bulk(rows);

      expect(first.issued).toBe(1);
      expect(first.replayed).toBeUndefined();
      expect(second.issued).toBe(1);        // 결과를 그대로 되돌려준다
      expect(second.replayed).toBe(true);
      expect(ledger.invitations).toHaveLength(1); // **2장이 되지 않는다**
      expect(createOrder).toHaveBeenCalledTimes(1);
      expect(ledger.dispatch).toHaveLength(1);    // 알림톡도 1통
    });

    it("🔴 이름만 고쳐 다시 올려도 재사용한다 — 오타 수정이 전체 이중발송이 되면 안 된다", async () => {
      await bulk([{ name: "홍길동", phone: "010-1111-2222" }]);
      const second = await bulk([{ name: "홍길똥(오타수정)", phone: "010-1111-2222" }]);
      expect(second.replayed).toBe(true);
      expect(ledger.invitations).toHaveLength(1);
    });

    it("한 명이라도 늘면 새 배치로 처리한다", async () => {
      await bulk([{ name: "A", phone: "010-0000-0001" }]);
      const second = await bulk([
        { name: "A", phone: "010-0000-0001" },
        { name: "B", phone: "010-0000-0002" },
      ]);
      expect(second.replayed).toBeUndefined();
      expect(second.issued).toBe(2); // A 는 seq=2 로, B 는 seq=1 로
    });

    it("엑셀 정렬만 바꿔 올린 것은 같은 배치다", async () => {
      await bulk([
        { name: "A", phone: "010-0000-0001" },
        { name: "B", phone: "010-0000-0002" },
      ]);
      const second = await bulk([
        { name: "B", phone: "010-0000-0002" },
        { name: "A", phone: "010-0000-0001" },
      ]);
      expect(second.replayed).toBe(true);
      expect(ledger.invitations).toHaveLength(2);
    });

    it("🔴 같은 명단이 처리 중이면(동시 클릭) 추가 발급하지 않는다", async () => {
      const rows = [{ name: "홍길동", phone: "010-1111-2222" }];
      // 앞선 요청이 클레임만 잡고 아직 끝나지 않은 상태를 재현한다.
      const fp = invitationBatchFingerprint("ev-1", [{ phoneNormalized: "01011112222" }]);
      redisStore.set(invitationBatchKey("ev-1", fp), "processing");

      const res = await bulk(rows);
      expect(res.inProgress).toBe(true);
      expect(res.issued).toBe(0);
      expect(createOrder).not.toHaveBeenCalled();
    });

    it("🔴 Redis 장애면 발권을 거부한다(fail-closed) — 2차 방어가 없다", async () => {
      redisState.fail = true;
      const res = await bulk([{ name: "홍길동", phone: "010-1111-2222" }]);
      expect(res.issued).toBe(0);
      expect(res.failed).toBe(1);
      expect(res.failures[0]?.reason).toContain("잠시 후 재시도");
      expect(createOrder).not.toHaveBeenCalled();
    });

    /**
     * ══ 명시 해제 (2026-07-31 실사고) ══
     *
     * 이 캐시는 Redis 에 7일 남는데 **지우는 코드가 어디에도 없었다.** 테스트 데이터를
     * DB 에서 전부 지운 뒤 같은 명단을 올리자 "이미 처리한 명단" 만 나오고 손쓸 방법이
     * 없었다. 멱등 자체는 지키되(중복발송 방어) 사람이 명시적으로 풀 수 있어야 한다.
     */
    describe("멱등 명시 해제(force)", () => {
      it("🔴 force 면 저장된 결과를 버리고 다시 발급한다", async () => {
        const rows = [{ name: "홍길동", phone: "010-1111-2222" }];
        await bulk(rows);
        expect(ledger.invitations).toHaveLength(1);

        const forced = await bulk(rows, "ev-1", true);
        expect(forced.replayed).toBeUndefined();   // 재사용이 아니라 실제 발급
        expect(forced.issued).toBe(1);
        expect(ledger.invitations).toHaveLength(2); // **한 장 더 나간다** — 의도된 것
      });

      it("force 없이는 여전히 막힌다 — 기본값이 안전이어야 한다", async () => {
        const rows = [{ name: "홍길동", phone: "010-1111-2222" }];
        await bulk(rows);
        const again = await bulk(rows);
        expect(again.replayed).toBe(true);
        expect(ledger.invitations).toHaveLength(1);
      });

      it("🔴 막혔을 때 지문을 응답에 실어 준다 — 어느 명단인지 특정할 수 있어야 한다", async () => {
        const rows = [{ name: "홍길동", phone: "010-1111-2222" }];
        const first = await bulk(rows);
        const second = await bulk(rows);

        const fp = invitationBatchFingerprint("ev-1", [{ phoneNormalized: "01011112222" }]);
        expect(second.replayed).toBe(true);
        expect(second.batchFingerprint).toBe(fp);
        expect(first.batchFingerprint).toBe(fp); // 성공 응답에도 실린다(감사로그용)
      });

      it("처리 중(동시 클릭)에도 지문을 준다", async () => {
        const fp = invitationBatchFingerprint("ev-1", [{ phoneNormalized: "01011112222" }]);
        redisStore.set(invitationBatchKey("ev-1", fp), "processing");
        const res = await bulk([{ name: "홍길동", phone: "010-1111-2222" }]);
        expect(res.inProgress).toBe(true);
        expect(res.batchFingerprint).toBe(fp);
      });

      it("🔴 force 는 **그 배치의 키만** 지운다 — 다른 명단의 멱등은 살아 있어야 한다", async () => {
        const a = [{ name: "A", phone: "010-0000-0001" }];
        const b = [{ name: "B", phone: "010-0000-0002" }];
        await bulk(a);
        await bulk(b);
        expect(ledger.invitations).toHaveLength(2);

        await bulk(a, "ev-1", true);          // A 만 강제 재발송
        expect(ledger.invitations).toHaveLength(3);

        const bAgain = await bulk(b);          // B 는 여전히 막혀야 한다
        expect(bAgain.replayed).toBe(true);
        expect(ledger.invitations).toHaveLength(3);
      });

      it("막혀 있지 않은 명단에 force 를 써도 정상 발급된다(해제할 것이 없을 뿐)", async () => {
        const res = await bulk([{ name: "신규", phone: "010-3333-4444" }], "ev-1", true);
        expect(res.issued).toBe(1);
        expect(res.replayed).toBeUndefined();
      });
    });
  });

  it("타테넌트/이벤트 부재는 발권하지 않고 실패 처리한다(account 경계)", async () => {
    getOwnedEvent.mockResolvedValue(null);
    const res = await bulk([{ name: "X", phone: "010-9999-8888" }], "ev-missing");
    expect(res.issued).toBe(0);
    expect(res.failed).toBe(1);
    expect(res.failures[0]?.reason).toBe("이벤트를 찾을 수 없습니다");
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("v2 장애는 '이벤트 없음'으로 위장하지 않는다(재시도 안내 문구로 분리)", async () => {
    getOwnedEvent.mockRejectedValue(new FakeEventAccessError("down", "unavailable", 502));
    const res = await bulk([{ name: "X", phone: "010-9999-8888" }]);
    expect(res.issued).toBe(0);
    expect(res.failed).toBe(1);
    expect(res.failures[0]?.reason).toContain("잠시 후 재시도");
    expect(res.failures[0]?.reason).not.toContain("찾을 수 없습니다");
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("🔴 발급 현황 조회 실패를 0 으로 강등하지 않는다(캡 무력화·초과발권 차단)", async () => {
    listEventInvitations.mockRejectedValue(new FakeV2CommerceError("down", 503));
    const res = await bulk([{ name: "X", phone: "010-9999-8888" }]);
    expect(res.issued).toBe(0);
    expect(res.failed).toBe(1);
    expect(res.failures[0]?.reason).toContain("잠시 후 재시도");
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("🔴 예약 실패를 '스킵'으로 흘리지 않는다(조용한 미발송 금지)", async () => {
    reserveInvitation.mockRejectedValue(new FakeV2CommerceError("down", 503));
    const res = await bulk();
    expect(res.atLimit).toBe(0);
    expect(res.failed).toBe(1);
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("티켓번호는 createOrder 반환값에서 온다(발송 레이스 제거)", async () => {
    await bulk();
    expect(ledger.invitations[0].ticket_number).toBe("TKT-order-1");
  });
});

describe("drainInvitationDispatch — 발송 큐 드레인(멱등)", () => {
  it("queued 를 claim 해 발송하고 원장을 sent 로 전이(dev stub)", async () => {
    await bulk();
    const res = await drainInvitationDispatch();
    expect(res.claimed).toBe(1);
    expect(res.sent).toBe(1);
    expect(sendAlimtalkBatch).not.toHaveBeenCalled(); // 자격 미설정 → stub.
    expect(ledger.dispatch[0].status).toBe("sent");
    expect(ledger.invitations[0].status).toBe("sent");
  });

  it("자격 완비 시 NCP 배치 발송을 호출한다", async () => {
    hasAlimtalkCredentials.mockReturnValue(true);
    await bulk();
    await drainInvitationDispatch();
    expect(sendAlimtalkBatch).toHaveBeenCalledTimes(1);
    const [templateCode, items] = sendAlimtalkBatch.mock.calls[0];
    expect(templateCode).toBe("PICKKETINVITE001");
    expect(items).toHaveLength(1);
    // 딥링크는 '모바일 티켓' 웹링크 버튼으로 전달(본문 인라인 URL 아님 — 검수 반려 대응).
    expect(items[0].buttons?.[0]?.name).toBe("모바일 티켓");
    expect(items[0].buttons?.[0]?.linkMobile).toContain("?t=");
    // 승인 문안(발신주체 + 수신맥락)이 본문에 포함.
    expect(String(items[0].content)).toContain("고객님께서 요청하신");
  });

  it("두 번째 드레인은 이미 sent 라 재발송하지 않는다(claim 소진)", async () => {
    await bulk();
    const first = await drainInvitationDispatch();
    const second = await drainInvitationDispatch();
    expect(first.claimed).toBe(1);
    expect(second.claimed).toBe(0); // queued 없음 → 이중발송 없음.
  });

  it("🔴 발송 후 crash 재시도는 **같은 멱등키** 로 나간다(알림톡 2통 방지)", async () => {
    hasAlimtalkCredentials.mockReturnValue(true);
    await bulk();

    // 1차 드레인 — NCP 발송까지 성공.
    await drainInvitationDispatch();
    const firstKey = sendAlimtalkBatch.mock.calls[0][2]?.idempotencyKey;

    // 결과 반영 전 워커가 죽었다고 가정: 상태를 sending 으로 되돌리고 리스만 만료시킨다.
    ledger.dispatch[0].status = "sending";
    ledger.invitations[0].status = "issued";
    ledger.expireLeases();

    await drainInvitationDispatch();
    const retryKey = sendAlimtalkBatch.mock.calls[1][2]?.idempotencyKey;

    expect(sendAlimtalkBatch).toHaveBeenCalledTimes(2);
    expect(retryKey).toBe(firstKey); // 같은 키 → NCP dedup → 실제 발송은 1통
    expect(ledger.dispatch[0].attempt_count).toBe(2); // 시도 횟수는 관측용으로 증가
  });

  it("🔴 접수 거부된 수신자를 **sent 로 기록하지 않는다**", async () => {
    // 실측 사고(2026-07-28): 버튼 링크가 승인 템플릿과 어긋난 발송이 요청 접수는
    // A000(성공)으로 돌아오고 카카오 전달만 실패했다. 옛 코드는 배치 전체를 하나의
    // 불리언으로 접어 **미도달 건까지 "발송됨"** 으로 남겼다. 주최자 화면에도
    // 발송 완료로 뜨고 아무도 모른다.
    hasAlimtalkCredentials.mockReturnValue(true);
    sendAlimtalkBatch.mockImplementation(async (_tpl: string, items: Array<{ to: string }>) => ({
      requestId: "req-x",
      count: items.length,
      results: items.map((i) => ({
        to: i.to.replace(/[^0-9]/g, ""),
        ok: false,
        code: "3027",
        desc: "버튼 내용이 템플릿과 일치 하지 않음",
      })),
    }));
    await bulk();
    const res = await drainInvitationDispatch();

    expect(res.sent).toBe(0);
    expect(res.failed).toBe(1);
    expect(ledger.dispatch[0].status).toBe("failed");
    expect(ledger.invitations[0].status).not.toBe("sent");
    expect(String(ledger.dispatch[0].last_error)).toContain("3027");
  });

  it("🔴 배치 일부만 거부되면 **거부분만** failed 로 갈린다", async () => {
    hasAlimtalkCredentials.mockReturnValue(true);
    sendAlimtalkBatch.mockImplementation(async (_tpl: string, items: Array<{ to: string }>) => ({
      requestId: "req-y",
      count: items.length,
      // 두 번째 수신자만 거부 — 배치는 부분 실패한다.
      results: items.map((i, idx) => ({
        to: i.to.replace(/[^0-9]/g, ""),
        ok: idx === 0,
        code: idx === 0 ? "A000" : "3027",
        desc: idx === 0 ? "성공" : "버튼 내용이 템플릿과 일치 하지 않음",
      })),
    }));
    await bulk([
      { name: "홍길동", phone: "010-1111-2222" },
      { name: "김철수", phone: "010-3333-4444" },
    ]);
    const res = await drainInvitationDispatch();

    expect(res.sent).toBe(1);
    expect(res.failed).toBe(1);
    const statuses = ledger.dispatch.map((d: { status: string }) => d.status).sort();
    expect(statuses).toEqual(["failed", "sent"]);
  });

  it("🔴 주최자의 명시적 재발송은 **다른 멱등키** 로 나간다(실제 재발송)", async () => {
    hasAlimtalkCredentials.mockReturnValue(true);
    await bulk();
    await drainInvitationDispatch();
    const firstKey = sendAlimtalkBatch.mock.calls[0][2]?.idempotencyKey;

    ledger.resend(ledger.invitations[0].id); // send_epoch +1
    await drainInvitationDispatch();
    const resendKey = sendAlimtalkBatch.mock.calls[1][2]?.idempotencyKey;

    expect(resendKey).not.toBe(firstKey);
  });

  it("멱등키는 항목 순서에 무관하고 랜덤이 아니다(안정 파생)", () => {
    const a = deriveDispatchIdempotencyKey([
      { dispatchId: "d1", sendEpoch: 0 },
      { dispatchId: "d2", sendEpoch: 1 },
    ]);
    const b = deriveDispatchIdempotencyKey([
      { dispatchId: "d2", sendEpoch: 1 },
      { dispatchId: "d1", sendEpoch: 0 },
    ]);
    expect(a).toBe(b);
    expect(a).not.toBe(
      deriveDispatchIdempotencyKey([
        { dispatchId: "d1", sendEpoch: 0 },
        { dispatchId: "d2", sendEpoch: 2 }, // epoch 만 달라도 키가 갈린다
      ]),
    );
  });

  it("이벤트 정보 조회 실패분은 발송하지 않고 재큐잉한다(잘못된 안내 발송 금지)", async () => {
    hasAlimtalkCredentials.mockReturnValue(true);
    await bulk();
    getEvent.mockRejectedValue(new FakeV2CommerceError("down", 503));

    const res = await drainInvitationDispatch();
    expect(res.claimed).toBe(1);
    expect(res.sent).toBe(0);
    expect(sendAlimtalkBatch).not.toHaveBeenCalled();
    expect(requeueInvitationDispatch).toHaveBeenCalledTimes(1);
    expect(ledger.dispatch[0].status).toBe("queued"); // 다음 tick 재시도
  });

  // ── 회귀(F2 라이브 버그1): 날짜 포맷 크래시 방지 ──
  it("allpass/single(admission_day=null) — 기간 표기로 크래시 없이 발송", async () => {
    hasAlimtalkCredentials.mockReturnValue(true);
    await bulk();
    const res = await drainInvitationDispatch();
    expect(res.sent).toBe(1);
    const [, items] = sendAlimtalkBatch.mock.calls[0];
    const rangeContent = String(items[0].content);
    expect(rangeContent).toContain("2026년 8월 20일");
    expect(rangeContent).toContain("2026년 8월 23일");
    expect(ledger.dispatch[0].status).toBe("sent");
  });

  /**
   * 🔴 정책 (2026-07-30): 초대권은 **입장일을 지정하지 않는다.**
   * 종전 이 테스트는 `admissionDay: "2026-08-21"` 을 넘기면 지정일이 표기되기를 요구했다.
   * 그 요구가 폐기됐다 — 호출자가 날짜를 보내도 서버가 떨어낸다.
   */
  it("🔴 호출자가 admissionDay 를 보내도 원장에 박히지 않고 기간 표기로 발송한다", async () => {
    hasAlimtalkCredentials.mockReturnValue(true);
    await bulk([{ ...RECIPIENT, admissionDay: "2026-08-21" }]);
    // 원장에 날짜가 남지 않아야 한다 — 여기가 정책의 실제 경계다.
    expect(ledger.invitations[0].admission_day).toBeNull();
    const res = await drainInvitationDispatch();
    expect(res.sent).toBe(1);
    const content = String(sendAlimtalkBatch.mock.calls[0][1][0].content);
    expect(content).not.toContain("2026년 8월 21일");
    expect(content).toContain("2026년 8월 20일"); // 행사 전체 기간
    expect(content).toContain("2026년 8월 23일");
  });

  /**
   * ⚠️ 정책 **이전에 발급된** 초대권은 원장에 날짜가 박혀 있다 —
   * prod 에 `admission_day = 2026-08-20` 3건이 그 상태다(실측).
   * 그 행들은 지정일 표기로 정상 발송돼야 한다(드레인 분기는 살아 있어야 한다).
   */
  it("원장에 날짜가 이미 박힌 발급분은 지정일 표기로 발송한다 — 기존 3건 경로", async () => {
    hasAlimtalkCredentials.mockReturnValue(true);
    await bulk();
    // 정책 이전 발급분을 재현: 원장 행에 직접 날짜를 박는다(발권 경로를 우회).
    ledger.invitations[0].admission_day = "2026-08-21";
    const res = await drainInvitationDispatch();
    expect(res.sent).toBe(1);
    expect(String(sendAlimtalkBatch.mock.calls[0][1][0].content)).toContain("2026년 8월 21일");
  });
});

/**
 * 🔴 전달 상태 대사 — 오늘(2026-07-28) 실계정 발송에서 겪은 시나리오를 그대로 고정한다.
 *
 *   접수 응답  requestStatusCode = "A000"  (성공)
 *   전달 결과  messageStatusCode  = "3027" (실패 — 버튼이 승인 템플릿과 불일치)
 *
 * 접수만 보던 옛 경로에서는 원장에 sent 로 남고 아무도 몰랐다.
 */
describe("reconcileInvitationDelivery — 도달 여부 사후 확인", () => {
  const CAND = {
    dispatch_id: "d-1",
    invitation_id: "i-1",
    request_id: "req-1",
    phone: "010-1111-2222",
  };

  beforeEach(() => {
    hasAlimtalkCredentials.mockReturnValue(true);
    listPendingDeliveryCheck.mockResolvedValue({ items: [CAND] });
    reportInvitationDeliveryResult.mockResolvedValue({ marked: 1, undelivered: 0 });
  });

  it("🔴 미도달(3027)을 v2 에 미도달로 보고한다 — 여기서 안 잡으면 영구히 '발송됨'이다", async () => {
    fetchAlimtalkDeliveryStatus.mockResolvedValue([
      { to: "01011112222", delivered: false, code: "3027", desc: "버튼 내용이 템플릿과 일치 하지 않음" },
    ]);
    reportInvitationDeliveryResult.mockResolvedValue({ marked: 1, undelivered: 1 });

    const res = await reconcileInvitationDelivery();

    expect(res.checked).toBe(1);
    expect(res.undelivered).toBe(1);
    const [payload] = reportInvitationDeliveryResult.mock.calls[0];
    expect(payload.checked[0]).toMatchObject({
      dispatch_id: "d-1",
      invitation_id: "i-1",
      delivered: false,
      code: "3027",
    });
  });

  it("도달(0000)은 도달로 보고한다(상태 변경 없음)", async () => {
    fetchAlimtalkDeliveryStatus.mockResolvedValue([
      { to: "01011112222", delivered: true, code: "0000", desc: "정상 발송" },
    ]);
    const res = await reconcileInvitationDelivery();
    expect(res.undelivered).toBe(0);
    const [payload] = reportInvitationDeliveryResult.mock.calls[0];
    expect(payload.checked[0].delivered).toBe(true);
  });

  it("🔴 전달 결과가 아직 안 잡힌 건은 **미도달로 단정하지 않고** 다음 tick 으로 넘긴다", async () => {
    // 코드가 비어 오는 건 "실패"가 아니라 "아직 모름"이다. 단정하면 정상 발송이
    // failed 로 뒤집히고 주최자가 멀쩡한 초대권을 다시 보낸다(중복 발송).
    fetchAlimtalkDeliveryStatus.mockResolvedValue([
      { to: "01011112222", delivered: false, code: null, desc: null },
    ]);
    const res = await reconcileInvitationDelivery();
    expect(res.pending).toBe(1);
    expect(res.checked).toBe(0);
    expect(reportInvitationDeliveryResult).not.toHaveBeenCalled();
  });

  it("🔴 응답에 없는 수신자도 다음 tick 으로 — 없는 것을 실패로 읽지 않는다", async () => {
    fetchAlimtalkDeliveryStatus.mockResolvedValue([
      { to: "01099998888", delivered: true, code: "0000", desc: null },
    ]);
    const res = await reconcileInvitationDelivery();
    expect(res.pending).toBe(1);
    expect(reportInvitationDeliveryResult).not.toHaveBeenCalled();
  });

  it("🔴 SENS 조회가 실패하면 원장을 건드리지 않는다", async () => {
    fetchAlimtalkDeliveryStatus.mockRejectedValue(new Error("NCP API 500"));
    const res = await reconcileInvitationDelivery();
    expect(res.pending).toBe(1);
    expect(reportInvitationDeliveryResult).not.toHaveBeenCalled();
  });

  it("같은 배치(requestId)는 조회를 **한 번만** 한다", async () => {
    listPendingDeliveryCheck.mockResolvedValue({
      items: [
        CAND,
        { dispatch_id: "d-2", invitation_id: "i-2", request_id: "req-1", phone: "010-3333-4444" },
      ],
    });
    fetchAlimtalkDeliveryStatus.mockResolvedValue([
      { to: "01011112222", delivered: true, code: "0000", desc: null },
      { to: "01033334444", delivered: false, code: "3027", desc: "버튼 불일치" },
    ]);
    reportInvitationDeliveryResult.mockResolvedValue({ marked: 2, undelivered: 1 });

    const res = await reconcileInvitationDelivery();

    expect(fetchAlimtalkDeliveryStatus).toHaveBeenCalledTimes(1);
    expect(res.checked).toBe(2);
    const [payload] = reportInvitationDeliveryResult.mock.calls[0];
    expect(payload.checked.map((c: { delivered: boolean }) => c.delivered)).toEqual([true, false]);
  });

  it("자격 미설정(stub 발송)이면 대사하지 않는다", async () => {
    hasAlimtalkCredentials.mockReturnValue(false);
    const res = await reconcileInvitationDelivery();
    expect(res.candidates).toBe(0);
    expect(listPendingDeliveryCheck).not.toHaveBeenCalled();
  });
});

/**
 * 🔴 초대권 회수 → go 참석자 취소 (2026-07-31 prod 실측 사고)
 *
 * 회수는 v2 티켓만 죽이고 go `attendees` 를 안 건드렸다. 그런데 발송 세그먼트
 * (`lib/notification/recipients.ts`)는 **주문 상태 + 참석자 상태**를 보고,
 * 초대권 회수는 주문을 건드리지 않으므로 두 조건을 **다 통과**한다.
 * ⟹ **회수당한 사람에게 공지·리마인더가 계속 나갔다.** prod 원장에서 4건 실측.
 */
describe("초대권 회수 — 참석자 투영", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPool.mockReturnValue({ query: vi.fn(async (_sql: string, _p?: unknown[]) => ({ rows: [], rowCount: 1 })) } as never);
  });

  it("🔴 회수하면 go 참석자도 cancelled 로 만든다", async () => {
    const query = vi.fn(async (_sql: string, _p?: unknown[]) => ({ rows: [], rowCount: 1 }));
    getPool.mockReturnValue({ query } as never);
    revokeInvitationV2.mockResolvedValue({
      revoked: true, invitation: { id: "inv-1", ticket_number: "TKT-ABC", status: "revoked" },
    });

    const ok = await revokeInvitation({ accountId: "acc", eventId: "evt", invitationId: "inv-1" });

    expect(ok).toBe(true);
    const sql = String((query.mock.calls[0] as unknown[] | undefined)?.[0] ?? "");
    expect(sql).toMatch(/UPDATE attendees SET status = 'cancelled'/);
    expect((query.mock.calls[0] as unknown[] | undefined)?.[1]).toEqual(["TKT-ABC"]);
  });

  it("🔴 checked_in 참석자는 건드리지 않는다 — 입장 이력을 지우면 재입장이 열린다", async () => {
    const query = vi.fn(async (_sql: string, _p?: unknown[]) => ({ rows: [], rowCount: 0 }));
    getPool.mockReturnValue({ query } as never);
    revokeInvitationV2.mockResolvedValue({
      revoked: true, invitation: { id: "inv-1", ticket_number: "TKT-ABC", status: "revoked" },
    });

    await revokeInvitation({ accountId: "acc", eventId: "evt", invitationId: "inv-1" });

    expect(String((query.mock.calls[0] as unknown[] | undefined)?.[0] ?? "")).toMatch(/NOT IN \('cancelled', 'checked_in'\)/);
  });

  it("v2 가 회수를 거절하면 참석자를 건드리지 않는다", async () => {
    const query = vi.fn();
    getPool.mockReturnValue({ query } as never);
    // 🔴 invitation 은 **있게** 둔다. null 이면 뒤 분기가 어차피 안 도는 것이라
    //    "revoked 검사" 를 지워도 테스트가 통과한다(뮤테이션 생존).
    revokeInvitationV2.mockResolvedValue({
      revoked: false, invitation: { id: "inv-1", ticket_number: "TKT-ABC", status: "issued" },
    });

    const ok = await revokeInvitation({ accountId: "acc", eventId: "evt", invitationId: "inv-1" });

    expect(ok).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it("발권 전 회수(ticket_number 없음)면 투영을 건너뛴다", async () => {
    const query = vi.fn();
    getPool.mockReturnValue({ query } as never);
    revokeInvitationV2.mockResolvedValue({
      revoked: true, invitation: { id: "inv-1", ticket_number: null, status: "revoked" },
    });

    const ok = await revokeInvitation({ accountId: "acc", eventId: "evt", invitationId: "inv-1" });

    expect(ok).toBe(true);
    expect(query).not.toHaveBeenCalled();
  });

  it("🔴 투영이 실패해도 회수 자체는 성립한다 — 되돌리면 '티켓은 죽었는데 회수 안 됨' 이 된다", async () => {
    getPool.mockReturnValue({
      query: vi.fn(async () => { throw new Error("go DB down"); }),
    } as never);
    revokeInvitationV2.mockResolvedValue({
      revoked: true, invitation: { id: "inv-1", ticket_number: "TKT-ABC", status: "revoked" },
    });

    const ok = await revokeInvitation({ accountId: "acc", eventId: "evt", invitationId: "inv-1" });

    expect(ok).toBe(true);
  });
});
