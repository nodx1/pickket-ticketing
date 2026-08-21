import { beforeEach, describe, expect, it, vi } from "vitest";
import { calculateRefund } from "./calculator";

// v2 커머스 클라이언트/이벤트 접근을 모킹해 헬퍼의 해석·**실패 전파**만 검증(네트워크 불요).
const getRefundPolicy = vi.fn();
const putRefundPolicy = vi.fn();
const deleteRefundPolicy = vi.fn();
const requireOwnedEvent = vi.fn();

class FakeV2CommerceError extends Error {
  constructor(message: string, readonly status: number, readonly body?: string) {
    super(message);
    this.name = "V2CommerceError";
  }
}

class FakeEventAccessError extends Error {
  constructor(
    message: string,
    readonly reason: "not_found" | "unavailable",
    readonly status: number,
  ) {
    super(message);
    this.name = "EventAccessError";
  }
}

vi.mock("@/lib/v2/commerce-client", () => ({
  V2CommerceError: FakeV2CommerceError,
  getRefundPolicy: (...args: unknown[]) => getRefundPolicy(...args),
  putRefundPolicy: (...args: unknown[]) => putRefundPolicy(...args),
  deleteRefundPolicy: (...args: unknown[]) => deleteRefundPolicy(...args),
}));

vi.mock("@/lib/v2/event-access", () => ({
  EventAccessError: FakeEventAccessError,
  requireOwnedEvent: (...args: unknown[]) => requireOwnedEvent(...args),
}));

const {
  getEventRefundRules,
  saveEventRefundRules,
  clearEventRefundRules,
  refundPolicyErrorStatus,
} = await import("./policy");

beforeEach(() => {
  vi.clearAllMocks();
  requireOwnedEvent.mockResolvedValue({ event_id: "v2-ev" });
});

describe("getEventRefundRules (환불 규칙 조회 — 표시=적용 SSOT)", () => {
  it("커스텀 정책 있으면 rules 배열 반환", async () => {
    const rules = [{ daysBefore: 5, percent: 50, label: "D-5" }];
    getRefundPolicy.mockResolvedValue({ policy: { rules } });
    await expect(getEventRefundRules("acc", "ev")).resolves.toEqual(rules);
  });

  it("커스텀 정책 없으면 undefined 반환(→ 기본규칙 사용)", async () => {
    getRefundPolicy.mockResolvedValue({ policy: null });
    await expect(getEventRefundRules("acc", "ev")).resolves.toBeUndefined();
  });

  it("규칙이 빈 배열이면 undefined(→ 기본규칙) — '규칙 0개=전면 환불불가'로 오독 금지", async () => {
    getRefundPolicy.mockResolvedValue({ policy: { rules: [] } });
    await expect(getEventRefundRules("acc", "ev")).resolves.toBeUndefined();
  });

  it("🔴 v2 장애를 '정책 없음'으로 흡수하지 않고 던진다", async () => {
    getRefundPolicy.mockRejectedValue(new FakeV2CommerceError("boom", 503));
    await expect(getEventRefundRules("acc", "ev")).rejects.toBeInstanceOf(FakeV2CommerceError);
  });

  it("🔴 이벤트 접근 실패(미소유·v2장애)도 던진다", async () => {
    requireOwnedEvent.mockRejectedValue(
      new FakeEventAccessError("unavailable", "unavailable", 502),
    );
    await expect(getEventRefundRules("acc", "ev")).rejects.toBeInstanceOf(FakeEventAccessError);
  });
});

describe("saveEventRefundRules / clearEventRefundRules (go 에 없던 write 경로)", () => {
  it("저장은 v2 upsert 로 전달되고 저장된 rules 를 돌려준다", async () => {
    const rules = [{ daysBefore: 3, percent: 30, label: "D-3" }];
    putRefundPolicy.mockResolvedValue({ rules });
    await expect(saveEventRefundRules("acc", "ev", { title: "정책", rules })).resolves.toEqual(
      rules,
    );
    expect(putRefundPolicy).toHaveBeenCalledWith(
      "v2-ev",
      expect.objectContaining({ title: "정책", rules }),
    );
  });

  it("제거: 커스텀 정책이 없으면 false(404) — 그 외 실패는 던진다", async () => {
    deleteRefundPolicy.mockRejectedValueOnce(new FakeV2CommerceError("none", 404));
    await expect(clearEventRefundRules("acc", "ev")).resolves.toBe(false);

    deleteRefundPolicy.mockRejectedValueOnce(new FakeV2CommerceError("down", 503));
    await expect(clearEventRefundRules("acc", "ev")).rejects.toBeInstanceOf(FakeV2CommerceError);
  });
});

describe("refundPolicyErrorStatus (fail-closed 매핑)", () => {
  it("미소유/미존재는 404, v2 장애는 503, 그 외는 null", () => {
    expect(refundPolicyErrorStatus(new FakeEventAccessError("x", "not_found", 404))).toBe(404);
    expect(refundPolicyErrorStatus(new FakeEventAccessError("x", "unavailable", 502))).toBe(503);
    expect(refundPolicyErrorStatus(new FakeV2CommerceError("x", 404))).toBe(404);
    expect(refundPolicyErrorStatus(new FakeV2CommerceError("x", 500))).toBe(503);
    expect(refundPolicyErrorStatus(new Error("unrelated"))).toBeNull();
  });
});

describe("표시=적용 일치 회귀 (감사 P0-6)", () => {
  const start = new Date("2026-08-01T00:00:00Z");
  const now = new Date("2026-07-27T00:00:00Z"); // D-5

  it("커스텀 규칙이 있으면 표시(page)와 적용(refund API)이 같은 rules 로 동일 결과", async () => {
    const customRules = [
      { daysBefore: 7, percent: 30, label: "D-7" },
      { daysBefore: 3, percent: 10, label: "D-3" },
    ];
    getRefundPolicy.mockResolvedValue({ policy: { rules: customRules } });
    const rulesFromHelper = await getEventRefundRules("acc", "ev");

    // 두 경로가 같은 rules 를 쓰면 계산 결과도 동일.
    const displayed = calculateRefund(start, 10000, now, rulesFromHelper);
    const applied = calculateRefund(start, 10000, now, rulesFromHelper);
    expect(displayed).toEqual(applied);
    // days=5: 5>=7 false, 5>=3 true → D-3 규칙(10%) 매칭. 기본규칙(D-3~D-7=80%)과 다른 커스텀 결과여야 결함 재현.
    expect(displayed.refundPercent).toBe(10);
    expect(displayed.refundAmount).toBe(1000);
  });

  it("기본규칙만(커스텀 없음) 경로도 표시=적용 동일", async () => {
    getRefundPolicy.mockResolvedValue({ policy: null });
    const rulesFromHelper = await getEventRefundRules("acc", "ev");
    const displayed = calculateRefund(start, 10000, now, rulesFromHelper);
    const applied = calculateRefund(start, 10000, now, rulesFromHelper);
    expect(displayed).toEqual(applied);
  });
});
