import type { PoolClient } from "pg";
import { withAuth } from "@/lib/auth/withAuth";
import { getPool } from "@/lib/db/pool";
import { successResponse, errorResponse } from "@/lib/apiResponse";
import { requireFeature } from "@/lib/server/require-feature";
import {
  EventAccessError,
  eventAccessStatus,
  requireOwnedEvent,
} from "@/lib/v2/event-access";
import { transitionOrder } from "@/lib/state-machine/order-state-machine";
import { transitionAttendees } from "@/lib/state-machine/attendee-state-machine";
import { logger } from "@/lib/logger";

type Params = { eventId: string };

/**
 * 리허설 준비 현황 (레벨2 컷오버 W4-EVT — go `events` SELECT 제거).
 *
 * 옛 쿼리는 `FROM events e WHERE e.id=$1 AND e.account_id=$2` 로 ① 이벤트 status 표시와
 * ② 테넌트 경계를 동시에 했다. status 정본은 v2 이므로 v2 상세에서 읽고, 경계는
 * `requireFeature`(내부적으로 v2 organizer_ref 소유 검증 — 미소유 404 / v2 장애 503)가 이미
 * 강제한다. 서브쿼리 카운트에는 account_id 조건이 없으므로 **게이트 통과 후에만** 실행한다.
 *
 * 🔴 옛 동작의 조용한 버그도 함께 닫는다: 미소유/미존재면 rows 가 비어 `successResponse({})`
 *    (200 빈 객체)였다 — 이제 게이트에서 404/503 으로 끊긴다.
 */
export const GET = withAuth<Params>(async (_request, { session, params }) => {
  const { eventId } = await params;
  const featureBlock = await requireFeature(eventId, session.accountId, "rehearsal");
  if (featureBlock) return featureBlock;

  let status: string;
  try {
    const event = await requireOwnedEvent(eventId, session.accountId);
    status = event.status;
  } catch (err: unknown) {
    if (err instanceof EventAccessError) {
      return errorResponse(
        err.reason === "not_found"
          ? "이벤트를 찾을 수 없습니다"
          : "이벤트 정보를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.",
        eventAccessStatus(err),
      );
    }
    throw err;
  }

  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM products WHERE event_id = $1) AS "productCount",
       (SELECT count(*)::int FROM orders WHERE event_id = $1 AND account_id = $2) AS "orderCount",
       (SELECT count(*)::int FROM attendees WHERE event_id = $1) AS "attendeeCount"`,
    [eventId, session.accountId],
  );
  return successResponse({ status, ...(rows[0] ?? {}) });
});

// ─────────────────────────────────────────────────────────────────────────────
// 리허설 모의 실행 — 트랜잭션 롤백, 실데이터 미반영
//
// 실제 주문→티켓/참석자→체크인 플로우를 단일 트랜잭션(BEGIN) 안에서 모의 실행하고,
// 성공/실패와 무관하게 finally 에서 반드시 ROLLBACK 한다. COMMIT 은 절대 하지 않으며,
// orders/order_items/attendees 어떤 테이블에도 실제 행을 남기지 않는다.
// 외부 부작용(결제·이메일·알림·v2 API) 없이 순수 go DB 데이터 플로우(스키마·FK·
// CHECK 제약·상태머신 전이)만 검증한다.
// ─────────────────────────────────────────────────────────────────────────────

interface RehearsalStep {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

export const POST = withAuth<Params>(async (_request, { session, params }) => {
  const { eventId } = await params;
  const accountId = session.accountId;

  const featureBlock = await requireFeature(eventId, accountId, "rehearsal");
  if (featureBlock) return featureBlock;

  const pool = getPool();
  const client: PoolClient = await pool.connect();
  const steps: RehearsalStep[] = [];

  // 롤백 시에도 충돌하지 않도록 실행마다 고유 suffix (order_number/ticket_number UNIQUE)
  const nonce = `RH-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    await client.query("BEGIN");

    // 1) product_check — 이벤트에 판매 상품 존재 확인
    let productId: string | null = null;
    let productPrice = 0;
    try {
      const { rows } = await client.query<{ id: string; price: string }>(
        `SELECT id, price FROM products
         WHERE event_id = $1 AND account_id = $2
         ORDER BY sort_order ASC, created_at ASC
         LIMIT 1`,
        [eventId, accountId],
      );
      if (rows.length > 0) {
        productId = rows[0].id;
        productPrice = Number(rows[0].price);
        steps.push({
          key: "product_check",
          label: "판매 상품 확인",
          ok: true,
          detail: `상품 발견 (단가 ${productPrice.toLocaleString("ko-KR")}원)`,
        });
      } else {
        steps.push({
          key: "product_check",
          label: "판매 상품 확인",
          ok: false,
          detail: "이 이벤트에 판매 상품이 없습니다. 상품을 먼저 등록하세요.",
        });
      }
    } catch (err: unknown) {
      steps.push({
        key: "product_check",
        label: "판매 상품 확인",
        ok: false,
        detail: err instanceof Error ? err.message : "상품 조회 실패",
      });
    }

    // 2) order_create — 모의 orders INSERT (status pending)
    // T2-ORD: order_items 시드 제거. 프로덕션 write 0 의 死테이블이라 리허설이 검증할 대상이
    // 아니고, 이 시드가 남아 있으면 테이블 DROP 시 리허설이 통째로 깨진다.
    let orderId: string | null = null;
    if (productId) {
      try {
        const orderRes = await client.query<{ id: string }>(
          `INSERT INTO orders
             (account_id, event_id, order_number, buyer_name, buyer_email, buyer_phone,
              total_amount, paid_amount, status, payment_method, payment_status, expires_at)
           VALUES ($1, $2, $3, '리허설 모의구매자', 'rehearsal@pickket.local', NULL,
                   $4, 0, 'pending', 'offline', 'pending', NOW() + INTERVAL '1 hour')
           RETURNING id`,
          [accountId, eventId, `${nonce}-ORD`, productPrice],
        );
        orderId = orderRes.rows[0].id;

        steps.push({
          key: "order_create",
          label: "모의 주문 생성",
          ok: true,
          detail: "주문(pending) INSERT 성공",
        });
      } catch (err: unknown) {
        steps.push({
          key: "order_create",
          label: "모의 주문 생성",
          ok: false,
          detail: err instanceof Error ? err.message : "주문 생성 실패",
        });
      }
    } else {
      steps.push({
        key: "order_create",
        label: "모의 주문 생성",
        ok: false,
        detail: "판매 상품이 없어 건너뜀",
      });
    }

    // 3) order_complete — pending → completed 상태 전이
    if (orderId) {
      try {
        const applied = await transitionOrder(client, orderId, "pending", "completed");
        steps.push({
          key: "order_complete",
          label: "주문 완료 전이 (pending→completed)",
          ok: applied,
          detail: applied ? "상태머신 전이 성공" : "전이 실패(경합/만료 조건)",
        });
      } catch (err: unknown) {
        steps.push({
          key: "order_complete",
          label: "주문 완료 전이 (pending→completed)",
          ok: false,
          detail: err instanceof Error ? err.message : "전이 실패",
        });
      }
    } else {
      steps.push({
        key: "order_complete",
        label: "주문 완료 전이 (pending→completed)",
        ok: false,
        detail: "주문이 없어 건너뜀",
      });
    }

    // 4) attendee_issue — 모의 attendees INSERT (초기 상태 pending)
    let attendeeIssued = false;
    if (orderId) {
      try {
        await client.query(
          `INSERT INTO attendees
             (account_id, event_id, order_id, ticket_number, name, email, status)
           VALUES ($1, $2, $3, $4, '리허설 모의참석자', 'rehearsal@pickket.local', 'pending')`,
          [accountId, eventId, orderId, `${nonce}-TKT`],
        );
        attendeeIssued = true;
        steps.push({
          key: "attendee_issue",
          label: "참석자(티켓) 발행",
          ok: true,
          detail: "참석자 INSERT 성공(초기 상태 pending)",
        });
      } catch (err: unknown) {
        steps.push({
          key: "attendee_issue",
          label: "참석자(티켓) 발행",
          ok: false,
          detail: err instanceof Error ? err.message : "참석자 발행 실패",
        });
      }
    } else {
      steps.push({
        key: "attendee_issue",
        label: "참석자(티켓) 발행",
        ok: false,
        detail: "주문이 없어 건너뜀",
      });
    }

    // 5) checkin — pending → confirmed → checked_in 전이
    if (orderId && attendeeIssued) {
      try {
        const confirmedCount = await transitionAttendees(client, orderId, "pending", "confirmed");
        const checkedInCount =
          confirmedCount > 0
            ? await transitionAttendees(client, orderId, "confirmed", "checked_in")
            : 0;
        const ok = checkedInCount > 0;
        steps.push({
          key: "checkin",
          label: "체크인 전이 (pending→confirmed→checked_in)",
          ok,
          detail: ok
            ? `참석자 ${checkedInCount}명 체크인 전이 성공`
            : "체크인 전이 실패(전이 대상 없음)",
        });
      } catch (err: unknown) {
        steps.push({
          key: "checkin",
          label: "체크인 전이 (pending→confirmed→checked_in)",
          ok: false,
          detail: err instanceof Error ? err.message : "체크인 전이 실패",
        });
      }
    } else {
      steps.push({
        key: "checkin",
        label: "체크인 전이 (pending→confirmed→checked_in)",
        ok: false,
        detail: "참석자가 없어 건너뜀",
      });
    }

    const allPassed = steps.every((s) => s.ok);
    return successResponse({ steps, allPassed });
  } catch (err: unknown) {
    if (err instanceof Error) {
      logger.error("리허설 모의 실행 실패", {
        source: "rehearsal.POST",
        error: err.message,
        eventId,
        accountId,
      });
    }
    return errorResponse("리허설 모의 실행 중 오류가 발생했습니다", 500);
  } finally {
    // 성공/실패와 무관하게 반드시 롤백 — 실데이터에 어떤 행도 남기지 않는다.
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr: unknown) {
      if (rollbackErr instanceof Error) {
        logger.error("리허설 롤백 실패", {
          source: "rehearsal.POST",
          error: rollbackErr.message,
        });
      }
    }
    client.release();
  }
});
