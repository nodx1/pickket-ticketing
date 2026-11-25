/**
 * 브라우저 기기 식별값 — 과업 1-3) 계정 복제 차단(같은 기기 다중 계정 응모 탐지)용.
 *
 * 서버 응모 API(`/events/{id}/tiers/{tierId}/lottery/apply`)는 `X-Device-Fingerprint` 헤더를 읽어
 * 같은 이벤트·같은 식별값의 3번째 계정부터 응모를 거부한다(sanction_service.check_apply).
 *
 * 하드웨어·화면 정보를 긁는 지문이 아니라 **브라우저마다 처음 한 번 만드는 임의 값**이다.
 * localStorage 에 두므로 같은 브라우저에서 계정을 바꿔 로그인해도 같은 값이 나간다.
 * 저장소를 지우거나 사생활 보호 창을 쓰면 새 값이 된다(우회 가능 — 서버의 다른 신호와 함께 쓰는 보조 신호).
 * 저장소를 못 쓰는 환경에서는 null 을 돌려주고, 그때 서버는 기기 검사만 건너뛴다(응모는 막지 않는다).
 */
export const DEVICE_FINGERPRINT_HEADER = "X-Device-Fingerprint";
export const DEVICE_FINGERPRINT_STORAGE_KEY = "pickket_device_fp";

const VALID = /^[A-Za-z0-9-]{16,64}$/;

function newId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  if (c && typeof c.getRandomValues === "function") {
    const bytes = c.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`.padEnd(16, "0");
}

export function getDeviceFingerprint(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const saved = window.localStorage.getItem(DEVICE_FINGERPRINT_STORAGE_KEY);
    if (saved && VALID.test(saved)) return saved;
    const id = newId();
    window.localStorage.setItem(DEVICE_FINGERPRINT_STORAGE_KEY, id);
    return id;
  } catch {
    return null;
  }
}
