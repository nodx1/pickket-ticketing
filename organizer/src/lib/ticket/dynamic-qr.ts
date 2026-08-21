import crypto from "crypto";
import { getRuntimeSecret } from "@/lib/env.server";

const WINDOW_SECONDS = 30;

function getQrSecret() {
  return getRuntimeSecret("QR_SECRET", "pickket-qr-secret-key");
}

/** 현재 30초 창 번호. */
function currentWindow(now: number = Date.now()): number {
  return Math.floor(now / (WINDOW_SECONDS * 1000));
}

/**
 * 🔴 앞으로 쓸 창들의 코드를 **미리** 만든다 — 오프라인 대비.
 *
 * 종전엔 30초마다 서버를 불러야 새 QR 을 받았다. 골프장처럼 LTE 가 끊기는 곳에서는
 * 그 호출이 실패해 **QR 이 죽고 입장이 막힌다**. 티켓마스터(SafeTix)·지갑 패스도
 * 같은 이유로 단말이 미리 여러 코드를 들고 있는다.
 *
 * 보안: 응답 하나를 가로채면 count 개 창의 코드를 얻는다. 다만 **링크 자체가 이미
 * 무제한 발급권**이므로 실질적 약화가 아니다(링크가 있으면 언제든 새로 받는다).
 */
export function generateDynamicQRPayloads(
  ticketId: string,
  count: number,
  now: number = Date.now(),
): Array<{ window: number; payload: string }> {
  const n = Math.max(1, Math.min(Math.floor(count) || 1, MAX_PREFETCH_WINDOWS));
  const base = currentWindow(now);
  return Array.from({ length: n }, (_, i) => ({
    window: base + i,
    payload: buildPayload(ticketId, base + i),
  }));
}

/** 선발급 상한 — 무제한이면 한 응답으로 사실상 영구 코드가 나간다. 20창 = 10분치. */
export const MAX_PREFETCH_WINDOWS = 20;

function buildPayload(ticketId: string, timestamp: number): string {
  const data = `${ticketId}:${timestamp}`;
  const hmac = crypto
    .createHmac("sha256", getQrSecret())
    .update(data)
    .digest("hex")
    .slice(0, 16);
  return `PKT:${ticketId}:${timestamp}:${hmac}`;
}

export function generateDynamicQRPayload(ticketId: string): string {
  const timestamp = Math.floor(Date.now() / (WINDOW_SECONDS * 1000));
  const data = `${ticketId}:${timestamp}`;
  const hmac = crypto
    .createHmac("sha256", getQrSecret())
    .update(data)
    .digest("hex")
    .slice(0, 16);
  return `PKT:${ticketId}:${timestamp}:${hmac}`;
}

/**
 * §13 QR 창 확대 킬스위치(golf/야외 LTE 대비):
 * 기본 tolerance 는 ±1창(현재창+직전창 = 60초). 관객 폰이 회전 QR 30초 갱신을 못 받는 상황
 * (셀룰러 끊김·화면 정지)에서 게이트 마비를 막기 위해, 스태프가 이벤트별로 수락 시간창을
 * 넓힐 수 있다. 넓힐수록 회전 QR 캡처방지 강도는 약해지므로 명시적 스태프 토글로만 확대한다.
 *
 * @param toleranceWindows 수락할 앞뒤 30초 창 개수(기본 1 = ±30초 = 총 60초). 예: 4 → 총 4분 30초.
 */
// 🔴 기본 허용창 = 5(±150초 = **총 5분**). 대표 결정(2026-07-29).
//    종전 1(총 60초)은 실내 공연 기준이라 **야외 골프장에서 게이트가 막힌다** —
//    LTE 가 끊기면 폰이 QR 을 갱신하지 못하고, 줄 서 있는 사이 만료된다.
//    캡처 유출 위험은 "5분 안에 만나 넘겨야 한다" 는 제약으로 실질 억제된다.
//    ⚠️ 이 값을 낮추면 현장 입장이 막히고, 올리면 캡처 재사용 창이 넓어진다.
const DEFAULT_TOLERANCE_WINDOWS = 5;
export const MAX_TOLERANCE_WINDOWS = 20; // ±20창 = 총 20분 30초 (상한 — 무제한 캡처방지 무력화 금지)

export function clampToleranceWindows(value: number | null | undefined): number {
  if (!Number.isFinite(value ?? NaN)) {
    return DEFAULT_TOLERANCE_WINDOWS;
  }
  const n = Math.floor(value as number);
  if (n < DEFAULT_TOLERANCE_WINDOWS) return DEFAULT_TOLERANCE_WINDOWS;
  if (n > MAX_TOLERANCE_WINDOWS) return MAX_TOLERANCE_WINDOWS;
  return n;
}

/**
 * 🔴 **서명만** 검증한다 — 시간창을 보지 않는다.
 *
 * 「위조」와 「만료」를 가르는 유일한 방법이다. `verifyDynamicQRPayload` 는 둘을 모두
 * `valid:false` 로 뭉치므로, 그것만으로는 30분 전에 만든 **정상 QR** 이 위조로 보고된다.
 * 게이트에서 그건 손님을 의심하게 만드는 오안내다.
 *
 * ⚠️ **입장 판정에 쓰지 말 것.** 시간창이 캡처방지의 본체다 — 이 함수만 보고 통과시키면
 *    스크린샷 한 장이 영구 입장권이 된다. 오직 **사유 분류**에만 쓴다.
 */
export function dynamicQRSignatureValid(payload: string): boolean {
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== "PKT") return false;
  const [, ticketId, timestampStr, receivedHmac] = parts;
  if (!ticketId || !timestampStr || !/^\d+$/.test(timestampStr)) return false;

  const expectedHmac = crypto
    .createHmac("sha256", getQrSecret())
    .update(`${ticketId}:${Number(timestampStr)}`)
    .digest("hex")
    .slice(0, 16);
  const received = Buffer.from(receivedHmac ?? "", "utf8");
  const expected = Buffer.from(expectedHmac, "utf8");
  if (received.length !== expected.length) return false;
  return crypto.timingSafeEqual(received, expected);
}

export function verifyDynamicQRPayload(
  payload: string,
  toleranceWindows: number = DEFAULT_TOLERANCE_WINDOWS,
): { valid: boolean; ticketId: string | null } {
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== "PKT") {
    return { valid: false, ticketId: null };
  }

  const [, ticketId, timestampStr, receivedHmac] = parts;
  const timestamp = Number(timestampStr);
  const currentTimestamp = Math.floor(Date.now() / (WINDOW_SECONDS * 1000));

  // 기본 ±1창(60초). 킬스위치로 확대 시 tolerance 창만큼 앞뒤 수락.
  const tolerance = clampToleranceWindows(toleranceWindows);
  if (Math.abs(currentTimestamp - timestamp) > tolerance) {
    return { valid: false, ticketId: ticketId ?? null };
  }

  const data = `${ticketId}:${timestamp}`;
  const expectedHmac = crypto
    .createHmac("sha256", getQrSecret())
    .update(data)
    .digest("hex")
    .slice(0, 16);

  // timingSafeEqual 은 길이 불일치 시 RangeError 를 throw 한다. 잘리거나 변조돼 길이가 다른
  // 위조 HMAC 이 들어오면 깔끔한 invalid(→ 400) 대신 미처리 예외(→ 500)가 되므로, 비교 전에
  // 길이를 먼저 확인한다(불일치 = 무효). 길이 비교는 비밀에 의존하지 않아 타이밍 누출 없음.
  const received = Buffer.from(receivedHmac ?? "", "utf8");
  const expected = Buffer.from(expectedHmac, "utf8");
  if (received.length !== expected.length) {
    return { valid: false, ticketId: ticketId ?? null };
  }

  const valid = crypto.timingSafeEqual(received, expected);

  return { valid, ticketId: ticketId ?? null };
}
