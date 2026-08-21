import crypto from "node:crypto";
import { resolveNotificationSecret } from "@/lib/notification/secret";

/**
 * 초대권(comp) 딥링크 bearer 토큰 — P0-2 옵션 A (RECIPIENT-ACCESS-MODEL-P0.md).
 *
 * 전화-only 초대객은 이메일 매직링크를 받을 수 없어(가짜 이메일) 티켓을 영영 못 연다.
 * 대신 발권 시 티켓번호에 바인딩된 서명 토큰을 만들어 알림톡 링크에 실어보내면,
 * 링크 자체가 접근증명이 되어 무인증 열람이 가능하다. bearer 리스크(링크 전달=티켓 전달)는
 * **무료 초대권 한정**으로 수용하며, 게이트 실보안은 회전 QR + 소지가 담당한다.
 *
 * 설계(§3):
 *  - 서명 대상 = `{ticketNumber, v}` (v = revocation nonce). SESSION_SIGNING_KEY 재사용.
 *  - 서명 스코프 prefix `invite:` — public-lookup/magic 토큰과 상호 대체 불가.
 *  - 만료 = 이벤트 종료 + α (호출측이 expiresAt 지정, 기본 30일).
 *  - revocation: 초대 회수 시 원장의 nonce(v)를 증가 → 구 링크는 v 불일치로 무효.
 *  - comp/invitation 티켓에만 적용(유료티켓은 기존 강한 인증 유지).
 */

export const INVITE_TOKEN_PARAM = "t";

type InviteTokenPayload = {
  /** 바인딩된 티켓번호(attendees.ticket_number). */
  t: string;
  /** revocation nonce — 원장 invitations.token_version 와 일치해야 유효. */
  v: number;
  /** 만료(epoch ms). */
  e: number;
};

function getSigningKey() {
  // public-access.ts 와 동일한 SESSION_SIGNING_KEY·dev 폴백을 재사용(HMAC 키 일치).
  // env.server("server-only") 대신 process.env 직접 참조(cron/tsx 워커·테스트 호환).
  return resolveNotificationSecret(["SESSION_SIGNING_KEY"], "pickket-dev-public-lookup", "초대권 딥링크 서명키");
}

function toBase64Url(input: string) {
  return Buffer.from(input).toString("base64url");
}

function fromBase64Url(input: string) {
  return Buffer.from(input, "base64url").toString("utf8");
}

function sign(encodedPayload: string) {
  // 스코프 prefix 로 다른 서명(public-lookup/magic)과 격리.
  return crypto.createHmac("sha256", getSigningKey()).update(`invite:${encodedPayload}`).digest("base64url");
}

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30일(이벤트 종료 + α 폴백).

/**
 * 초대권 딥링크 토큰 발급.
 * @param ticketNumber attendees.ticket_number (바인딩 대상)
 * @param version 원장 token_version(nonce). revocation 시 증가.
 * @param expiresAt 만료 epoch ms. 미지정 시 now+30일.
 */
export function createInvitationToken(input: {
  ticketNumber: string;
  version: number;
  expiresAt?: number;
}): string {
  const payload: InviteTokenPayload = {
    t: input.ticketNumber,
    v: input.version,
    e: input.expiresAt ?? Date.now() + DEFAULT_TTL_MS,
  };
  const encoded = toBase64Url(JSON.stringify(payload));
  return `${encoded}.${sign(encoded)}`;
}

/**
 * 토큰 검증 — 서명·만료만 확인(nonce 매칭은 호출측이 원장 token_version 과 대조).
 * @returns 유효하면 payload(ticketNumber/version), 아니면 null.
 */
export function verifyInvitationToken(token: string | null | undefined): InviteTokenPayload | null {
  if (!token) return null;
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return null;

  const expected = sign(encoded);
  // 서명 비교는 timing-safe. 길이 불일치 시 즉시 실패(timingSafeEqual 은 길이 다르면 throw).
  if (
    signature.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(fromBase64Url(encoded)) as InviteTokenPayload;
    if (typeof parsed.t !== "string" || !parsed.t) return null;
    if (typeof parsed.v !== "number") return null;
    if (typeof parsed.e !== "number" || parsed.e < Date.now()) return null;
    return { t: parsed.t, v: parsed.v, e: parsed.e };
  } catch {
    return null;
  }
}

/**
 * 티켓 페이지 접근 판정 — 토큰이 (a) 서명·만료 유효 (b) 대상 티켓번호 일치
 * (c) 원장 nonce(currentVersion) 일치 시에만 무인증 열람 허용.
 */
export function invitationTokenGrantsAccess(input: {
  token: string | null | undefined;
  ticketNumber: string;
  currentVersion: number;
}): boolean {
  const payload = verifyInvitationToken(input.token);
  if (!payload) return false;
  if (payload.t !== input.ticketNumber) return false;
  if (payload.v !== input.currentVersion) return false;
  return true;
}
