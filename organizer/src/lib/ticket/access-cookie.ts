import crypto from "node:crypto";
import { resolveNotificationSecret } from "@/lib/notification/secret";

/**
 * 티켓 **아티팩트 접근 쿠키** — 딥링크로 연 손님이 QR 갱신·PDF·지갑을 쓰게 한다.
 *
 * ## 🔴 왜 필요한가 (2026-07-29 실사고)
 * 티켓 **페이지**는 딥링크 토큰(`?t=`)을 인정하는데, 아티팩트 **API 4개**
 * (`/qr` `/pdf` `/wallet/apple` `/wallet/google`)는 세션·조회쿠키만 봤다.
 * 초대권 손님은 둘 다 없다 → **403**.
 *
 * 실제 증상: 링크를 열면 QR 이 보이지만(초기 QR 은 페이지가 서버에서 만들어 심는다)
 * 30초 뒤 갱신이 403 으로 죽고, 허용창을 넘기면 **게이트에서 스캔이 거부**된다.
 * 같은 문지기가 들여보내 놓고 30초 뒤에 다른 신분증을 요구하는 상태였다.
 *
 * ## 왜 토큰을 매번 나르지 않고 쿠키인가
 *  · `/pdf` 는 `<Link target="_blank">` 로 열린다 — **브라우저 이동이라 헤더를 못 붙인다.**
 *    헤더 방식은 QR 만 고치고 PDF·지갑은 그대로 막힌다.
 *  · 토큰을 30초마다 쿼리스트링에 실으면 접근로그·히스토리·Referer 에 자격증명이 쌓인다.
 *  · 쿠키는 4개 엔드포인트를 한 번에 덮고, 첫 교환 이후 URL 에 안 남는다.
 *
 * ## 왜 서버 컴포넌트가 아니라 클라이언트 교환인가
 * Next.js 서버 컴포넌트는 **쿠키를 설정할 수 없다**(응답이 이미 스트리밍 중).
 * 이 리포의 쿠키 발급이 전부 라우트 핸들러인 것도 그 때문이다.
 * 그래서 페이지가 렌더된 뒤 클라이언트가 라우트 핸들러로 **한 번** 교환한다.
 * 교환이 실패해도 페이지는 지금처럼 열린다 — 기능이 통째로 죽지 않는다.
 *
 * ## 범위를 티켓 1장으로 묶는 이유
 * 쿠키가 새더라도 **그 티켓 하나**만 노출된다. 다른 티켓을 열면 자동으로 다시 교환되므로
 * 사용자는 아무것도 느끼지 못한다(카톡 링크에 토큰이 항상 들어 있다).
 */

export const TICKET_ACCESS_COOKIE = "pickket_ticket_access";

/** 쿠키 수명 — 게이트 입장은 한 세션 안에서 끝난다. 짧게 잡고 재교환에 맡긴다. */
export const TICKET_ACCESS_TTL_MS = 2 * 60 * 60 * 1000; // 2시간

interface AccessPayload {
  /** 접근이 허용된 티켓번호. 다른 티켓엔 통하지 않는다. */
  t: string;
  /** 만료(epoch ms). */
  e: number;
}

function key() {
  // 다른 공개 토큰(초대권 딥링크·조회쿠키)과 같은 키를 쓰되 **서명 스코프로 격리**한다.
  return resolveNotificationSecret(
    ["SESSION_SIGNING_KEY"],
    "pickket-dev-public-lookup",
    "티켓 접근 쿠키 서명키",
  );
}

function sign(encoded: string) {
  // 🔴 스코프 prefix 가 다르면 다른 토큰을 여기에 넣어도 서명이 맞지 않는다.
  //    (초대권 'invite:' · 유료 딥링크 'ticket:' · 조회 'magic:' 와 상호 대체 불가)
  return crypto.createHmac("sha256", key()).update(`tkt-access:${encoded}`).digest("base64url");
}

export function createTicketAccessCookie(input: { ticketNumber: string; expiresAt?: number }): string {
  const payload: AccessPayload = {
    t: input.ticketNumber,
    e: input.expiresAt ?? Date.now() + TICKET_ACCESS_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded)}`;
}

/**
 * 쿠키가 **이 티켓**에 대한 유효한 접근권인지 판정한다.
 *
 * 🔴 티켓번호 대조가 핵심이다. 빼면 쿠키 하나로 **모든 티켓**이 열린다.
 */
export function ticketAccessCookieGrants(
  cookieValue: string | null | undefined,
  ticketNumber: string,
): boolean {
  if (!cookieValue) return false;
  const [encoded, signature] = cookieValue.split(".");
  if (!encoded || !signature) return false;

  const expected = sign(encoded);
  // 길이가 다르면 timingSafeEqual 이 throw 한다 — 먼저 거른다.
  if (
    signature.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    return false;
  }

  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as AccessPayload;
    if (typeof parsed.t !== "string" || !parsed.t) return false;
    if (typeof parsed.e !== "number" || parsed.e < Date.now()) return false;
    return parsed.t === ticketNumber;
  } catch {
    return false;
  }
}
