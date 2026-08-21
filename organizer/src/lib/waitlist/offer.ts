/**
 * 대기자 "구매 제안" 발송 — offered 전이 시 신청자에게 구매 딥링크 이메일 + 주최자 알림.
 *
 * 트랜잭션 경계: 이 함수는 waitlist_entries 가 이미 offered/expires_at/token_version 으로
 * 커밋된 뒤(외부호출 후 crash 여도 상태 정합 유지) best-effort 로 호출한다. 이메일 발송
 * 실패가 상태 전이를 되돌리지 않도록 예외를 삼키지 않고 결과를 반환한다(호출부 로깅).
 */
import { createNotification } from "@/lib/notifications/create";
import { formatDateTime2DigitKst, formatKRW } from "@/lib/format";
import { logger } from "@/lib/logger";
import { sendEmail } from "@/lib/notification/email";
import { makeWaitlistOfferToken } from "./offer-token";

function baseUrl(): string {
  return (
    process.env.PUBLIC_BASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    "https://go.pickket.kr"
  );
}

export interface WaitlistOfferContext {
  accountId: string;
  eventId: string;
  eventSlug: string;
  eventTitle: string;
  entryId: string;
  name: string;
  email: string;
  productName: string;
  unitPrice: number;
  expiresAtMs: number;
  tokenVersion: number;
}

/** 제안 딥링크 URL. 구매창(공개 이벤트 페이지)이 wl/t 를 소비해 claim 플로우로 진입. */
export function buildOfferDeepLink(ctx: WaitlistOfferContext): string {
  const token = makeWaitlistOfferToken({
    entryId: ctx.entryId,
    expiresAtMs: ctx.expiresAtMs,
    version: ctx.tokenVersion,
  });
  const url = new URL(`/e/${encodeURIComponent(ctx.eventSlug)}/checkout`, baseUrl());
  url.searchParams.set("wl", ctx.entryId);
  url.searchParams.set("t", token);
  return url.toString();
}

function offerEmailHtml(ctx: WaitlistOfferContext, deepLink: string, expiresLabel: string): string {
  return `
    <div style="font-family:-apple-system,'Pretendard',sans-serif;max-width:520px;margin:0 auto;color:#1A1D2E">
      <h2 style="font-size:20px;font-weight:800;letter-spacing:-0.04em">구매 순서가 돌아왔습니다</h2>
      <p style="font-size:14px;line-height:1.7">${ctx.name}님, 대기 신청하신 <b>${ctx.eventTitle}</b>의 구매 기회가 열렸습니다.</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px">
        <tr><td style="padding:6px 0;color:#6B7280">상품</td><td style="padding:6px 0;text-align:right;font-weight:600">${ctx.productName}</td></tr>
        <tr><td style="padding:6px 0;color:#6B7280">금액</td><td style="padding:6px 0;text-align:right;font-weight:600">${formatKRW(ctx.unitPrice)}</td></tr>
        <tr><td style="padding:6px 0;color:#6B7280">구매 마감</td><td style="padding:6px 0;text-align:right;font-weight:600">${expiresLabel}</td></tr>
      </table>
      <a href="${deepLink}" style="display:inline-block;background:linear-gradient(135deg,#6C5CE7,#8B5CF6);color:#fff;text-decoration:none;padding:12px 28px;border-radius:100px;font-weight:600;font-size:15px">지금 구매하기</a>
      <p style="font-size:12px;color:#9CA3AF;margin-top:16px">이 링크는 ${expiresLabel}까지 유효하며, 한 번만 사용할 수 있습니다. 기한이 지나면 다음 대기자에게 순서가 넘어갑니다.</p>
    </div>
  `;
}

export interface WaitlistOfferSendResult {
  emailSent: boolean;
  simulated: boolean;
}

/**
 * 제안 발송(이메일 + 주최자 알림). 멱등키(waitlist-offer:{entryId}:{version})로 동일 제안
 * 재발송 시 메일러 중복 발송을 차단한다.
 */
export async function sendWaitlistOffer(ctx: WaitlistOfferContext): Promise<WaitlistOfferSendResult> {
  const deepLink = buildOfferDeepLink(ctx);
  // 🔴 만료 시각은 메일·문자로 나간다. 서버 시간대에 밀리면 손님이 틀린 마감을 본다.
  const expiresLabel = formatDateTime2DigitKst(ctx.expiresAtMs, "");

  let emailSent = false;
  let simulated = false;
  const emailResult = await sendEmail({
    to: ctx.email,
    subject: `[${ctx.eventTitle}] 구매 순서가 돌아왔습니다`,
    bodyHtml: offerEmailHtml(ctx, deepLink, expiresLabel),
    idempotencyKey: `waitlist-offer:${ctx.entryId}:${ctx.tokenVersion}`,
  });
  emailSent = emailResult.success;
  simulated = Boolean(emailResult.simulated);

  // 주최자 대시보드 알림(정보성) — 발송 사실 기록. 미매핑 타입이라 항상 생성(fail-open).
  await createNotification({
    accountId: ctx.accountId,
    eventId: ctx.eventId,
    type: "waitlist_offer",
    title: "대기자 구매 제안 발송",
    message: `${ctx.name}님에게 ${ctx.productName} 구매 제안을 보냈습니다 (마감 ${expiresLabel})`,
    metadata: { entryId: ctx.entryId, productName: ctx.productName, expiresAtMs: ctx.expiresAtMs },
  });

  logger.info("대기자 구매 제안 발송", { entryId: ctx.entryId, emailSent, simulated });
  return { emailSent, simulated };
}
