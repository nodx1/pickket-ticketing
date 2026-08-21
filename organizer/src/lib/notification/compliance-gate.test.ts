import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * W3-MSG 회귀 — 컴플라이언스 게이트가 **단건·배치에서 같은 판정**을 내는지.
 *
 * 배치 게이트(loadComplianceGate)는 v2 왕복을 줄이려는 최적화일 뿐이다. 여기서 규칙이
 * 갈라지면 "미리보기·단건 테스트는 막히는데 실제 대량발송은 나간다" 같은 최악의 형태가 된다.
 * 그래서 두 경로를 동일 시나리오로 교차 검증한다.
 *
 * 추가로 못박는 것: **동의 행 부재 = 미동의**(부재를 동의로 승격하면 무동의 광고발송).
 */

const h = vi.hoisted(() => ({
  fetchSuppressedContacts: vi.fn(),
  fetchConsents: vi.fn(),
  grantConsent: vi.fn(),
  revokeConsent: vi.fn(),
  upsertSuppression: vi.fn(),
}));

vi.mock("@/lib/v2/messaging-compliance-client", () => ({
  fetchSuppressedContacts: h.fetchSuppressedContacts,
  fetchConsents: h.fetchConsents,
  grantConsent: h.grantConsent,
  revokeConsent: h.revokeConsent,
  upsertSuppression: h.upsertSuppression,
  V2MessagingComplianceError: class extends Error {},
}));

import { canSendAd, canSendInfo, loadComplianceGate } from "./compliance";

const ACCOUNT = "acc-1";
const DAY = new Date("2026-07-01T03:00:00Z"); // 12:00 KST — 주간
const NIGHT = new Date("2026-07-01T13:00:00Z"); // 22:00 KST — 야간

beforeEach(() => {
  h.fetchSuppressedContacts.mockReset();
  h.fetchConsents.mockReset();
});

function consentMap(entries: Record<string, { consented: boolean; nightConsented: boolean }>) {
  return new Map(Object.entries(entries));
}

describe("배치 게이트 == 단건 게이트 (광고성)", () => {
  const cases: Array<{
    name: string;
    suppressed: string[];
    consents: Record<string, { consented: boolean; nightConsented: boolean }>;
    now: Date;
    expected: { ok: boolean; reason?: string };
  }> = [
    {
      name: "억제됨 → suppressed",
      suppressed: ["u@x.com"],
      consents: { "u@x.com": { consented: true, nightConsented: true } },
      now: DAY,
      expected: { ok: false, reason: "suppressed" },
    },
    {
      name: "동의 행 없음 → no_consent (부재를 동의로 승격 금지)",
      suppressed: [],
      consents: {},
      now: DAY,
      expected: { ok: false, reason: "no_consent" },
    },
    {
      name: "동의 철회(consented=false) → no_consent",
      suppressed: [],
      consents: { "u@x.com": { consented: false, nightConsented: true } },
      now: DAY,
      expected: { ok: false, reason: "no_consent" },
    },
    {
      name: "야간 + 야간동의 없음 → night",
      suppressed: [],
      consents: { "u@x.com": { consented: true, nightConsented: false } },
      now: NIGHT,
      expected: { ok: false, reason: "night" },
    },
    {
      name: "야간 + 야간동의 있음 → 통과",
      suppressed: [],
      consents: { "u@x.com": { consented: true, nightConsented: true } },
      now: NIGHT,
      expected: { ok: true },
    },
    {
      name: "주간 + 동의 → 통과",
      suppressed: [],
      consents: { "u@x.com": { consented: true, nightConsented: false } },
      now: DAY,
      expected: { ok: true },
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      h.fetchSuppressedContacts.mockResolvedValue(new Set(c.suppressed));
      h.fetchConsents.mockResolvedValue(consentMap(c.consents));

      const single = await canSendAd(ACCOUNT, "email", "U@X.com", c.now);
      const gate = await loadComplianceGate(ACCOUNT, "email", "advertising", ["U@X.com"], c.now);
      const batch = gate("U@X.com");

      expect(single.ok).toBe(c.expected.ok);
      expect(single.reason).toBe(c.expected.reason);
      // 🔴 두 경로가 갈라지면 대량발송만 게이트를 빠져나간다.
      expect(batch).toEqual(single);
    });
  }
});

describe("정보성(거래) 게이트", () => {
  it("배달불가(bounce/complaint)만 조회한다 — 마케팅 거부는 거래알림을 막지 않는다", async () => {
    h.fetchSuppressedContacts.mockResolvedValue(new Set());
    await loadComplianceGate(ACCOUNT, "email", "informational", ["a@x.com"]);
    expect(h.fetchSuppressedContacts).toHaveBeenCalledWith(
      ACCOUNT,
      "email",
      ["a@x.com"],
      { undeliverableOnly: true },
    );
  });

  it("정보성은 동의 원장을 조회하지 않는다(불필요한 왕복 방지)", async () => {
    h.fetchSuppressedContacts.mockResolvedValue(new Set());
    await loadComplianceGate(ACCOUNT, "email", "informational", ["a@x.com"]);
    expect(h.fetchConsents).not.toHaveBeenCalled();
  });

  it("배달불가면 단건·배치 모두 차단", async () => {
    h.fetchSuppressedContacts.mockResolvedValue(new Set(["hard@x.com"]));
    const gate = await loadComplianceGate(ACCOUNT, "email", "informational", ["hard@x.com"]);
    expect(gate("hard@x.com")).toEqual({ ok: false, reason: "suppressed" });
    expect(await canSendInfo(ACCOUNT, "email", "hard@x.com")).toBe(false);
  });

  it("광고성 배치는 억제를 전 사유로 조회한다(수신거부 포함)", async () => {
    h.fetchSuppressedContacts.mockResolvedValue(new Set());
    h.fetchConsents.mockResolvedValue(new Map());
    await loadComplianceGate(ACCOUNT, "sms", "advertising", ["01011112222"]);
    expect(h.fetchSuppressedContacts).toHaveBeenCalledWith(
      ACCOUNT,
      "sms",
      ["01011112222"],
      { undeliverableOnly: false },
    );
  });
});

describe("🔴 배치 게이트 fail-closed", () => {
  it("억제 조회 실패는 게이트를 만들지 않고 던진다 (부분 통과 게이트 금지)", async () => {
    h.fetchSuppressedContacts.mockRejectedValue(new Error("v2 down"));
    await expect(
      loadComplianceGate(ACCOUNT, "email", "informational", ["a@x.com"]),
    ).rejects.toThrow(/v2 down/);
  });

  it("동의 조회 실패도 던진다", async () => {
    h.fetchSuppressedContacts.mockResolvedValue(new Set());
    h.fetchConsents.mockRejectedValue(new Error("v2 down"));
    await expect(
      loadComplianceGate(ACCOUNT, "email", "advertising", ["a@x.com"]),
    ).rejects.toThrow(/v2 down/);
  });
});

describe("배치 게이트는 왕복 수를 상수로 유지한다", () => {
  it("수신자 500명이어도 억제 1회 + 동의 1회", async () => {
    const contacts = Array.from({ length: 500 }, (_, i) => `u${i}@x.com`);
    h.fetchSuppressedContacts.mockResolvedValue(new Set());
    h.fetchConsents.mockResolvedValue(new Map());
    await loadComplianceGate(ACCOUNT, "email", "advertising", contacts);
    expect(h.fetchSuppressedContacts).toHaveBeenCalledTimes(1);
    expect(h.fetchConsents).toHaveBeenCalledTimes(1);
  });
});
