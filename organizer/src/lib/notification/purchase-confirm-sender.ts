/**
 * 구매확정 알림 발송 — **모든 경로가 쓰는 단 하나의 구현**.
 *
 * ## 🔴 왜 하나로 모으나 (2026-07-31)
 * 같은 알림을 세 곳이 각자 만들고 있었고, **인자가 달랐다**:
 *
 * | | 입금확정(order-finalize) | 카드(state-changed) |
 * |---|---|---|
 * | `ticketNumber` | ✅ 넘김 | 🔴 **안 넘김** |
 * | `venueName` | ✅ | 🔴 없음 → 본문 `"-"` |
 * | `linkExpiresAt` | ✅ | 🔴 없음 |
 *
 * 승인 템플릿 `PICKKETPURCHASE001` 에는 **'모바일 티켓' 버튼이 있다**. 버튼을 안 실으면
 * 접수는 `A000` 인데 카카오가 **전달을 거부한다**(`messageStatusCode=3027`, 2026-07-28 실측).
 * ⟹ 카드 구매자는 **알림톡을 받지 못하는데 로그에는 성공으로 남는다**.
 *
 * 대사(repair) 경로를 새로 만들면서 이 결함을 복제할 뻔했다. 그래서 합쳤다.
 *
 * ## 계약
 * - **COMMIT 후에만** 부른다. 내부에서 v2 를 두 번 왕복하고 외부 발송을 한다.
 * - v2 조회에 실패하면 **보내지 않는다**(`skipped`). 제목을 `"행사"`, 장소를 `"-"` 로
 *   때워 보내는 폴백은 쓰지 않는다 — 발송은 회수할 수 없다.
 * - 🔴 **티켓이 열람 가능한 상태일 때만** 보낸다. `ticket-link-token` 의
 *   `VIEWABLE_STATUSES = {active, used}` 라, v2 티켓이 `expired` 면 버튼이 죽은 링크가 된다.
 * - 멱등은 **호출자 책임**이다(발송 원장이 없다 — go 메시징 원장은 mig250 으로 DROP 됐고
 *   v2 `message_deliveries` 는 트랜잭션 알림을 거치지 않는다). 호출자는 "상태 전이가
 *   실제로 일어난 경우" 에만 이 함수를 불러야 한다.
 */
import { getEvent, getOrder } from "@/lib/v2/commerce-client";
import { logger } from "@/lib/logger";
import { deriveTicketNumber } from "@/lib/ticket/ticket-number";
import { notifyPurchaseConfirm } from "@/lib/notification/transactional";

/**
 * 🔴 **다시는 활성화되지 않는** 티켓 상태. 여기 해당하면 링크가 영영 안 열리므로 보내지 않는다.
 *
 * ⚠️ `pending` 을 여기 넣으면 안 된다. 무통장 입금확정(`order-finalize`)은 v2 confirm 을
 * **비동기 outbox 워커**로 돌리므로(`order-finalize.ts:137-148`), 알림을 보내는 시점의
 * v2 티켓은 대개 아직 `pending` 이다. `pending` 을 막으면 **무통장 구매확정 알림톡이
 * 통째로 끊긴다** — 한 번 그렇게 만들었다가 감사에서 잡혔다.
 *
 * 즉 판정 기준은 "지금 열리는가" 가 아니라 **"앞으로도 안 열리는가"** 다.
 */
const DEAD_TICKET_STATUSES = new Set(["cancelled", "expired", "transferred"]);

/** 링크 버튼에 실을 티켓을 고르는 우선순위. 활성이 있으면 그것, 없으면 곧 활성화될 `pending`. */
const TICKET_PICK_ORDER = ["active", "used", "pending"];

export interface PurchaseConfirmOrderRow {
  accountId: string;
  eventId: string;
  orderNumber: string;
  v2OrderId: string | null;
  email: string | null;
  phone: string | null;
  name: string | null;
  ticketCount: number;
}

export type PurchaseConfirmResult =
  | { sent: true; ticketNumber: string | null; attempted: number; failed: number }
  | { sent: false; reason: string };

export async function sendPurchaseConfirm(
  row: PurchaseConfirmOrderRow,
): Promise<PurchaseConfirmResult> {
  let ev: Awaited<ReturnType<typeof getEvent>>;
  try {
    ev = await getEvent(row.eventId);
  } catch (e: unknown) {
    // 🔴 폴백 발송 금지. 행사명·장소를 모른 채 보내면 본문이 "행사"/"-" 로 나가고 되돌릴 수 없다.
    return { sent: false, reason: `v2 이벤트 조회 실패: ${e instanceof Error ? e.message : "unknown"}` };
  }

  // 🔴 '모바일 티켓' 버튼에 실을 티켓번호. 없으면 카카오가 전달을 거부한다(3027).
  let ticketNumber: string | null = null;
  if (row.v2OrderId) {
    try {
      const detail = await getOrder(row.v2OrderId);
      const tickets = detail.tickets ?? [];
      const alive = tickets.filter((t) => !DEAD_TICKET_STATUSES.has(t.status));
      // 🔴 `tickets.length > 0` 조건을 걸면 **빈 배열이 통과**한다. 그러면 ticketNumber
      //    없이 발송되고, 승인 템플릿에 버튼이 있으므로 카카오가 전달을 거부한다(3027).
      //    접수는 A000 이라 로그엔 성공으로 남는다 — 가장 잡기 어려운 형태의 미발송이다.
      if (alive.length === 0) {
        // 전부 취소·만료 = 링크가 영영 안 열린다. 그 상태로 "구매 완료" 를 보내지 않는다.
        // (전파 유실분을 대사가 뒤늦게 되돌릴 때 실제로 이 상태인 건이 있었다.)
        return {
          sent: false,
          reason: tickets.length === 0
            ? "v2 주문에 티켓이 없다(버튼 없는 발송은 3027 거부)"
            : `살아있는 티켓이 없다(v2 ticket status: ${tickets.map((t) => t.status).join(",")})`,
        };
      }
      const pick =
        TICKET_PICK_ORDER.map((s) => alive.find((t) => t.status === s)).find(Boolean) ??
        alive[0];
      if (pick) ticketNumber = deriveTicketNumber(pick.ticket_id);
    } catch (e: unknown) {
      return { sent: false, reason: `v2 주문 조회 실패: ${e instanceof Error ? e.message : "unknown"}` };
    }
  }

  const result = await notifyPurchaseConfirm({
    accountId: row.accountId,
    email: row.email,
    phone: row.phone,
    buyerName: row.name || "고객",
    eventTitle: ev.title,
    orderNumber: row.orderNumber,
    ticketCount: row.ticketCount,
    eventDate: ev.event_date
      ? new Date(ev.event_date).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })
      : "",
    venueName: ev.venue ?? null,
    ticketNumber,
    // 🔴 반드시 넘긴다. 없으면 토큰이 `now + 30일` 이라 **호출마다 값이 달라진다**
    //    (링크 재현성·요청 지문이 함께 흔들린다). 만료 = 행사 다음날.
    // 🔴 **종료일** 기준이다 (2026-08-21 수정). 종전엔 `event_date`(시작일) + 1일이라
    //    다일 대회(8/20~23)에서 **둘째 날 아침에 이미 나간 링크가 전부 죽었다**.
    linkExpiresAt: (ev.event_date_end ?? ev.event_date)
      ? new Date((ev.event_date_end ?? ev.event_date) as string).getTime() + 24 * 60 * 60 * 1000
      : undefined,
  });

  // fanout 결과를 버리지 않는다 — 종전 두 호출부는 이 값을 무시해 "몇 채널이 실패했는지"
  // 를 아무도 몰랐다.
  if (result.failed > 0) {
    logger.warn("구매확정 알림 일부 채널 실패", {
      source: "purchase-confirm-sender",
      orderNumber: row.orderNumber,
      attempted: result.attempted,
      failed: result.failed,
    });
  }
  // 🔴 **전 채널이 실패했으면 성공이 아니다.** 종전엔 무조건 sent:true 를 돌려줘서
  //    호출부가 notified 로 세고 넘어갔고, 주문은 이미 completed 라 대사 스캔에도
  //    다시 안 잡힌다 — 발송 원장이 없으므로 그 구매자는 **영영 알림을 못 받는다**.
  if (result.attempted > 0 && result.failed >= result.attempted) {
    return { sent: false, reason: `전 채널 발송 실패(${result.failed}/${result.attempted})` };
  }
  return { sent: true, ticketNumber, attempted: result.attempted, failed: result.failed };
}

/** go `orders` 한 행에서 발송에 필요한 값을 읽는 공통 SQL 조각. */
export const PURCHASE_CONFIRM_ORDER_SELECT = `
  SELECT o.account_id AS "accountId", o.event_id AS "eventId",
         o.order_number AS "orderNumber", o.v2_order_id AS "v2OrderId",
         o.buyer_email AS email, o.buyer_phone AS phone, o.buyer_name AS name,
         (SELECT COUNT(*)::int FROM attendees a
           WHERE a.order_id = o.id AND a.status <> 'cancelled') AS "ticketCount"
    FROM orders o WHERE o.id = $1
`;
