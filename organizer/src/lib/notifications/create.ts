// ── 레벨2 컷오버 W5-SUPPORT: go `notifications` → v2 `organizer_notifications`. ──
// 알림 원장 write 는 v2 로 이관됐다.
// 🔴 잔여(범위 밖): `accounts.notification_prefs` 조회는 go DB 그대로다 — `accounts` 테이블
//    이관은 별도 트랙 소유(전 리포 13개소 사용). 이 파일에서 건드리지 않는다.
import { getPool } from "@/lib/db/pool";
import { formatKRW } from "@/lib/format";
import { logger } from "@/lib/logger";
import type { NotificationType } from "@/lib/types";
import { createOrganizerNotification } from "@/lib/v2/commerce-client";

interface CreateNotificationParams {
  accountId: string;
  eventId?: string;
  type: NotificationType;
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
}

// 알림 타입 → 사용자 토글 카테고리 매핑(accounts.notification_prefs 키).
// 여기 매핑되지 않은 타입(system 등)은 토글 대상이 아니며 항상 발송한다.
const TYPE_TO_CATEGORY: Partial<Record<NotificationType, string>> = {
  new_order: "orders",
  sold_out: "sold_out",
  refund_request: "refunds",
  payment_failed: "payment_failed",
  check_in_milestone: "check_in",
  ai_review: "ai",
  ai_complete: "ai",
};

// 계정의 notification_prefs 를 조회해 해당 타입의 카테고리가 명시적으로 false 면 발송을 억제한다.
// 키 부재(또는 조회 실패)는 기본 on 으로 취급 → 알림 유실 방지(fail-open).
async function isNotificationEnabled(accountId: string, type: NotificationType): Promise<boolean> {
  const category = TYPE_TO_CATEGORY[type];
  if (!category) {
    // system 등 토글 대상 아님 → 항상 발송.
    return true;
  }
  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT notification_prefs AS "notificationPrefs" FROM accounts WHERE id = $1 LIMIT 1`,
      [accountId],
    );
    const prefs = result.rows[0]?.notificationPrefs;
    if (!prefs || typeof prefs !== "object") {
      return true;
    }
    const value = (prefs as Record<string, unknown>)[category];
    // 기본 on: 명시적 false 일 때만 억제.
    return value !== false;
  } catch (err: unknown) {
    // 마이그레이션 209 미적용(컬럼 부재) 등 조회 실패 시 알림을 막으면 주문/환불 등
    // 핫패스가 깨진다. fail-open: 설정 조회 실패는 "발송"으로 처리하고 경고만 남긴다.
    logger.warn("알림 설정 조회 실패 — 기본 발송(fail-open)", {
      error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

export async function createNotification({
  accountId,
  eventId,
  type,
  title,
  message,
  metadata,
}: CreateNotificationParams): Promise<void> {
  if (!(await isNotificationEnabled(accountId, type))) {
    return;
  }

  // v2 원장에 기록. 실패는 **전파**한다(옛 go INSERT 와 동일 계약) — 호출측(주문/환불 등)이
  // 이미 자기 경계에서 try/catch 로 감싸 부수효과 실패를 처리하고 있으므로, 여기서 조용히
  // 삼키면 "알림이 갔다"는 잘못된 전제가 위로 퍼진다.
  await createOrganizerNotification({
    account_id: accountId,
    event_id: eventId ?? null,
    type,
    title,
    message,
    metadata: metadata ?? {},
  });
}

export async function notifyRefundRequest(accountId: string, eventId: string, orderNumber: string): Promise<void> {
  await createNotification({
    accountId,
    eventId,
    type: "refund_request",
    title: "환불 요청 접수",
    message: `주문 #${orderNumber}에 대한 환불 요청이 접수되었습니다`,
    metadata: { orderNumber },
  });
}

export async function notifySoldOut(accountId: string, eventId: string, productName: string): Promise<void> {
  await createNotification({
    accountId,
    eventId,
    type: "sold_out",
    title: "상품 매진",
    message: `${productName} 상품이 매진되었습니다`,
    metadata: { productName },
  });
}

export async function notifyPaymentFailed(accountId: string, eventId: string, orderNumber: string): Promise<void> {
  await createNotification({
    accountId,
    eventId,
    type: "payment_failed",
    title: "결제 실패",
    message: `주문 #${orderNumber}의 결제가 실패했습니다`,
    metadata: { orderNumber },
  });
}

export async function notifyNewOrder(accountId: string, eventId: string, orderNumber: string, amount: number): Promise<void> {
  await createNotification({
    accountId,
    eventId,
    type: "new_order",
    title: "새 주문",
    message: `주문 #${orderNumber} (${formatKRW(amount)})이 접수되었습니다`,
    metadata: { orderNumber, amount },
  });
}

const AGENT_LABELS: Record<string, string> = {
  pricing: "가격 제안",
  marketing: "마케팅",
  analytics: "분석",
  design: "디자인",
  promo: "프로모코드",
  "sales-chatbot": "세일즈 챗봇",
  "cs-triage": "CS 응대",
};

export async function notifyAgentReview(
  accountId: string,
  eventId: string | undefined,
  agentType: string,
  runId: string,
): Promise<void> {
  const label = AGENT_LABELS[agentType] ?? agentType;
  await createNotification({
    accountId,
    eventId,
    type: "ai_review",
    title: "AI 제안 검토 필요",
    message: `${label} 에이전트의 제안이 도착했습니다. 심사 센터에서 확인해주세요.`,
    metadata: { agentType, runId },
  });
}

export async function notifyAgentComplete(
  accountId: string,
  eventId: string | undefined,
  agentType: string,
  runId: string,
): Promise<void> {
  const label = AGENT_LABELS[agentType] ?? agentType;
  await createNotification({
    accountId,
    eventId,
    type: "ai_complete",
    title: "AI 자동 적용 완료",
    message: `${label} 에이전트의 제안이 자동 적용되었습니다.`,
    metadata: { agentType, runId },
  });
}
