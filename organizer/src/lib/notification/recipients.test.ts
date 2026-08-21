import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * W3-MSG 회귀 — 발송 수신자 해석의 **fail-closed** 계약.
 *
 * 이 파일이 지키는 것(전부 과거에 실제로 터졌거나, 터지면 즉시 사고인 것):
 *  1. 🔴 **블랙리스트/수신거부 조회 실패 → throw**. "조회 실패 → 빈 억제목록 → 전원 발송"이
 *     되면 수신거부자에게 광고가 나간다. 이 프로젝트에서 "실패 → 빈 목록" 결함은 이미
 *     두 번 났다(lotteryWon·productIds 세그먼트).
 *  2. 억제된 연락처는 실제로 **제외**된다(정규화 규칙 일치: 이메일 소문자·전화 숫자만).
 *  3. 미리보기 카운트(countSegment)와 실발송 대상(resolveSegment)이 **같은 집합**을 본다.
 *  4. 구 CRM 블랙리스트(tier='blacklist')를 대체하는 `channel='all'` 억제가 통한다
 *     — 이는 v2 질의의 `channel IN (ch,'all')` 계약에 달려 있으므로 계약을 못박는다.
 */

const h = vi.hoisted(() => {
  class MockComplianceError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "V2MessagingComplianceError";
    }
  }
  return {
    query: vi.fn(),
    fetchSuppressedContacts: vi.fn(),
    fetchWonOrderRefs: vi.fn(),
    fetchTicketIdsByProductRefs: vi.fn(),
    MockComplianceError,
  };
});

vi.mock("@/lib/db/pool", () => ({ getPool: () => ({ query: h.query }) }));
vi.mock("@/lib/v2/messaging-compliance-client", () => ({
  fetchSuppressedContacts: h.fetchSuppressedContacts,
  V2MessagingComplianceError: h.MockComplianceError,
}));
vi.mock("@/lib/v2/lottery-won-entries", () => ({
  fetchWonOrderRefs: h.fetchWonOrderRefs,
  V2LotteryWonEntriesError: class extends Error {},
}));
vi.mock("@/lib/v2/segment-tickets", () => ({
  fetchTicketIdsByProductRefs: h.fetchTicketIdsByProductRefs,
  V2SegmentTicketsError: class extends Error {},
}));

import { countSegment, resolveSegment } from "./recipients";

const ACCOUNT = "acc-1";
const EVENT = "evt-1";

function rows(...list: Array<{ id: string; email?: string | null; phone?: string | null }>) {
  return {
    rows: list.map((r) => ({
      id: r.id,
      name: null,
      email: r.email ?? null,
      phone: r.phone ?? null,
    })),
  };
}

beforeEach(() => {
  h.query.mockReset();
  h.fetchSuppressedContacts.mockReset();
  h.fetchWonOrderRefs.mockReset();
  h.fetchTicketIdsByProductRefs.mockReset();
});

describe("🔴 블랙리스트/수신거부 fail-closed", () => {
  it("억제 원장 조회가 실패하면 수신자를 반환하지 않고 던진다 (전원 발송 금지)", async () => {
    h.query.mockResolvedValue(rows({ id: "a1", email: "a@x.com" }, { id: "a2", email: "b@x.com" }));
    h.fetchSuppressedContacts.mockRejectedValue(
      new h.MockComplianceError("커머스 연결 실패"),
    );

    await expect(resolveSegment(ACCOUNT, EVENT, "email", {})).rejects.toBeInstanceOf(
      h.MockComplianceError,
    );
  });

  it("미리보기 카운트도 같은 실패를 삼키지 않는다 (0명 = 성공 위장 금지)", async () => {
    h.query.mockResolvedValue(rows({ id: "a1", email: "a@x.com" }));
    h.fetchSuppressedContacts.mockRejectedValue(new h.MockComplianceError("커머스 연결 실패"));

    await expect(countSegment(ACCOUNT, EVENT, "email", {})).rejects.toBeInstanceOf(
      h.MockComplianceError,
    );
  });

  it("커머스 미설정(연동 env 없음)도 실패로 취급된다", async () => {
    h.query.mockResolvedValue(rows({ id: "a1", email: "a@x.com" }));
    h.fetchSuppressedContacts.mockRejectedValue(
      new h.MockComplianceError("커머스 연동이 설정되지 않아 수신거부/수신동의를 확인할 수 없습니다"),
    );

    await expect(resolveSegment(ACCOUNT, EVENT, "email", {})).rejects.toThrow(
      /수신거부\/수신동의를 확인할 수 없습니다/,
    );
  });
});

describe("억제 제외가 실제로 동작한다", () => {
  it("억제된 이메일은 대상에서 빠진다", async () => {
    h.query.mockResolvedValue(
      rows({ id: "a1", email: "keep@x.com" }, { id: "a2", email: "drop@x.com" }),
    );
    h.fetchSuppressedContacts.mockResolvedValue(new Set(["drop@x.com"]));

    const out = await resolveSegment(ACCOUNT, EVENT, "email", {});
    expect(out.map((r) => r.id)).toEqual(["a1"]);
  });

  it("대소문자가 달라도 제외된다 (이메일 정규화 = 소문자)", async () => {
    h.query.mockResolvedValue(rows({ id: "a1", email: "Drop@X.com" }));
    h.fetchSuppressedContacts.mockResolvedValue(new Set(["drop@x.com"]));

    expect(await resolveSegment(ACCOUNT, EVENT, "email", {})).toEqual([]);
  });

  it("전화 하이픈이 달라도 제외된다 (전화 정규화 = 숫자만)", async () => {
    h.query.mockResolvedValue(rows({ id: "a1", phone: "010-1234-5678" }));
    h.fetchSuppressedContacts.mockResolvedValue(new Set(["01012345678"]));

    expect(await resolveSegment(ACCOUNT, EVENT, "sms", {})).toEqual([]);
  });

  it("알림톡 발송은 억제 원장 채널 'kakao' 로 조회한다 (구 SUP_CHANNEL 매핑 유지)", async () => {
    h.query.mockResolvedValue(rows({ id: "a1", phone: "01012345678" }));
    h.fetchSuppressedContacts.mockResolvedValue(new Set());

    await resolveSegment(ACCOUNT, EVENT, "alimtalk", {});
    expect(h.fetchSuppressedContacts).toHaveBeenCalledWith(
      ACCOUNT,
      "kakao",
      ["01012345678"],
    );
  });

  it("구 CRM 블랙리스트 대체 — channel='all' 억제도 v2 질의가 함께 잡는다(계약 명시)", async () => {
    // v2 filter_suppressed 는 channel IN (ch,'all') 로 조회하므로, go 는 발송 채널만 넘긴다.
    // 여기서 검증하는 것은 "go 가 'all' 을 따로 조회하지 않아도 되는 계약"이다.
    h.query.mockResolvedValue(rows({ id: "a1", email: "black@x.com" }));
    h.fetchSuppressedContacts.mockImplementation(async (_a, _ch, contacts: string[]) =>
      // v2 가 channel='all' 행으로 매칭해 돌려준 상황을 재현.
      new Set(contacts.map((c) => c.toLowerCase())),
    );

    expect(await resolveSegment(ACCOUNT, EVENT, "email", {})).toEqual([]);
  });
});

describe("카운트와 실발송이 같은 집합을 본다", () => {
  it("countSegment == resolveSegment().length (억제 후)", async () => {
    h.query.mockResolvedValue(
      rows(
        { id: "a1", email: "keep1@x.com" },
        { id: "a2", email: "drop@x.com" },
        { id: "a3", email: "keep2@x.com" },
      ),
    );
    h.fetchSuppressedContacts.mockResolvedValue(new Set(["drop@x.com"]));

    const listed = await resolveSegment(ACCOUNT, EVENT, "email", {});
    const counted = await countSegment(ACCOUNT, EVENT, "email", {});
    expect(counted).toBe(listed.length);
    expect(counted).toBe(2);
  });
});

describe("go crm_contacts 의존 소멸", () => {
  it("세그먼트 SQL 에 crm_contacts / message_suppressions 가 남아있지 않다", async () => {
    h.query.mockResolvedValue(rows({ id: "a1", email: "a@x.com" }));
    h.fetchSuppressedContacts.mockResolvedValue(new Set());

    await resolveSegment(ACCOUNT, EVENT, "email", { status: "checked_in" });
    const sql = String(h.query.mock.calls[0]?.[0] ?? "");
    expect(sql).not.toMatch(/crm_contacts/);
    expect(sql).not.toMatch(/message_suppressions/);
  });

  it("수신자가 0명이면 v2 억제 조회를 하지 않는다 (불필요한 왕복 방지)", async () => {
    h.query.mockResolvedValue({ rows: [] });
    expect(await resolveSegment(ACCOUNT, EVENT, "email", {})).toEqual([]);
    expect(h.fetchSuppressedContacts).not.toHaveBeenCalled();
  });
});
