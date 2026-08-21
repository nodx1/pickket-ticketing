import { afterEach, describe, expect, it, vi } from "vitest";

// ⚠️ 에러 클래스도 hoisted 안에서 — vi.mock 팩토리가 최상단으로 끌어올려져 TDZ 를 피해야 한다.
const h = vi.hoisted(() => {
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
  return { FakeEventAccessError, getOwnedEvent: vi.fn() };
});
const FakeEventAccessError = h.FakeEventAccessError;

vi.mock("@/lib/v2/event-access", () => ({
  EventAccessError: h.FakeEventAccessError,
  getOwnedEvent: (...a: unknown[]) => h.getOwnedEvent(...a),
}));

import { requireFeature } from "@/lib/server/require-feature";

afterEach(() => h.getOwnedEvent.mockReset());

async function bodyOf(res: Response): Promise<{ error?: string }> {
  return (await res.json()) as { error?: string };
}

describe("requireFeature — 기능 게이트(v2 정본)", () => {
  it("기능이 켜져 있으면 통과(null)", async () => {
    h.getOwnedEvent.mockResolvedValue({ enabled_features: ["participants", "facilities"] });
    expect(await requireFeature("e-1", "acc-1", "facilities")).toBeNull();
  });

  it("🔴 소유 검증은 v2 로 위임 — accountId 를 반드시 전달한다", async () => {
    h.getOwnedEvent.mockResolvedValue({ enabled_features: [] });
    await requireFeature("e-1", "acc-1", "facilities");
    expect(h.getOwnedEvent).toHaveBeenCalledWith("e-1", "acc-1");
  });

  it("기능이 꺼져 있으면 403", async () => {
    h.getOwnedEvent.mockResolvedValue({ enabled_features: ["participants"] });
    const res = await requireFeature("e-1", "acc-1", "facilities");
    expect(res?.status).toBe(403);
    expect((await bodyOf(res as Response)).error).toMatch(/활성화되지 않았습니다/);
  });

  it("이벤트가 없거나 타 계정 소유면 404", async () => {
    h.getOwnedEvent.mockResolvedValue(null);
    const res = await requireFeature("e-1", "acc-attacker", "facilities");
    expect(res?.status).toBe(404);
  });

  it("🔴 v2 장애 시 fail-closed — 503 으로 차단하지 통과시키지 않는다", async () => {
    h.getOwnedEvent.mockRejectedValue(
      new FakeEventAccessError("v2 down", "unavailable", 502),
    );
    const res = await requireFeature("e-1", "acc-1", "facilities");
    expect(res).not.toBeNull();
    expect(res?.status).toBe(503);
  });

  it("enabled_features 가 배열이 아니면 전부 차단(오염 입력 fail-closed)", async () => {
    h.getOwnedEvent.mockResolvedValue({ enabled_features: undefined });
    const res = await requireFeature("e-1", "acc-1", "facilities");
    expect(res?.status).toBe(403);
  });

  it("예상 못 한 예외는 삼키지 않고 전파", async () => {
    h.getOwnedEvent.mockRejectedValue(new TypeError("프로그래밍 오류"));
    await expect(requireFeature("e-1", "acc-1", "facilities")).rejects.toBeInstanceOf(TypeError);
  });
});
