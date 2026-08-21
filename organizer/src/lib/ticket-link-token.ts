import crypto from "node:crypto";
import { resolveNotificationSecret } from "@/lib/notification/secret";

/**
 * 유료 티켓 딥링크 bearer 토큰 — 알림톡 '모바일 티켓' 버튼용.
 *
 * ## 왜 필요한가
 * 구매완료 알림톡에 `/tickets/{번호}` 만 실으면 **구매자 전원이 열지 못한다.**
 * 그 페이지는 (a)로그인 (b)초대권 딥링크 (c)조회 쿠키 셋 중 하나를 요구하는데,
 * 카톡에서 막 들어온 구매자는 셋 다 없다 → `/my-tickets` 로 튕긴다. 거기서는
 * 이메일로 매직링크를 보내는데, 그 메일조차 발신 주소 미설정으로 나가지 않는다
 * (2026-07-28 실측). 즉 **결제는 됐는데 티켓에 닿는 길이 없다.**
 *
 * 초대권은 같은 문제를 bearer 토큰으로 이미 풀었다([[invitation-token]]).
 * 유료 티켓에도 같은 모델을 쓰되, 아래처럼 좁힌다.
 *
 * ## bearer 위험과 그 범위
 * 링크를 전달하면 받은 사람도 QR 을 본다. 그래서:
 *   · **열람 전용** — 이 토큰으로는 환불·양도를 할 수 없다(그 화면은 세션/본인확인 요구).
 *   · **상태가 곧 무효화** — 환불하면 `cancelled`, 양도하면 `transferred` 가 되고
 *     그 순간 이 토큰은 통하지 않는다. 별도 revocation 원장이 필요 없다.
 *   · **만료** — 기본 행사 종료 + α. 지난 링크는 저절로 죽는다.
 *   · 실제 입장 통제는 이 링크가 아니라 **30초 회전 QR + 현장 스캔(1회 사용)** 이 한다.
 *     링크를 둘이 나눠 가져도 입장은 한 번뿐이다.
 *
 * 보안 델타가 크지 않은 이유: 지금도 이메일·전화 지식만으로 조회 링크가 나간다.
 * 그리고 이 링크는 구매자 본인 폰의 카카오톡으로만 전달된다.
 *
 * ## 초대권 토큰과 섞이지 않는다
 * 서명 스코프 prefix 가 다르다(`ticket:` vs `invite:`). 한쪽 토큰을 다른 경로에
 * 넣어도 서명이 맞지 않는다 — 유료 티켓 토큰으로 초대권을 열거나 그 반대가 불가능하다.
 */

export const TICKET_LINK_PARAM = "t";

/**
 * 딥링크로 열람을 허용하는 티켓 상태. 그 외(cancelled/expired/transferred)는 거부.
 *
 * 🔴 `pending` 포함 (2026-08-20 실사고). 결제 확정이 비동기 outbox(무통장은 물론
 *    카드도 `payment_confirm_outbox` 를 거친다)라 발권 직후 잠시 pending 이다.
 *    `lib/ticket/usability.ts` 는 이미 pending 을 사용 가능으로 본다 — 그런데 이 파일만
 *    다른 기준을 써서, 결제 직후 알림톡 링크를 바로 누른 손님이 "링크가 만료되었거나
 *    사용할 수 없습니다" 를 봤다(실사용 재현: 결제 성공 직후 클릭). 두 게이트가 서로
 *    다른 기준으로 같은 질문("열람 가능한가")에 답하면 이렇게 어긋난다 — 기준을 맞춘다.
 */
const VIEWABLE_STATUSES = new Set(["pending", "active", "used"]);

type TicketLinkPayload = {
  /** 바인딩된 티켓번호. */
  t: string;
  /** 만료(epoch ms). */
  e: number;
};

function getSigningKey() {
  // 초대권 토큰과 **같은 키**를 쓰되 서명 스코프로 격리한다(키 관리 지점을 늘리지 않는다).
  return resolveNotificationSecret(
    ["SESSION_SIGNING_KEY"],
    "pickket-dev-public-lookup",
    "티켓 딥링크 서명키",
  );
}

function toBase64Url(input: string) {
  return Buffer.from(input).toString("base64url");
}

function fromBase64Url(input: string) {
  return Buffer.from(input, "base64url").toString("utf8");
}

function sign(encodedPayload: string) {
  return crypto
    .createHmac("sha256", getSigningKey())
    .update(`ticket:${encodedPayload}`)
    .digest("base64url");
}

/** 만료 기본값 — 행사 종료를 모르면 30일. 호출측이 행사 종료+1일을 넘기는 게 정석이다. */
/** 🔴 만료 유예 (2026-08-21) — 이미 나간 링크를 살리는 유일한 경로. 7일. */
const LINK_EXPIRY_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function createTicketLinkToken(input: {
  ticketNumber: string;
  expiresAt?: number;
}): string {
  const payload: TicketLinkPayload = {
    t: input.ticketNumber,
    e: input.expiresAt ?? Date.now() + DEFAULT_TTL_MS,
  };
  const encoded = toBase64Url(JSON.stringify(payload));
  return `${encoded}.${sign(encoded)}`;
}

/** 서명·만료·형식만 확인. 티켓번호·상태 대조는 `ticketLinkGrantsAccess` 가 한다. */
export function verifyTicketLinkToken(
  token: string | null | undefined,
): TicketLinkPayload | null {
  if (!token) return null;
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return null;

  const expected = sign(encoded);
  // 길이가 다르면 timingSafeEqual 이 throw 하므로 먼저 거른다.
  if (
    signature.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(fromBase64Url(encoded)) as TicketLinkPayload;
    if (typeof parsed.t !== "string" || !parsed.t) return null;
    if (typeof parsed.e !== "number") return null;
    // 🔴 만료에 유예를 둔다 (2026-08-21 대회 중 실사고).
    //    발급 만료가 `event_date + 1일` 인데 `event_date` 는 **행사 시작일**이라,
    //    다일 대회(8/20~23)에서 **둘째 날 아침에 이미 나간 링크가 전부 죽었다**.
    //    발급 쪽은 고쳤지만 이미 나간 토큰은 못 바꾼다 — 검증 쪽 유예가 유일한 복구다.
    //    ⚠️ 무제한이 아니다. 다일 대회 폭만큼만 연다.
    if (parsed.e + LINK_EXPIRY_GRACE_MS < Date.now()) return null;
    return { t: parsed.t, e: parsed.e };
  } catch {
    return null;
  }
}

/**
 * 열람 허용 판정 — (a)서명·만료 유효 (b)티켓번호 일치 (c)티켓 상태가 열람 가능.
 *
 * 🔴 (c)가 무효화 장치다. 환불(cancelled)·양도(transferred)·만료(expired) 티켓은
 *    링크가 남아 있어도 열리지 않는다. 이 조건을 느슨하게 하면 **환불된 티켓의
 *    QR 이 계속 보이고** 현장에서 분쟁이 난다.
 */
export function ticketLinkGrantsAccess(input: {
  token: string | null | undefined;
  ticketNumber: string;
  status: string | null | undefined;
}): boolean {
  if (!ticketLinkTokenMatches(input)) return false;
  return VIEWABLE_STATUSES.has(String(input.status ?? "").toLowerCase());
}

/**
 * 토큰이 **이 티켓의 것인지**만 본다 — 상태는 보지 않는다.
 *
 * ## 🔴 왜 나눴나 (2026-08-01 대표 제보)
 * 환불한 구매자가 알림톡 버튼을 누르면 이런 일이 벌어졌다:
 *
 *     알림톡 클릭 → "취소·양도되었거나 기간이 지난 티켓입니다"
 *                 → 이메일·전화 입력 요구
 *                 → 매직링크 메일 → 클릭 → 목록(15분 쿠키)
 *
 * **「당신 티켓은 취소됐습니다」 한 줄을 알려주려고 신원확인을 시키고 있었다.**
 * 자기 알림톡으로 들어온 사람인데도. 그 여정 끝에 목록이 비면(쿠키 만료·다른 기기)
 * 아무것도 못 보고 끝난다 — 대표 실사용에서 그렇게 됐다.
 *
 * ⟹ **상태만 알려주는 것은 티켓을 여는 것이 아니다.** 서명이 맞고 티켓번호가 맞으면
 *    "취소되었습니다" 는 그 자리에서 말해준다. QR·좌석·연락처는 여전히 안 준다
 *    (`ticketLinkGrantsAccess` 가 그걸 지킨다).
 *
 * ⚠️ 이 함수로 **열람 허용을 판단하지 말 것.** 이름 그대로 "토큰이 이 티켓 것인가" 만이다.
 */
export function ticketLinkTokenMatches(input: {
  token: string | null | undefined;
  ticketNumber: string;
}): boolean {
  const payload = verifyTicketLinkToken(input.token);
  if (!payload) return false;
  return payload.t === input.ticketNumber;
}

/** 알림톡 버튼에 실을 절대 URL. 승인 템플릿의 링크 형식과 **정확히** 같아야 한다. */
export function buildTicketLinkUrl(input: {
  origin: string;
  ticketNumber: string;
  token: string;
}): string {
  const origin = input.origin.replace(/\/$/, "");
  return `${origin}/tickets/${encodeURIComponent(input.ticketNumber)}?${TICKET_LINK_PARAM}=${input.token}`;
}
