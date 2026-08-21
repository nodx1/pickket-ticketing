/**
 * offline-tickets 단위 테스트 — SecureStore QR 캐시 + TTL + 인덱스
 */
jest.mock("@/lib/storage", () => ({
  storage: {
    getSecure: jest.fn(),
    setSecure: jest.fn().mockResolvedValue(undefined),
    removeSecure: jest.fn().mockResolvedValue(undefined),
    get: jest.fn(),
    set: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
  },
}));

import { storage } from "@/lib/storage";

const mockStorage = storage as jest.Mocked<typeof storage>;

const { cacheTicketQr, getCachedTicketQr, clearOfflineQrCache } =
  require("@/lib/offline-tickets") as typeof import("@/lib/offline-tickets");

const mockQr = {
  ticket_id: "ticket-1",
  qr_data: "totp:abc123",
  expires_in_seconds: 15,
};

describe("offline-tickets", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("cacheTicketQr", () => {
    it("SecureStore에 QR 데이터 저장 + 인덱스 업데이트", async () => {
      mockStorage.get.mockResolvedValue(null); // 빈 인덱스

      await cacheTicketQr("ticket-1", mockQr);

      // SecureStore에 저장
      expect(mockStorage.setSecure).toHaveBeenCalledWith(
        "offline_qr_ticket-1",
        expect.stringContaining("totp:abc123"),
      );

      // 인덱스 업데이트
      expect(mockStorage.set).toHaveBeenCalledWith(
        "offline_qr_index",
        JSON.stringify(["ticket-1"]),
      );
    });

    it("기존 인덱스에 중복이면 인덱스 set 미호출", async () => {
      mockStorage.get.mockResolvedValue(JSON.stringify(["ticket-1"]));

      await cacheTicketQr("ticket-1", mockQr);

      // SecureStore에는 저장 (QR 데이터 업데이트)
      expect(mockStorage.setSecure).toHaveBeenCalledWith(
        "offline_qr_ticket-1",
        expect.any(String),
      );

      // 인덱스는 변경 없음 — set 미호출
      expect(mockStorage.set).not.toHaveBeenCalled();
    });

    it("기존 인덱스에 새 티켓 추가", async () => {
      mockStorage.get.mockResolvedValue(JSON.stringify(["ticket-1"]));

      await cacheTicketQr("ticket-2", mockQr);

      expect(mockStorage.set).toHaveBeenCalledWith(
        "offline_qr_index",
        JSON.stringify(["ticket-1", "ticket-2"]),
      );
    });
  });

  describe("getCachedTicketQr", () => {
    it("유효한 캐시 반환", async () => {
      const cached = { data: mockQr, cachedAt: Date.now() };
      mockStorage.getSecure.mockResolvedValue(JSON.stringify(cached));

      const result = await getCachedTicketQr("ticket-1");
      expect(result).toEqual(mockQr);
    });

    it("캐시 없으면 null", async () => {
      mockStorage.getSecure.mockResolvedValue(null);

      const result = await getCachedTicketQr("ticket-1");
      expect(result).toBeNull();
    });

    it("24시간 초과 캐시 → 삭제 후 null", async () => {
      const cached = { data: mockQr, cachedAt: Date.now() - 25 * 60 * 60 * 1000 };
      mockStorage.getSecure.mockResolvedValue(JSON.stringify(cached));
      mockStorage.get.mockResolvedValue(JSON.stringify(["ticket-1"]));

      const result = await getCachedTicketQr("ticket-1");
      expect(result).toBeNull();
      expect(mockStorage.removeSecure).toHaveBeenCalledWith("offline_qr_ticket-1");
    });

    it("파싱 실패 시 삭제 후 null", async () => {
      mockStorage.getSecure.mockResolvedValue("invalid-json{{{");
      mockStorage.get.mockResolvedValue(JSON.stringify(["ticket-1"]));

      const result = await getCachedTicketQr("ticket-1");
      expect(result).toBeNull();
      expect(mockStorage.removeSecure).toHaveBeenCalledWith("offline_qr_ticket-1");
    });
  });

  describe("clearOfflineQrCache", () => {
    it("인덱스의 모든 QR 캐시 삭제", async () => {
      mockStorage.get.mockResolvedValue(JSON.stringify(["t-1", "t-2", "t-3"]));

      await clearOfflineQrCache();

      expect(mockStorage.removeSecure).toHaveBeenCalledWith("offline_qr_t-1");
      expect(mockStorage.removeSecure).toHaveBeenCalledWith("offline_qr_t-2");
      expect(mockStorage.removeSecure).toHaveBeenCalledWith("offline_qr_t-3");
      expect(mockStorage.remove).toHaveBeenCalledWith("offline_qr_index");
    });

    it("인덱스 없으면 아무것도 안 함", async () => {
      mockStorage.get.mockResolvedValue(null);

      await clearOfflineQrCache();

      expect(mockStorage.removeSecure).not.toHaveBeenCalled();
      expect(mockStorage.remove).not.toHaveBeenCalled();
    });
  });
});
