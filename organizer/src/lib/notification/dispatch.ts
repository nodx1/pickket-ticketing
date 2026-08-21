/**
 * 컴플라이언스 게이트를 통과한 단일 발송 — 모든 발송 경로의 공통 진입점.
 *
 * 게이트 순서:
 *   1) 광고성: 수신거부·수신동의·야간(21~08) 검사 → 실패 시 skip(사유 기록).
 *      정보성: 수신거부만 검사.
 *   2) 채널 규칙: 알림톡(kakao)은 정보성 전용(카카오 규정). 광고성 알림톡은 금지 → 친구톡/이메일로.
 *   3) 광고 표기 자동주입(이메일 (광고)+수신거부 footer / SMS (광고)+무료거부).
 *   4) 실제 NCP 발송.
 */
import {
  canSendAd,
  canSendInfo,
  applyAdEmailFormatting,
  applyAdSmsFormatting,
  normalizeContact,
  type Channel,
  type GateResult,
  type MessageType,
} from "./compliance";
import { injectEmailTracking } from "./tracking";
import { sendEmail } from "./email";
import { sendSMS } from "./sms";
import { sendAlimtalk, type AlimtalkButton } from "./alimtalk";
import { NcpAmbiguousError } from "@/lib/ncp/client";

export interface DispatchParams {
  accountId: string;
  channel: Channel;
  messageType: MessageType;
  to: string; // 이메일 또는 전화번호
  subject?: string; // 이메일 전용
  body: string;
  templateCode?: string; // 알림톡 전용(카카오 승인 템플릿 코드)
  /** 알림톡 전용 — 승인 템플릿의 버튼과 **같은 내용**이어야 한다(불일치 시 미도달). */
  buttons?: AlimtalkButton[];
  messageId?: string; // 지정 시 이메일에 오픈/클릭 트래킹 주입(캠페인·단체 발송)
  idempotencyKey?: string; // 단체/재처리 경로가 고정한 provider attempt key
  /**
   * W3-MSG: 배치 발송이 미리 적재한 컴플라이언스 게이트(loadComplianceGate).
   * 지정하면 수신자별 v2 왕복을 건너뛴다. **판정 규칙은 단건 경로와 동일**(같은 decideAd).
   * 미지정이면 종전대로 단건 조회한다(단발 발송·트랜잭션 알림 경로).
   */
  gate?: (contact: string) => GateResult;
}

export type DispatchResult =
  | { status: "sent"; requestId?: string }
  | { status: "skipped"; reason: "suppressed" | "no_consent" | "night" | "alimtalk_ad_forbidden" | "no_contact" }
  | {
      status: "unknown";
      error: string;
      idempotencyKey?: string;
      requestFingerprint?: string;
      httpStatus?: number | null;
      timeoutStage?: "transport" | "provider_response";
    }
  | { status: "failed"; error: string };

export async function dispatchOne(p: DispatchParams): Promise<DispatchResult> {
  if (!p.to || !p.to.trim()) return { status: "skipped", reason: "no_contact" };

  // 채널 규칙: 알림톡은 정보성 전용.
  if (p.channel === "kakao" && p.messageType === "advertising") {
    return { status: "skipped", reason: "alimtalk_ad_forbidden" };
  }

  // 컴플라이언스 게이트 — 배치가 적재한 게이트가 있으면 재사용(v2 왕복 절약), 없으면 단건 조회.
  if (p.gate) {
    const decision = p.gate(p.to);
    if (!decision.ok) return { status: "skipped", reason: decision.reason ?? "suppressed" };
  } else if (p.messageType === "advertising") {
    const ad = await canSendAd(p.accountId, p.channel, p.to);
    if (!ad.ok) return { status: "skipped", reason: ad.reason ?? "suppressed" };
  } else if (!(await canSendInfo(p.accountId, p.channel, p.to))) {
    return { status: "skipped", reason: "suppressed" };
  }

  try {
    if (p.channel === "email") {
      let subject = p.subject ?? "";
      let bodyHtml = p.body;
      if (p.messageType === "advertising") {
        ({ subject, bodyHtml } = applyAdEmailFormatting(subject, bodyHtml, p.accountId, p.to));
      }
      // 트래킹 주입은 광고 footer 까지 링크 래핑되도록 포맷 이후에.
      if (p.messageId) {
        bodyHtml = injectEmailTracking(bodyHtml, p.messageId, normalizeContact("email", p.to));
      }
      const r = await sendEmail({ to: p.to, subject, bodyHtml, idempotencyKey: p.idempotencyKey ?? (p.messageId ? `message:${p.messageId}:email:${p.to}` : undefined) });
      return { status: "sent", requestId: (r as { requestId?: string }).requestId };
    }

    if (p.channel === "sms") {
      const body = p.messageType === "advertising" ? applyAdSmsFormatting(p.body) : p.body;
      const r = await sendSMS({ to: p.to, body, idempotencyKey: p.idempotencyKey ?? (p.messageId ? `message:${p.messageId}:sms:${p.to}` : undefined) });
      return { status: "sent", requestId: (r as { requestId?: string }).requestId };
    }

    // kakao 알림톡 (정보성)
    const r = await sendAlimtalk({
      to: p.to,
      templateCode: p.templateCode ?? "",
      message: p.body,
      buttons: p.buttons,
      idempotencyKey: p.idempotencyKey ?? (p.messageId ? `message:${p.messageId}:kakao:${p.to}` : undefined),
    });
    return { status: "sent", requestId: (r as { messageId?: string }).messageId };
  } catch (err) {
    const error = err instanceof Error ? err.message : "unknown";
    if (err instanceof NcpAmbiguousError) {
      return {
        status: "unknown",
        error,
        idempotencyKey: err.idempotencyKey,
        requestFingerprint: err.requestFingerprint,
        httpStatus: err.httpStatus,
        timeoutStage: err.timeoutStage,
      };
    }
    return { status: "failed", error };
  }
}
