/**
 * storage 유틸리티 단위 테스트
 *
 * jest.setup.js의 글로벌 mock을 사용하되,
 * AsyncStorage는 { default: { getItem, ... } } 구조이므로
 * require()로 직접 접근.
 */
import * as SecureStore from "expo-secure-store";

const mockSecureStore = SecureStore as jest.Mocked<typeof SecureStore>;

import AsyncStorage from "@react-native-async-storage/async-storage";

const mockAsync = AsyncStorage as jest.Mocked<typeof AsyncStorage>;

const { storage } = require("@/lib/storage") as typeof import("@/lib/storage");

describe("storage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("getSecure / setSecure / removeSecure", () => {
    it("SecureStore.getItemAsync 호출", async () => {
      mockSecureStore.getItemAsync.mockResolvedValue("test-value");

      const result = await storage.getSecure("key");
      expect(result).toBe("test-value");
      expect(mockSecureStore.getItemAsync).toHaveBeenCalledWith("key");
    });

    it("SecureStore 에러 시 null 반환", async () => {
      mockSecureStore.getItemAsync.mockRejectedValue(new Error("fail"));

      const result = await storage.getSecure("key");
      expect(result).toBeNull();
    });

    it("setSecure → SecureStore.setItemAsync", async () => {
      await storage.setSecure("key", "value");
      expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith("key", "value");
    });

    it("removeSecure → SecureStore.deleteItemAsync", async () => {
      await storage.removeSecure("key");
      expect(mockSecureStore.deleteItemAsync).toHaveBeenCalledWith("key");
    });
  });

  describe("get / set / remove (AsyncStorage)", () => {
    it("get → AsyncStorage.getItem", async () => {
      mockAsync.getItem.mockResolvedValue("stored");

      const result = await storage.get("pref");
      expect(result).toBe("stored");
    });

    it("get 에러 시 null 반환", async () => {
      mockAsync.getItem.mockRejectedValue(new Error("fail"));

      const result = await storage.get("pref");
      expect(result).toBeNull();
    });

    it("set → AsyncStorage.setItem", async () => {
      await storage.set("pref", "val");
      expect(mockAsync.setItem).toHaveBeenCalledWith("pref", "val");
    });

    it("remove → AsyncStorage.removeItem", async () => {
      await storage.remove("pref");
      expect(mockAsync.removeItem).toHaveBeenCalledWith("pref");
    });
  });

  describe("토큰 헬퍼", () => {
    it("getAccessToken → SecureStore access_token 조회", async () => {
      mockSecureStore.getItemAsync.mockResolvedValue("jwt-token");
      const result = await storage.getAccessToken();
      expect(result).toBe("jwt-token");
      expect(mockSecureStore.getItemAsync).toHaveBeenCalledWith("access_token");
    });

    it("setAccessToken", async () => {
      await storage.setAccessToken("new-jwt");
      expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith("access_token", "new-jwt");
    });

    it("getRefreshToken / setRefreshToken", async () => {
      mockSecureStore.getItemAsync.mockResolvedValue("refresh-jwt");
      const result = await storage.getRefreshToken();
      expect(result).toBe("refresh-jwt");

      await storage.setRefreshToken("new-refresh");
      expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith("refresh_token", "new-refresh");
    });
  });

  describe("clearAuth", () => {
    it("모든 인증 데이터 삭제", async () => {
      await storage.clearAuth();

      expect(mockSecureStore.deleteItemAsync).toHaveBeenCalledWith("access_token");
      expect(mockSecureStore.deleteItemAsync).toHaveBeenCalledWith("refresh_token");
      expect(mockSecureStore.deleteItemAsync).toHaveBeenCalledWith("pickket_token");
      expect(mockSecureStore.deleteItemAsync).toHaveBeenCalledWith("auth_token");
      expect(mockAsync.removeItem).toHaveBeenCalledWith("pickket_user");
      expect(mockAsync.removeItem).toHaveBeenCalledWith("auth_user");
    });
  });
});
