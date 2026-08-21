import { beforeAll, describe, expect, it } from "vitest";
import { makeWaitlistOfferToken, verifyWaitlistOfferToken } from "./offer-token";

beforeAll(() => {
  process.env.WAITLIST_OFFER_SECRET = "test-waitlist-secret-fixed";
});

const entryId = "11111111-1111-1111-1111-111111111111";

describe("대기자 구매 제안 토큰", () => {
  it("서명 후 검증하면 동일 claims 를 복원한다", () => {
    const expiresAtMs = Date.now() + 60_000;
    const token = makeWaitlistOfferToken({ entryId, expiresAtMs, version: 3 });
    const claims = verifyWaitlistOfferToken(token);
    expect(claims).not.toBeNull();
    expect(claims?.entryId).toBe(entryId);
    expect(claims?.expiresAtMs).toBe(expiresAtMs);
    expect(claims?.version).toBe(3);
  });

  it("변조된 토큰은 null(서명 불일치)", () => {
    const token = makeWaitlistOfferToken({ entryId, expiresAtMs: Date.now() + 1000, version: 0 });
    const decoded = Buffer.from(token, "base64url").toString();
    // payload 의 version 을 조작 → 서명 깨짐.
    const tampered = Buffer.from(decoded.replace(/:0:/, ":9:")).toString("base64url");
    expect(verifyWaitlistOfferToken(tampered)).toBeNull();
  });

  it("다른 시크릿으로 서명한 토큰은 검증 실패", () => {
    process.env.WAITLIST_OFFER_SECRET = "other-secret";
    const token = makeWaitlistOfferToken({ entryId, expiresAtMs: Date.now() + 1000, version: 0 });
    process.env.WAITLIST_OFFER_SECRET = "test-waitlist-secret-fixed";
    expect(verifyWaitlistOfferToken(token)).toBeNull();
  });

  it("version 이 바뀌면 이전 토큰과 다른 값이 나온다(재발송 무효화 근거)", () => {
    const expiresAtMs = Date.now() + 1000;
    const v0 = makeWaitlistOfferToken({ entryId, expiresAtMs, version: 0 });
    const v1 = makeWaitlistOfferToken({ entryId, expiresAtMs, version: 1 });
    expect(v0).not.toBe(v1);
    expect(verifyWaitlistOfferToken(v0)?.version).toBe(0);
    expect(verifyWaitlistOfferToken(v1)?.version).toBe(1);
  });

  it("깨진 문자열은 null", () => {
    expect(verifyWaitlistOfferToken("not-a-real-token")).toBeNull();
    expect(verifyWaitlistOfferToken("")).toBeNull();
  });
});
