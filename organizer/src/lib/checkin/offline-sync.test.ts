import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OfflineCheckIn } from "./offline-store";

// §13 오프라인 큐 동기화 — 성공/충돌/실패 3분류. store 는 모킹(IndexedDB 불필요).

const { listPending, updateQueueItem, deleteQueueItem } = vi.hoisted(() => ({
  listPending: vi.fn(),
  updateQueueItem: vi.fn(),
  deleteQueueItem: vi.fn(),
}));

vi.mock("./offline-store", () => ({ listPending, updateQueueItem, deleteQueueItem }));

import { syncOfflineQueue, type PostOutcome } from "./offline-sync";

function pendingItem(overrides: Partial<OfflineCheckIn> = {}): OfflineCheckIn {
  return {
    localId: overrides.localId ?? "id-1",
    eventId: "event-1",
    checkInListId: "11111111-1111-4111-8111-111111111111",
    ticketNumber: overrides.ticketNumber ?? "TCKT-1",
    guestName: overrides.guestName ?? "홍길동",
    checkedInAt: "2026-08-20T01:00:00.000Z",
    staffLabel: "스태프",
    mode: "offline",
    syncState: "pending",
    syncMessage: null,
    createdAt: 1,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  updateQueueItem.mockResolvedValue(undefined);
  deleteQueueItem.mockResolvedValue(undefined);
});

describe("syncOfflineQueue", () => {
  it("성공(2xx)은 큐에서 삭제·synced 집계", async () => {
    listPending.mockResolvedValue([pendingItem()]);
    const poster = vi.fn(async (): Promise<PostOutcome> => ({ ok: true, status: 200, error: null }));
    const result = await syncOfflineQueue("event-1", poster);
    expect(result.synced).toBe(1);
    expect(result.conflict).toBe(0);
    expect(result.failed).toBe(0);
    expect(deleteQueueItem).toHaveBeenCalledWith("id-1");
    expect(updateQueueItem).not.toHaveBeenCalled();
  });

  it("서버 거부(4xx)는 conflict 로 표시·큐 유지(리뷰 표면화)", async () => {
    listPending.mockResolvedValue([pendingItem({ localId: "id-2" })]);
    const poster = vi.fn(async (): Promise<PostOutcome> => ({ ok: false, status: 400, error: "이미 입장/취소된 티켓" }));
    const result = await syncOfflineQueue("event-1", poster);
    expect(result.conflict).toBe(1);
    expect(result.synced).toBe(0);
    expect(deleteQueueItem).not.toHaveBeenCalled();
    expect(updateQueueItem).toHaveBeenCalledWith("id-2", { syncState: "conflict", syncMessage: "이미 입장/취소된 티켓" });
    expect(result.items[0]?.outcome).toBe("conflict");
  });

  it("네트워크/서버 오류(5xx·0)는 pending 유지·재시도 대상(failed 집계)", async () => {
    listPending.mockResolvedValue([pendingItem({ localId: "id-3" })]);
    const poster = vi.fn(async (): Promise<PostOutcome> => ({ ok: false, status: 0, error: "네트워크 오류" }));
    const result = await syncOfflineQueue("event-1", poster);
    expect(result.failed).toBe(1);
    expect(deleteQueueItem).not.toHaveBeenCalled();
    expect(updateQueueItem).toHaveBeenCalledWith("id-3", { syncState: "pending", syncMessage: "네트워크 오류" });
  });

  it("혼합 배치: 성공·충돌·실패를 각각 정확 분류", async () => {
    listPending.mockResolvedValue([
      pendingItem({ localId: "ok" }),
      pendingItem({ localId: "conflict" }),
      pendingItem({ localId: "fail" }),
    ]);
    const poster = vi.fn(async (item): Promise<PostOutcome> => {
      if (item.localId === "ok") return { ok: true, status: 200, error: null };
      if (item.localId === "conflict") return { ok: false, status: 409, error: "중복" };
      return { ok: false, status: 503, error: "서버 오류" };
    });
    const result = await syncOfflineQueue("event-1", poster);
    expect(result).toMatchObject({ synced: 1, conflict: 1, failed: 1 });
    expect(deleteQueueItem).toHaveBeenCalledTimes(1);
    expect(deleteQueueItem).toHaveBeenCalledWith("ok");
  });

  it("빈 큐는 무동작", async () => {
    listPending.mockResolvedValue([]);
    const poster = vi.fn();
    const result = await syncOfflineQueue("event-1", poster);
    expect(result).toEqual({ synced: 0, conflict: 0, failed: 0, items: [] });
    expect(poster).not.toHaveBeenCalled();
  });
});
