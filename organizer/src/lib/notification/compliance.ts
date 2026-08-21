/**
 * 발송 컴플라이언스 — 정보통신망법(광고성 규제) + 수신거부/수신동의 + 야간발송 가드.
 *
 * 모든 발송(이메일/SMS/알림톡)은 디스패치 직전 이 게이트를 통과해야 한다.
 *   - 정보성(informational, 트랜잭션): 수신거부만 존중(동의 불요).
 *   - 광고성(advertising, 마케팅): 수신동의 필수 + (광고)표기 + 수신거부 + 야간(21~08) 가드.
 *
 * 워커(tsx)에서도 쓰이므로 env.server(server-only) 대신 process.env 직접 사용.
 */
import crypto from "node:crypto";
import {
  fetchConsents,
  fetchSuppressedContacts,
  grantConsent,
  revokeConsent,
  upsertSuppression,
  type ConsentState,
} from "@/lib/v2/messaging-compliance-client";
import { resolveNotificationSecret } from "./secret";
import { adEmailFooterHtml, adSmsFooter } from "./legal-footer";

export type Channel = "email" | "sms" | "kakao";
export type MessageType = "informational" | "advertising";
/** 게이트 판정 결과. ok=false 면 발송 스킵(사유는 delivery 원장에 기록). */
export type GateResult = { ok: boolean; reason?: "suppressed" | "no_consent" | "night" };

const env = (n: string) => process.env[n]?.trim() || undefined;
// H-05: 프로덕션에서 전용 시크릿(UNSUBSCRIBE_SECRET) 누락 시 dev 상수로 서명하지 않고 throw.
const unsubSecret = () =>
  resolveNotificationSecret(
    ["UNSUBSCRIBE_SECRET", "GO_WEBHOOK_SECRET", "SECRET_KEY"],
    "dev-unsub-secret",
    "수신거부 토큰",
  );
const baseUrl = () => env("PUBLIC_BASE_URL") || env("NEXT_PUBLIC_APP_URL") || "https://go.pickket.kr";

/** 이메일=소문자, 전화=숫자만. */
export function normalizeContact(channel: Channel, contact: string): string {
  return channel === "email" ? contact.trim().toLowerCase() : contact.replace(/[^0-9]/g, "");
}

// ── 수신거부(억제) ──────────────────────────────────────────────
// M-11: 억제에는 두 종류가 있다 —
//   · 마케팅 거부(unsubscribe/manual): 광고성만 차단, 거래(정보성)는 계속 발송.
//   · 배달불가(bounce/complaint): 실제 도달 불가/신고 → 정보성 포함 전부 차단.
// undeliverableOnly=true 면 배달불가 사유만 검사(정보성 게이트용).
// W3-MSG: 억제 원장 SoT = v2(`message_suppressions`). go DB SQL 제거.
//   조회 실패는 **throw**(fail-closed). false 로 흘리면 수신거부·블랙리스트 대상에게 발송된다.
export async function isSuppressed(
  accountId: string,
  channel: Channel,
  contact: string,
  opts: { undeliverableOnly?: boolean } = {},
): Promise<boolean> {
  const c = normalizeContact(channel, contact);
  const suppressed = await fetchSuppressedContacts(accountId, channel, [contact], {
    undeliverableOnly: opts.undeliverableOnly,
  });
  return suppressed.has(c);
}

export async function suppress(
  accountId: string | null,
  channel: Channel | "all",
  contact: string,
  reason: "unsubscribe" | "bounce" | "complaint" | "manual" = "unsubscribe",
): Promise<void> {
  // 정규화는 v2 가 동일 규칙으로 수행한다(channel='all' 은 소문자 trim).
  await upsertSuppression(accountId, channel, contact, reason);
}

// ── 수신동의(광고성 전용) ────────────────────────────────────────
export async function hasConsent(accountId: string, channel: Channel, contact: string): Promise<boolean> {
  const c = normalizeContact(channel, contact);
  const found = await fetchConsents(accountId, channel, [contact]);
  return found.get(c)?.consented === true;
}

// §3-2: 동의 취득 — 현재상태 UPSERT + 이벤트 원장 append. 원 동의시점(first_consented_at)·문구버전은
// 덮어쓰지 않고 보존한다(법정 이력). consented_at 은 최신 동의 시점(2년 재확인 기준일)으로 갱신.
export async function recordConsent(
  accountId: string,
  channel: Channel,
  contact: string,
  opts: { consented?: boolean; nightConsented?: boolean; source?: string; wordingVersion?: string } = {},
): Promise<void> {
  // W3-MSG: 현재상태 UPSERT + 이벤트 원장 append 는 v2 record_consent 가 원자적으로 수행.
  //   first_consented_at·wording_version 보존 규칙도 v2 쪽에 그대로 포팅돼 있다.
  await grantConsent(accountId, channel, contact, {
    consented: opts.consented ?? true,
    nightConsented: opts.nightConsented ?? false,
    source: opts.source,
    wordingVersion: opts.wordingVersion,
  });
}

// §3-2: 동의 철회 — 수신거부와 연동. 현재상태 consented=false + 이벤트 원장 append.
export async function withdrawConsent(
  accountId: string,
  channel: Channel,
  contact: string,
  source = "unsubscribe",
): Promise<void> {
  await revokeConsent(accountId, channel, contact, source);
}

/**
 * 광고성 발송 가능 여부 — 한 연락처에 대한 최종 판단.
 * 반환: { ok, reason } — ok=false 면 발송 스킵(사유 기록용).
 */
export async function canSendAd(
  accountId: string,
  channel: Channel,
  contact: string,
  now = new Date(),
): Promise<GateResult> {
  const c = normalizeContact(channel, contact);
  const suppressed = await fetchSuppressedContacts(accountId, channel, [contact]);
  // 동의·야간동의는 같은 행에서 나온다 → v2 왕복 1회로 합친다(옛 go 는 SQL 2회였다).
  const state = suppressed.has(c) ? undefined : (await fetchConsents(accountId, channel, [contact])).get(c);
  return decideAd(suppressed.has(c), state, now);
}

/**
 * 광고 게이트의 **유일한 판정 지점**(순수 함수).
 * 단건(canSendAd)과 배치(loadComplianceGate)가 이 함수를 공유해야 두 경로가 갈라지지 않는다.
 * 순서 계약: 수신거부 → 수신동의 → 야간(21~08 KST, 야간동의 없으면 차단).
 * ⚠️ `state === undefined`(동의 행 없음)는 **미동의**다. 부재를 동의로 승격하면 무동의 광고발송이다.
 */
function decideAd(suppressed: boolean, state: ConsentState | undefined, now: Date): GateResult {
  if (suppressed) return { ok: false, reason: "suppressed" };
  if (state?.consented !== true) return { ok: false, reason: "no_consent" };
  if (isNightWindow(now) && state.nightConsented !== true) return { ok: false, reason: "night" };
  return { ok: true };
}

/**
 * 배치 컴플라이언스 게이트 — 발송 루프용.
 *
 * 왜 필요한가: 억제/동의 원장이 v2 로 이관되면서 게이트 1건당 HTTP 왕복이 생겼다. 수신자
 * 1,000명 메시지에서 수신자별로 호출하면 발송 시작 전에 수천 번 왕복한다(claim lease 소진·
 * 크론 타임아웃 위험). 이 함수는 **왕복 2회**(억제 1 + 동의 1, 정보성은 억제 1회)로 끝낸다.
 *
 * ⚠️ 판정 자체는 `decideAd`/undeliverableOnly 로 단건 경로와 **동일**하다 — 배치 최적화가
 *   게이트 규칙을 바꾸면 안 된다.
 * ⚠️ fail-closed: 조회 실패는 여기서 throw 된다(부분 통과 게이트를 만들지 않는다).
 */
export async function loadComplianceGate(
  accountId: string,
  channel: Channel,
  messageType: MessageType,
  contacts: string[],
  now = new Date(),
): Promise<(contact: string) => GateResult> {
  const advertising = messageType === "advertising";
  const suppressed = await fetchSuppressedContacts(accountId, channel, contacts, {
    // 정보성은 배달불가(bounce/complaint)만 차단 — 마케팅 거부는 거래알림을 막지 않는다.
    undeliverableOnly: !advertising,
  });
  const consents = advertising
    ? await fetchConsents(accountId, channel, contacts)
    : new Map<string, ConsentState>();

  return (contact: string): GateResult => {
    const c = normalizeContact(channel, contact);
    if (!advertising) {
      return suppressed.has(c) ? { ok: false, reason: "suppressed" } : { ok: true };
    }
    return decideAd(suppressed.has(c), consents.get(c), now);
  };
}

/** 야간 광고 수신 별도동의 — canSendAd 가 동의 조회 1회로 합쳐 쓰므로 여기선 단건 조회용. */
export async function hasNightConsent(
  accountId: string,
  channel: Channel,
  contact: string,
): Promise<boolean> {
  const c = normalizeContact(channel, contact);
  const found = await fetchConsents(accountId, channel, [contact]);
  return found.get(c)?.nightConsented === true;
}

/** 정보성(거래) 발송 가능 여부 — 배달불가(bounce/complaint)만 차단. 마케팅 거부는 무시(거래는 계속). */
export async function canSendInfo(accountId: string, channel: Channel, contact: string): Promise<boolean> {
  return !(await isSuppressed(accountId, channel, contact, { undeliverableOnly: true }));
}

// ── 야간(21:00~08:00 KST) ────────────────────────────────────────
export function isNightWindow(date = new Date()): boolean {
  const kstHour = (date.getUTCHours() + 9) % 24;
  return kstHour >= 21 || kstHour < 8;
}

// ── 해지 토큰 (HMAC 서명) ────────────────────────────────────────
// 2.6-Low5: channel 을 서명 payload 에 포함 — 한 채널용 토큰을 다른 채널 수신거부에 재사용 불가.
// payload = accountId:contact:channel (셋 다 콜론 없음 → split(":") 3분할 안전). 구토큰 호환 불요(미배포).
export function makeUnsubscribeToken(accountId: string, contact: string, channel: Channel): string {
  const payload = `${accountId}:${contact}:${channel}`;
  const sig = crypto.createHmac("sha256", unsubSecret()).update(payload).digest("base64url");
  return Buffer.from(`${payload}:${sig}`).toString("base64url");
}

export function verifyUnsubscribeToken(
  token: string,
): { accountId: string; contact: string; channel: Channel } | null {
  try {
    const decoded = Buffer.from(token, "base64url").toString();
    const idx = decoded.lastIndexOf(":");
    if (idx < 0) return null;
    const payload = decoded.slice(0, idx);
    const sig = decoded.slice(idx + 1);
    const expected = crypto.createHmac("sha256", unsubSecret()).update(payload).digest("base64url");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const parts = payload.split(":");
    if (parts.length !== 3) return null;
    const [accountId, contact, channel] = parts;
    if (!accountId || !contact || (channel !== "email" && channel !== "sms" && channel !== "kakao")) {
      return null;
    }
    return { accountId, contact, channel };
  } catch {
    return null;
  }
}

// ── 광고 표기 자동주입 ───────────────────────────────────────────
// §3-3: 법정 표시항목(전송자명·전화·주소·수신거부)은 legal-footer 상수 모듈로 분리(env 우선).
/** 광고성 이메일: 제목 (광고) 접두 + 법정 footer. */
export function applyAdEmailFormatting(
  subject: string,
  bodyHtml: string,
  accountId: string,
  contact: string,
): { subject: string; bodyHtml: string } {
  const token = makeUnsubscribeToken(accountId, contact, "email");
  const url = `${baseUrl()}/api/public/unsubscribe?token=${token}`;
  return {
    subject: subject.startsWith("(광고)") ? subject : `(광고) ${subject}`,
    bodyHtml: bodyHtml + adEmailFooterHtml(url),
  };
}

/** 광고성 SMS/친구톡: (광고) 접두 + 법정 표기(전송자·연락처·수신거부). */
export function applyAdSmsFormatting(body: string): string {
  const prefix = body.startsWith("(광고)") ? "" : "(광고) ";
  return `${prefix}${body}${adSmsFooter()}`;
}
