import crypto from "node:crypto";
import { getRuntimeSecret } from "@/lib/env.server";

export const PUBLIC_LOOKUP_COOKIE = "pickket_public_lookup";

type PublicLookupPayload = {
  email: string;
  phone: string;
  expiresAt: number;
};

function getSigningKey() {
  return getRuntimeSecret("SESSION_SIGNING_KEY", "pickket-dev-public-lookup");
}

function normalizePhone(phone: string) {
  return phone.replace(/\D/g, "");
}

function toBase64Url(input: string) {
  return Buffer.from(input).toString("base64url");
}

function fromBase64Url(input: string) {
  return Buffer.from(input, "base64url").toString("utf8");
}

function sign(data: string) {
  return crypto.createHmac("sha256", getSigningKey()).update(data).digest("base64url");
}

export function createPublicLookupToken(input: { email: string; phone: string; expiresInMs?: number }) {
  const payload: PublicLookupPayload = {
    email: input.email.trim().toLowerCase(),
    phone: normalizePhone(input.phone),
    expiresAt: Date.now() + (input.expiresInMs ?? 15 * 60 * 1000),
  };

  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signature = sign(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

export function verifyPublicLookupToken(token: string | null | undefined): PublicLookupPayload | null {
  if (!token) {
    return null;
  }

  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) {
    return null;
  }

  const expected = sign(encodedPayload);
  const validSignature =
    signature.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));

  if (!validSignature) {
    return null;
  }

  try {
    const parsed = JSON.parse(fromBase64Url(encodedPayload)) as PublicLookupPayload;
    if (!parsed.email || !parsed.phone || !parsed.expiresAt) {
      return null;
    }
    if (parsed.expiresAt < Date.now()) {
      return null;
    }

    return {
      email: parsed.email.trim().toLowerCase(),
      phone: normalizePhone(parsed.phone),
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

// ── 매직링크(이메일 소유증명) ─────────────────────────────────────────
// 공개 티켓 조회는 email+phone '지식'만으로 유효 체크인 QR 을 발급하면 안 된다(사칭 위험).
// 조회 요청 시 구매 이메일로 매직링크를 보내고, 링크 검증(=이메일 수신함 소유증명)을 통과해야
// PUBLIC_LOOKUP_COOKIE 를 발급한다. 매직토큰과 조회쿠키는 서명 스코프('magic:' prefix)가 달라
// 서로 대체 사용할 수 없다. (감사 P1-7)
export function createMagicLinkToken(input: { email: string; phone: string; expiresInMs?: number }) {
  const payload: PublicLookupPayload = {
    email: input.email.trim().toLowerCase(),
    phone: normalizePhone(input.phone),
    expiresAt: Date.now() + (input.expiresInMs ?? 15 * 60 * 1000),
  };
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signature = sign(`magic:${encodedPayload}`);
  return `${encodedPayload}.${signature}`;
}

export function verifyMagicLinkToken(token: string | null | undefined): PublicLookupPayload | null {
  if (!token) return null;
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) return null;

  const expected = sign(`magic:${encodedPayload}`);
  const validSignature =
    signature.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  if (!validSignature) return null;

  try {
    const parsed = JSON.parse(fromBase64Url(encodedPayload)) as PublicLookupPayload;
    if (!parsed.email || !parsed.phone || !parsed.expiresAt) return null;
    if (parsed.expiresAt < Date.now()) return null;
    return {
      email: parsed.email.trim().toLowerCase(),
      phone: normalizePhone(parsed.phone),
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

export function matchesPublicLookup(
  lookup: PublicLookupPayload | null,
  target: { email: string | null; phone: string | null },
) {
  if (!lookup || !target.email || !target.phone) {
    return false;
  }

  return (
    lookup.email === target.email.trim().toLowerCase() &&
    lookup.phone === normalizePhone(target.phone)
  );
}
