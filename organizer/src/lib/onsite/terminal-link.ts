/**
 * 직원 입장 링크 — 현장 직원이 휴대폰으로 열면 그 기기가 곧바로 입장 단말이 되는 주소.
 *
 * 링크 = `<피켓고>/terminal#k=<단말 키>`.
 *  - 키는 주소의 `#` 뒤(프래그먼트)에 둔다. 프래그먼트는 브라우저가 서버로 보내지 않아서
 *    접속 기록·Referer 에 키가 남지 않는다.
 *  - 단말 화면은 이 키를 기기에 저장한 뒤 주소에서 지운다(화면을 캡처하거나 공유해도 주소에 키가 없다).
 *  - 서버는 키를 해시로만 저장한다. 링크를 「다시 보기」는 없고, 새로 만들면 예전 링크가 끊긴다.
 */

export const TERMINAL_KEY_PREFIX = "pkt_term_";
// 서버가 만드는 키: "pkt_term_" + token_urlsafe(32) (43자). 너무 짧거나 다른 글자가 섞이면 받지 않는다.
const KEY_RE = /^pkt_term_[A-Za-z0-9_-]{20,128}$/;

export function isTerminalKey(value: string): boolean {
  return KEY_RE.test(value);
}

export function buildTerminalLink(origin: string, key: string): string {
  return `${origin.replace(/\/+$/, "")}/terminal#k=${encodeURIComponent(key)}`;
}

/** `location.hash` 에서 단말 키를 꺼낸다. 형식이 맞지 않으면 null. */
export function readTerminalKeyFromHash(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return null;
  const value = new URLSearchParams(raw).get("k")?.trim();
  return value && isTerminalKey(value) ? value : null;
}

/**
 * 카메라는 같은 QR 을 1초에 여러 번 읽는다. 같은 값은 `windowMs` 안에 한 번만 서버로 보낸다.
 * 다른 값(다음 관객)은 바로 보낸다. 이미 판정 중이면 기다린다.
 */
export function shouldSendScan(
  text: string,
  last: { text: string; at: number } | null,
  now: number,
  { inFlight = false, windowMs = 8_000 }: { inFlight?: boolean; windowMs?: number } = {},
): boolean {
  if (!text.trim() || inFlight) return false;
  if (last && last.text === text && now - last.at < windowMs) return false;
  return true;
}
