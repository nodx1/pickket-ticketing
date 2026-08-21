import { afterEach, describe, expect, it, vi } from "vitest";

// v2 커머스 클라이언트 격리 (hoisted 홀더로 팩토리에서 참조)
// ⚠️ 에러 클래스도 hoisted 안에서 만들어야 한다 — vi.mock 팩토리는 파일 최상단으로 끌어올려지므로
//    바깥 `class` 선언을 참조하면 TDZ("Cannot access before initialization")로 깨진다.
const h = vi.hoisted(() => {
  class FakeV2Error extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
      this.name = "V2CommerceError";
    }
  }
  return {
    FakeV2Error,
    getEvent: vi.fn(),
    getEventBySlug: vi.fn(),
    listTiers: vi.fn(),
  };
});
const FakeV2Error = h.FakeV2Error;

vi.mock("@/lib/v2/commerce-client", () => ({
  V2CommerceError: h.FakeV2Error,
  getEvent: (...a: unknown[]) => h.getEvent(...a),
  getEventBySlug: (...a: unknown[]) => h.getEventBySlug(...a),
  listTiers: (...a: unknown[]) => h.listTiers(...a),
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import {
  EventAccessError,
  assertCommerceReadyForSale,
  getOwnedEvent,
  getPublicEventBySlugV2,
  requireOwnedEvent,
  resolveOwnedV2EventId,
  toV2EventId,
} from "@/lib/v2/event-access";

afterEach(() => {
  h.getEvent.mockReset();
  h.getEventBySlug.mockReset();
  h.listTiers.mockReset();
});

describe("toV2EventId", () => {
  it("ID 승격 — go event id 가 곧 v2 event id (DB/HTTP 왕복 없음)", () => {
    expect(toV2EventId("11111111-2222-3333-4444-555555555555")).toBe(
      "11111111-2222-3333-4444-555555555555",
    );
    expect(h.getEvent).not.toHaveBeenCalled();
  });
});

describe("getOwnedEvent — 테넌트 경계", () => {
  it("🔴 organizer_ref 를 v2 로 반드시 전달한다 (경계 강제의 유일한 수단)", async () => {
    h.getEvent.mockResolvedValue({ event_id: "e-1", enabled_features: [] });
    await getOwnedEvent("e-1", "acc-1");
    expect(h.getEvent).toHaveBeenCalledWith("e-1", { organizerRef: "acc-1" });
  });

  it("v2 404(없음 또는 타 계정 소유) → null", async () => {
    h.getEvent.mockRejectedValue(new FakeV2Error("event not found", 404));
    expect(await getOwnedEvent("e-1", "acc-1")).toBeNull();
  });

  it("🔴 v2 장애(5xx)를 'not found' 로 뭉개지 않는다 → EventAccessError(unavailable)", async () => {
    h.getEvent.mockRejectedValue(new FakeV2Error("boom", 503));
    await expect(getOwnedEvent("e-1", "acc-1")).rejects.toMatchObject({
      name: "EventAccessError",
      reason: "unavailable",
      status: 502,
    });
  });

  it("v2 외 예외는 그대로 전파(삼키지 않음)", async () => {
    h.getEvent.mockRejectedValue(new TypeError("프로그래밍 오류"));
    await expect(getOwnedEvent("e-1", "acc-1")).rejects.toBeInstanceOf(TypeError);
  });
});

describe("requireOwnedEvent", () => {
  it("없으면 not_found(404)로 던진다", async () => {
    h.getEvent.mockRejectedValue(new FakeV2Error("nf", 404));
    await expect(requireOwnedEvent("e-1", "acc-1")).rejects.toMatchObject({
      reason: "not_found",
      status: 404,
    });
  });

  it("있으면 상세를 반환", async () => {
    h.getEvent.mockResolvedValue({ event_id: "e-1", title: "행사" });
    await expect(requireOwnedEvent("e-1", "acc-1")).resolves.toMatchObject({ event_id: "e-1" });
  });
});

describe("resolveOwnedV2EventId — 앵커 조회 대체", () => {
  it("소유 확인 후 v2 event id 반환", async () => {
    h.getEvent.mockResolvedValue({ event_id: "e-1" });
    expect(await resolveOwnedV2EventId("e-1", "acc-1")).toBe("e-1");
  });

  it("🔴 타 계정 이벤트는 null — 크로스테넌트 누출 차단", async () => {
    h.getEvent.mockRejectedValue(new FakeV2Error("nf", 404));
    expect(await resolveOwnedV2EventId("e-1", "acc-attacker")).toBeNull();
  });

  it("v2 장애는 null 이 아니라 예외 — '없음'으로 오인해 진행하면 안 된다", async () => {
    h.getEvent.mockRejectedValue(new FakeV2Error("boom", 502));
    await expect(resolveOwnedV2EventId("e-1", "acc-1")).rejects.toBeInstanceOf(EventAccessError);
  });
});

describe("getPublicEventBySlugV2", () => {
  it("공개 조회는 organizer_ref 없이 전역 조회", async () => {
    h.getEventBySlug.mockResolvedValue({ event_id: "e-1", status: "live" });
    await getPublicEventBySlugV2("my-slug");
    expect(h.getEventBySlug).toHaveBeenCalledWith("my-slug");
  });

  it("404 → null", async () => {
    h.getEventBySlug.mockRejectedValue(new FakeV2Error("nf", 404));
    expect(await getPublicEventBySlugV2("nope")).toBeNull();
  });

  it("v2 장애 → EventAccessError(unavailable)", async () => {
    h.getEventBySlug.mockRejectedValue(new FakeV2Error("boom", 500));
    await expect(getPublicEventBySlugV2("s")).rejects.toMatchObject({ reason: "unavailable" });
  });
});

describe("assertCommerceReadyForSale", () => {
  it("판매가능 티어(capacity>0)가 있으면 통과", async () => {
    h.getEvent.mockResolvedValue({ event_id: "e-1" });
    h.listTiers.mockResolvedValue({ tiers: [{ capacity: 10 }] });
    await expect(assertCommerceReadyForSale("e-1", "acc-1")).resolves.toBeUndefined();
  });

  it("capacity 0 뿐이면 차단 — 재고 없는 '유령 이벤트' 공개 방지", async () => {
    h.getEvent.mockResolvedValue({ event_id: "e-1" });
    h.listTiers.mockResolvedValue({ tiers: [{ capacity: 0 }] });
    await expect(assertCommerceReadyForSale("e-1", "acc-1")).rejects.toThrow(/판매 정보/);
  });

  it("티어가 하나도 없으면 차단", async () => {
    h.getEvent.mockResolvedValue({ event_id: "e-1" });
    h.listTiers.mockResolvedValue({ tiers: [] });
    await expect(assertCommerceReadyForSale("e-1", "acc-1")).rejects.toThrow(/판매 정보/);
  });

  it("이벤트가 없거나 타 계정이면 차단", async () => {
    h.getEvent.mockRejectedValue(new FakeV2Error("nf", 404));
    await expect(assertCommerceReadyForSale("e-1", "acc-1")).rejects.toThrow(
      /이벤트를 찾을 수 없습니다/,
    );
    expect(h.listTiers).not.toHaveBeenCalled();
  });
});
