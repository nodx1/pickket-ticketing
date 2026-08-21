/**
 * Sentry 전송 전 PII 스크럽.
 *
 * email·phone·password·buyer·name·카드·주민번호 등 민감 필드를 마스킹해 외부(Sentry)로의
 * 개인정보 유출을 차단한다. request.data·extra·contexts·user·message·exception 값을 훑는다.
 * 스크럽 자체가 실패해도 이벤트 전송은 유지(가시성 우선)하되 최선의 마스킹을 시도한다. (감사 P1-22)
 */

const PII_KEY =
  /(email|phone|mobile|tel|passwd|password|secret|token|authorization|cookie|buyer|holder|birth|resident|card|account_no|ssn|name)/i;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const PHONE_RE = /\b01[016789][-\s]?\d{3,4}[-\s]?\d{4}\b/g;

function scrubString(s: string): string {
  return s.replace(EMAIL_RE, "[email]").replace(PHONE_RE, "[phone]");
}

function scrubValue(val: unknown, keyHint?: string): unknown {
  if (typeof val === "string") {
    if (keyHint && PII_KEY.test(keyHint)) return "[redacted]";
    return scrubString(val);
  }
  if (Array.isArray(val)) return val.map((v) => scrubValue(v));
  if (val && typeof val === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      out[k] = PII_KEY.test(k) ? "[redacted]" : scrubValue(v, k);
    }
    return out;
  }
  return val;
}

/**
 * Sentry `beforeSend` 훅. 제네릭으로 ErrorEvent 타입을 그대로 보존해 반환한다.
 */
export function scrubSentryEvent<T>(event: T): T {
  try {
    const e = event as Record<string, unknown>;

    const req = e.request as Record<string, unknown> | undefined;
    if (req) {
      if (req.data !== undefined) req.data = scrubValue(req.data);
      const headers = req.headers as Record<string, unknown> | undefined;
      if (headers) {
        delete headers.cookie;
        delete headers.authorization;
        delete headers["x-pickket-signature"];
      }
    }

    if (e.extra !== undefined) e.extra = scrubValue(e.extra) as Record<string, unknown>;
    if (e.contexts !== undefined) e.contexts = scrubValue(e.contexts) as Record<string, unknown>;

    const user = e.user as Record<string, unknown> | undefined;
    if (user) {
      if (user.email) user.email = "[redacted]";
      if (typeof user.username === "string") user.username = scrubString(user.username);
      delete user.ip_address;
    }

    if (typeof e.message === "string") e.message = scrubString(e.message);

    const exception = e.exception as { values?: Array<Record<string, unknown>> } | undefined;
    if (exception?.values) {
      for (const ex of exception.values) {
        if (typeof ex.value === "string") ex.value = scrubString(ex.value);
      }
    }
  } catch {
    /* 스크럽 실패해도 이벤트는 전송(가시성 우선) */
  }
  return event;
}
