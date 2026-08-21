/**
 * 카카오 알림톡 발송 — NCP SENS AlimTalk.
 *
 * 설정: NCP_ACCESS_KEY/NCP_SECRET_KEY + SENS_ALIMTALK_SERVICE_ID + SENS_ALIMTALK_CHANNEL_ID(@채널).
 * 미설정 시 개발환경은 시뮬레이션, 프로덕션은 명시적 실패.
 *
 * 템플릿 코드 (카카오 심사 승인 필요 — SENS 콘솔에서 등록):
 * - PURCHASE_CONFIRM: 구매 확인
 * - REMINDER_D7: D-7 리마인더
 * - REMINDER_D1: D-1 리마인더
 * - CANCEL_CONFIRM: 취소/환불 확인
 * - CHECKIN_QR: 체크인 QR 안내
 */
import { logger } from "@/lib/logger";
import { getRuntimeEnv } from "@/lib/env.runtime";
import { normalizeChannelId } from "./channel-id";
import { getNcpCreds, ncpJsonRequest, NCP_SENS_HOST } from "@/lib/ncp/client";

// ── 템플릿 정의 ──

// 템플릿 본문은 순수 모듈로 분리했다(클라이언트 미리보기가 같은 함수를 쓰기 위함).
import { ALIMTALK_TEMPLATES } from "./alimtalk-templates";

export { ALIMTALK_TEMPLATES };

export type AlimtalkTemplate = keyof typeof ALIMTALK_TEMPLATES;

/** 알림톡 버튼(현재 웹링크 WL 만 사용) — 카카오 승인 템플릿에 등록된 버튼과 일치해야 함. */
export interface AlimtalkButton {
  type: "WL"; // 웹링크
  name: string;
  linkMobile: string;
  linkPc?: string;
}

/** 알림톡 실패 시 SMS/LMS 대체 설정. 버튼 링크가 SMS엔 없으므로 content 에 링크를 텍스트로 포함한다. */
export interface AlimtalkFailover {
  type: "SMS" | "LMS";
  from?: string;
  subject?: string;
  content: string;
}

// ── 발송 함수 ──

interface SendAlimtalkParams {
  to: string;
  templateCode: string;
  message: string;
  idempotencyKey?: string;
  /**
   * 웹링크 버튼. 🔴 **승인 템플릿에 버튼이 있으면 발송에도 같은 버튼을 실어야 한다.**
   * 어긋나면 접수는 A000 인데 카카오가 전달을 거부한다(실측 3027 — 미도달).
   */
  buttons?: AlimtalkButton[];
}

/** NCP SENS 알림톡 자격증명(공통 인증키 + serviceId + 채널) 완비 여부. */
export function hasAlimtalkCredentials(): boolean {
  return Boolean(
    getNcpCreds() &&
      getRuntimeEnv("SENS_ALIMTALK_SERVICE_ID") &&
      normalizeChannelId(getRuntimeEnv("SENS_ALIMTALK_CHANNEL_ID")),
  );
}

/**
 * 🔴 SENS 발송 응답 — **접수 결과와 전달 결과는 다른 값**이다.
 *
 * 실측(2026-07-28, 실계정): 버튼 링크가 승인 템플릿과 어긋난 발송이
 *   requestStatusCode = "A000"(성공)  ← POST 응답. 옛 코드가 본 유일한 값
 *   messageStatusCode  = "3027"(실패)  ← 나중에 조회해야 보이는 값. "버튼 내용이 템플릿과 불일치"
 * 로 돌아왔다. 즉 **카톡이 도착하지 않았는데 원장에는 "발송됨"** 으로 남았다.
 * 대회 당일이었다면 수백 명이 초대권을 못 받은 채 아무도 몰랐을 상황이다.
 *
 * 그래서 두 단계로 본다:
 *   ① 여기(접수) — `messages[].requestStatusCode` 를 **수신자별로** 확인한다.
 *   ② 사후 대사 — `fetchAlimtalkDeliveryStatus()` 로 `messageStatusCode` 를 확인한다.
 */
const SENS_ACCEPT_OK = "A000";
/** 전달 성공 코드. 그 외는 전부 미도달로 취급한다(fail-closed). */
const SENS_DELIVER_OK = "0000";

interface SensMessageResult {
  messageId?: string;
  to?: string;
  requestStatusCode?: string;
  requestStatusName?: string;
  requestStatusDesc?: string;
}

interface SensSendResponse {
  requestId: string;
  statusName?: string;
  messages?: SensMessageResult[];
}

/** 수신자별 접수 결과. `ok=false` 면 그 번호는 발송되지 않았다. */
export interface AlimtalkRecipientResult {
  to: string;
  ok: boolean;
  code: string | null;
  desc: string | null;
}

/** 숫자만 남긴 수신번호(응답 매칭 키). */
function normalizePhone(v: string | undefined | null): string {
  return (v ?? "").replace(/[^0-9]/g, "");
}

/**
 * 응답 messages[] 를 요청 수신자에 매칭해 수신자별 접수 결과를 만든다.
 *
 * 🔴 응답에 안 실린 수신자는 **성공으로 보지 않는다**(fail-closed). SENS 가 일부만
 *    돌려주는 경우를 "성공"으로 접으면 정확히 이 결함이 재발한다.
 */
export function resolveRecipientResults(
  requested: string[],
  messages: SensMessageResult[] | undefined,
): AlimtalkRecipientResult[] {
  const byPhone = new Map<string, SensMessageResult>();
  for (const m of messages ?? []) {
    const key = normalizePhone(m.to);
    if (key && !byPhone.has(key)) byPhone.set(key, m);
  }
  return requested.map((raw) => {
    const to = normalizePhone(raw);
    const m = byPhone.get(to);
    if (!m) {
      return { to, ok: false, code: null, desc: "발송 응답에 수신자가 없습니다" };
    }
    const code = m.requestStatusCode ?? null;
    return {
      to,
      ok: code === SENS_ACCEPT_OK,
      code,
      desc: m.requestStatusDesc ?? m.requestStatusName ?? null,
    };
  });
}

/**
 * 배치 발송 — 동일 템플릿의 승인 본문을 수신자별 content 로 담아 한 콜로 전송(청크 ~100/콜).
 * useSmsFailover=true 로 알림톡 실패 시 SMS 대체. requestId 는 배치 단위.
 *
 * 반환의 `results` 로 **수신자별 접수 성패**를 알 수 있다. 호출부는 실패한 번호를
 * 성공으로 기록하면 안 된다(위 주석 참조).
 */
export async function sendAlimtalkBatch(
  templateCode: string,
  items: Array<{ to: string; content: string; buttons?: AlimtalkButton[]; failover?: AlimtalkFailover }>,
  options: { idempotencyKey?: string } = {},
): Promise<{ requestId: string; count: number; results: AlimtalkRecipientResult[] }> {
  if (items.length === 0) return { requestId: "", count: 0, results: [] };
  const creds = getNcpCreds();
  const serviceId = getRuntimeEnv("SENS_ALIMTALK_SERVICE_ID");
  // 🔴 정규화 필수 — env 에 주석이 섞여 있던 실사고(2026-07-29)로 NCP 가 404 를 냈다.
  //    형식이 끝내 어긋나면 null 이라 아래 미설정 분기로 떨어진다(잘못된 값으로 쏘지 않는다).
  const channelId = normalizeChannelId(getRuntimeEnv("SENS_ALIMTALK_CHANNEL_ID"));
  if (!creds || !serviceId || !channelId) {
    throw new Error("NCP SENS 알림톡 미설정(SENS_ALIMTALK_SERVICE_ID/SENS_ALIMTALK_CHANNEL_ID)");
  }

  const uri = `/alimtalk/v2/services/${serviceId}/messages`;
  const messages = items.map((i) => ({
    countryCode: "82",
    to: i.to.replace(/[^0-9]/g, ""),
    content: i.content,
    useSmsFailover: true,
    // 링크는 '모바일 티켓' 웹링크 버튼으로 전달(본문 인라인 URL 아님 — 카카오 승인 템플릿과 일치).
    ...(i.buttons && i.buttons.length > 0 ? { buttons: i.buttons } : {}),
    // 알림톡 실패 시 SMS/LMS 대체 — 버튼이 SMS엔 없으므로 링크 포함 content 로 발송.
    ...(i.failover ? { failoverConfig: i.failover } : {}),
  }));

  const result = await ncpJsonRequest<SensSendResponse>(
    NCP_SENS_HOST,
    "POST",
    uri,
    { plusFriendId: channelId, templateCode, messages },
    creds,
    { idempotencyKey: options.idempotencyKey },
  );
  const results = resolveRecipientResults(items.map((i) => i.to), result.messages);
  const rejected = results.filter((r) => !r.ok);
  if (rejected.length > 0) {
    // 접수 거부는 조용히 넘기지 않는다 — 여기서 안 남기면 원인 추적이 불가능하다.
    logger.error("알림톡 배치 일부 접수 거부(NCP SENS)", {
      requestId: result.requestId,
      templateCode,
      rejected: rejected.length,
      total: items.length,
      samples: rejected.slice(0, 3).map((r) => ({ code: r.code, desc: r.desc })),
    });
  }
  logger.info("알림톡 배치발송(NCP SENS)", {
    requestId: result.requestId,
    count: items.length,
    accepted: results.length - rejected.length,
  });
  return { requestId: result.requestId, count: items.length, results };
}

export async function sendAlimtalk({ to, templateCode, message, idempotencyKey, buttons }: SendAlimtalkParams) {
  const creds = getNcpCreds();
  const serviceId = getRuntimeEnv("SENS_ALIMTALK_SERVICE_ID");
  const channelId = normalizeChannelId(getRuntimeEnv("SENS_ALIMTALK_CHANNEL_ID")); // plusFriendId(@채널)

  if (!creds || !serviceId || !channelId) {
    // 프로덕션에서 미설정을 조용히 성공 처리하면 "발송됨" 표시 뒤 무음 장애가 된다.
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "NCP SENS 알림톡 미설정(NCP_ACCESS_KEY/NCP_SECRET_KEY/SENS_ALIMTALK_SERVICE_ID/SENS_ALIMTALK_CHANNEL_ID)으로 발송할 수 없습니다",
      );
    }
    logger.warn("알림톡 발송 시뮬레이션 (개발 환경 전용)", { to, templateCode, message: message.slice(0, 50) });
    return { success: true, simulated: true };
  }

  const uri = `/alimtalk/v2/services/${serviceId}/messages`;
  // content 는 카카오 승인 템플릿 본문(변수 치환 완료)과 일치해야 함. 실패 시 SMS 대체(useSmsFailover).
  const result = await ncpJsonRequest<SensSendResponse>(
    NCP_SENS_HOST,
    "POST",
    uri,
    {
      plusFriendId: channelId,
      templateCode,
      messages: [
        {
          countryCode: "82",
          to: to.replace(/[^0-9]/g, ""),
          content: message,
          useSmsFailover: true,
          ...(buttons && buttons.length > 0 ? { buttons } : {}),
        },
      ],
    },
    creds,
    { idempotencyKey },
  );

  // 🔴 접수 코드를 확인한다. 옛 코드는 HTTP 200 만 보고 성공을 반환해서, 템플릿 불일치·
  //    잘못된 번호로 **접수 자체가 거부된 건도 "발송 성공"** 으로 올라갔다.
  const [outcome] = resolveRecipientResults([to], result.messages);
  if (!outcome?.ok) {
    throw new Error(
      `알림톡 접수 거부(${outcome?.code ?? "no-result"}): ${outcome?.desc ?? "응답에 수신자 결과 없음"}`,
    );
  }

  logger.info("알림톡 발송 성공(NCP SENS)", { to, templateCode, requestId: result.requestId });
  return { success: true, simulated: false, messageId: result.requestId };
}

/**
 * 🔴 전달 상태 대사 — 접수(A000) 이후 **실제로 도착했는지**를 확인한다.
 *
 * SENS 는 접수 직후엔 전달 결과를 모른다. 몇 초 뒤 이 조회로만 `messageStatusCode` 가 보인다.
 * 이 단계가 없으면 "카카오가 거부했는데 우리는 발송됐다고 아는" 무음 장애가 성립한다
 * (실측 3027 — 이 함수를 만든 이유다).
 *
 * 반환은 수신번호 → 전달결과. 조회 자체가 실패하면 예외를 올린다(모름을 성공으로 접지 않는다).
 */
export async function fetchAlimtalkDeliveryStatus(
  requestId: string,
): Promise<Array<{ to: string; delivered: boolean; code: string | null; desc: string | null }>> {
  const creds = getNcpCreds();
  const serviceId = getRuntimeEnv("SENS_ALIMTALK_SERVICE_ID");
  if (!creds || !serviceId) {
    throw new Error("NCP SENS 알림톡 미설정 — 전달 상태를 확인할 수 없습니다");
  }
  const uri = `/alimtalk/v2/services/${serviceId}/messages?requestId=${encodeURIComponent(requestId)}`;
  const res = await ncpJsonRequest<{
    messages?: Array<{ to?: string; messageStatusCode?: string; messageStatusName?: string; messageStatusDesc?: string }>;
  }>(NCP_SENS_HOST, "GET", uri, undefined, creds);

  return (res.messages ?? []).map((m) => ({
    to: normalizePhone(m.to),
    delivered: m.messageStatusCode === SENS_DELIVER_OK,
    code: m.messageStatusCode ?? null,
    desc: m.messageStatusDesc ?? m.messageStatusName ?? null,
  }));
}

// ── 편의 함수 ──

export async function sendPurchaseConfirmAlimtalk(
  phone: string,
  vars: Parameters<typeof ALIMTALK_TEMPLATES.PURCHASE_CONFIRM.body>[0],
) {
  const tpl = ALIMTALK_TEMPLATES.PURCHASE_CONFIRM;
  return sendAlimtalk({ to: phone, templateCode: tpl.code, message: tpl.body(vars) });
}

export async function sendReminderAlimtalk(
  phone: string,
  type: "D7" | "D1",
  vars: Parameters<typeof ALIMTALK_TEMPLATES.REMINDER_D7.body>[0],
) {
  const tpl = type === "D7" ? ALIMTALK_TEMPLATES.REMINDER_D7 : ALIMTALK_TEMPLATES.REMINDER_D1;
  return sendAlimtalk({ to: phone, templateCode: tpl.code, message: tpl.body(vars) });
}

export async function sendCancelConfirmAlimtalk(
  phone: string,
  vars: Parameters<typeof ALIMTALK_TEMPLATES.CANCEL_CONFIRM.body>[0],
) {
  const tpl = ALIMTALK_TEMPLATES.CANCEL_CONFIRM;
  return sendAlimtalk({ to: phone, templateCode: tpl.code, message: tpl.body(vars) });
}
