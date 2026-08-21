/**
 * 발송 수신자 해석 — dryRun 카운트와 실발송이 같은 집합을 보도록 한 곳에 모은다.
 * 세그먼트(상품·구매일·개별선택·추첨당첨) 지원 + 블랙리스트/수신거부 자동 제외.
 * 화이트리스트 필터만 SQL 로 조립(자유 SQL 아님).
 *
 * W3-MSG(레벨2 컷오버): 억제/블랙리스트 판정을 go DB 에서 **v2 원장**으로 옮겼다.
 *   · 옛 `crm_contacts` 3곳(tier 세그먼트·tags 세그먼트·tier='blacklist' 제외)이 사라졌다.
 *     crm_contacts 는 CRM 관리 UI·route 제거(287814e)로 **writer 0**, prod·dev 모두 **행 0**
 *     이라 tier/tags 세그먼트는 무엇을 고르든 0명이 되는 死조건이었다. 블랙리스트만이
 *     의미 있는 안전장치였고, 그것은 v2 `message_suppressions(channel='all')` 로 이관된다.
 *   · 억제 판정은 SQL NOT EXISTS → v2 배치 조회 후 **후필터**. 조회 실패는 throw(fail-closed).
 */
import { normalizeContact } from "@/lib/notification/compliance";
// W3-MSG 잔여 go DB: attendees LEFT JOIN orders — 수신자 **본체**. 참석자 원장 v2 이관 트랙 종속(억제/블랙리스트는 v2 로 이관 완료).
import { getPool } from "@/lib/db/pool";
import { toV2EventId } from "@/lib/v2/event-access";
import { fetchWonOrderRefs } from "@/lib/v2/lottery-won-entries";
import {
  fetchSuppressedContacts,
  type ComplianceChannel,
} from "@/lib/v2/messaging-compliance-client";
import { fetchTicketIdsByProductRefs } from "@/lib/v2/segment-tickets";

export type MsgChannel = "email" | "sms" | "alimtalk";
export type RecipientFilter = "all" | "checked_in" | "not_checked_in";

export interface Segment {
  status?: RecipientFilter; // 참석 상태
  productIds?: string[]; // 특정 상품(등급) 구매자
  // ⚠️ crmTiers/crmTags 는 W3-MSG 에서 폐기됐다(데이터·writer 실측 0). segment-schema 가
  //    해당 키를 담은 요청을 400 으로 **거부**한다 — 조용히 무시하면 좁히는 필터가 사라져
  //    의도보다 넓은 대상에게 발송된다.
  purchasedAfter?: string; // ISO — 구매일 범위
  purchasedBefore?: string;
  attendeeIds?: string[]; // 개별 다중선택
  lotteryWon?: boolean; // 추첨 당첨자(주문이 won 입찰에서 발생)만. 낙첨자는 티켓이 없어 참석자 세그먼트로 도달 불가.
}

export interface Recipient {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
}

/** 발송 채널 → 억제/동의 원장 채널 표기(알림톡 = kakao). */
const SUP_CHANNEL: Record<MsgChannel, ComplianceChannel> = {
  email: "email",
  sms: "sms",
  alimtalk: "kakao",
};

/** 세그먼트 → 파라미터화 WHERE 절 조립. FROM/WHERE 문자열 + 바인딩 반환.
 *  wonOrderRefs: lotteryWon 세그먼트용 v2 당첨 주문 ref(= go order id). 조회는 호출자가
 *  선행(비동기)하고 여기선 바인딩만 한다. */
function buildSegment(
  accountId: string,
  eventId: string,
  channel: MsgChannel,
  seg: Segment,
  wonOrderRefs?: string[],
  productTicketIds?: string[],
): { fromWhere: string; params: unknown[] } {
  const params: unknown[] = [accountId, eventId];
  const w: string[] = [
    "attendees.account_id = $1",
    "attendees.event_id = $2",
    "attendees.status <> 'cancelled'",
    "(orders.id IS NULL OR orders.status NOT IN ('cancelled','refunded','expired'))",
    channel === "email" ? "attendees.email IS NOT NULL" : "attendees.phone IS NOT NULL",
  ];

  if (seg.status === "checked_in") w.push("attendees.status = 'checked_in'");
  else if (seg.status === "not_checked_in") w.push("attendees.status <> 'checked_in'");

  if (seg.attendeeIds?.length) {
    params.push(seg.attendeeIds);
    w.push(`attendees.id = ANY($${params.length}::uuid[])`);
  }
  if (seg.lotteryWon) {
    // 레벨2: 추첨 SoT = v2. go bids 는 410 폐기되어 항상 empty → 조회하면 조용한 0명.
    // v2 won-entries(order_ref = go order id)로 해석한다. 당첨자 0명이면 정상적으로 0건.
    params.push(wonOrderRefs ?? []);
    w.push(`attendees.order_id = ANY($${params.length}::uuid[])`);
  }
  if (seg.productIds?.length) {
    // T2-ORD: go order_items(프로덕션 write 0 死테이블) EXISTS → v2 티켓 해석으로 교체.
    // 옛 조건은 v2-흐름 참석자에게 **항상 false**(조용한 0명 발송)였고, 조건을 삭제하면
    // 반대로 전체 발송이 된다. 상품 소속의 정본은 v2 ticket.tier(external_ref = go productId).
    params.push(productTicketIds ?? []);
    w.push(`attendees.v2_ticket_id = ANY($${params.length}::uuid[])`);
  }
  if (seg.purchasedAfter) {
    params.push(seg.purchasedAfter);
    w.push(`orders.created_at >= $${params.length}`);
  }
  if (seg.purchasedBefore) {
    params.push(seg.purchasedBefore);
    w.push(`orders.created_at <= $${params.length}`);
  }
  // 블랙리스트·수신거부 제외는 SQL 이 아니라 v2 원장 후필터(excludeSuppressed)가 담당한다.
  // 여기서 조건을 빼먹으면 안 되는 이유는 그대로다 — 후필터는 **반드시** 두 진입점
  // (countSegment·resolveSegment) 모두에서 같은 방식으로 돌아야 한다.

  return {
    fromWhere: `FROM attendees LEFT JOIN orders ON orders.id = attendees.order_id WHERE ${w.join(" AND ")}`,
    params,
  };
}

/** lotteryWon 세그먼트면 v2 당첨 주문 ref 를 선조회. 실패는 전파(fail-closed) —
 *  빈 목록으로 삼키면 "0명 발송"이 조용히 성공처럼 보인다. */
async function resolveWonOrderRefs(eventId: string, seg: Segment): Promise<string[] | undefined> {
  if (!seg.lotteryWon) return undefined;
  // 레벨2 T2-EVT — go `events` 앵커 조회 제거(id 승격으로 go id == v2 id, 항등 변환).
  // ⚠️ 미스 시맨틱 변화: 옛 코드는 앵커 NULL 을 V2LotteryWonEntriesError 로 던졌다. 이 레이어에는
  //    더 이상 NULL 케이스가 없고, 이벤트가 v2 에 없으면 fetchWonOrderRefs 가 non-2xx →
  //    동일한 V2LotteryWonEntriesError 로 던진다. fail-closed(빈 목록 위장 금지)는 그대로 유지된다.
  return fetchWonOrderRefs(toV2EventId(eventId));
}

/** T2-ORD: productIds 세그먼트면 v2 에서 해당 상품 티켓 id 를 선조회(fail-closed). */
async function resolveProductTicketIds(eventId: string, seg: Segment): Promise<string[] | undefined> {
  if (!seg.productIds?.length) return undefined;
  // T2-EVT 와 동일 — go `events` 앵커 조회 제거(항등 변환). 이벤트가 v2 에 없으면
  // fetchTicketIdsByProductRefs 가 non-2xx → V2SegmentTicketsError 로 던진다(fail-closed 유지).
  return fetchTicketIdsByProductRefs(toV2EventId(eventId), seg.productIds);
}

/** 세그먼트가 필요로 하는 v2 선조회를 한 번에 수행(카운트·실발송이 같은 집합을 보게). */
async function resolveSegmentRefs(eventId: string, seg: Segment) {
  const [wonOrderRefs, productTicketIds] = await Promise.all([
    resolveWonOrderRefs(eventId, seg),
    resolveProductTicketIds(eventId, seg),
  ]);
  return { wonOrderRefs, productTicketIds };
}

/**
 * 블랙리스트·수신거부 제외 — v2 억제 원장(`message_suppressions`) 후필터.
 *
 * ⚠️ **fail-closed**: v2 조회가 실패하면 예외를 그대로 올린다. 여기서 catch 해
 *   "억제 없음"으로 흘리면 **수신거부·블랙리스트 대상 전원에게 발송**된다. 라우트는 이
 *   예외를 503 으로 변환한다(0명 성공 위장 금지).
 *
 * 억제 원장의 채널 표기는 kakao(= 알림톡). channel='all' 억제(구 CRM 블랙리스트)는 v2
 * 질의의 `channel IN (ch,'all')` 이 함께 잡는다.
 */
async function excludeSuppressed(
  accountId: string,
  channel: MsgChannel,
  rows: Recipient[],
): Promise<Recipient[]> {
  if (rows.length === 0) return rows;
  const ch = SUP_CHANNEL[channel];
  const key = (r: Recipient) =>
    ch === "email" ? (r.email ?? "") : (r.phone ?? "");
  const contacts = rows.map(key).filter((c) => c.trim().length > 0);
  if (contacts.length === 0) return rows;
  const suppressed = await fetchSuppressedContacts(accountId, ch, contacts);
  if (suppressed.size === 0) return rows;
  return rows.filter((r) => {
    const raw = key(r);
    if (!raw.trim()) return true;
    return !suppressed.has(normalizeContact(ch, raw));
  });
}

/** 세그먼트 원본 행(억제 후필터 전) — count/resolve 가 **같은 경로**를 쓰도록 한 곳에. */
async function querySegmentRows(
  accountId: string,
  eventId: string,
  channel: MsgChannel,
  seg: Segment,
): Promise<Recipient[]> {
  const { wonOrderRefs, productTicketIds } = await resolveSegmentRefs(eventId, seg);
  const { fromWhere, params } = buildSegment(
    accountId, eventId, channel, seg, wonOrderRefs, productTicketIds,
  );
  const { rows } = await getPool().query<Recipient>(
    `SELECT DISTINCT attendees.id, attendees.name, attendees.email, attendees.phone ${fromWhere}`,
    params,
  );
  return rows;
}

/**
 * 미리보기 인원수. **resolveSegment 와 동일한 집합**을 세도록 같은 함수를 통과시킨다.
 * (옛 구현은 COUNT(*) SQL 을 따로 돌렸다 — 억제 제외가 후필터로 옮겨진 지금 그 방식이면
 *  미리보기 인원수와 실발송 대상이 갈라진다.)
 */
export async function countSegment(
  accountId: string,
  eventId: string,
  channel: MsgChannel,
  seg: Segment,
): Promise<number> {
  return (await resolveSegment(accountId, eventId, channel, seg)).length;
}

export async function resolveSegment(
  accountId: string,
  eventId: string,
  channel: MsgChannel,
  seg: Segment,
): Promise<Recipient[]> {
  const rows = await querySegmentRows(accountId, eventId, channel, seg);
  return excludeSuppressed(accountId, channel, rows);
}

// ── 하위호환 얇은 래퍼 (기존 recipientFilter 경로) ──
export const countRecipients = (a: string, e: string, ch: MsgChannel, f: RecipientFilter) =>
  countSegment(a, e, ch, { status: f });
export const resolveRecipients = (a: string, e: string, ch: MsgChannel, f: RecipientFilter) =>
  resolveSegment(a, e, ch, { status: f });
