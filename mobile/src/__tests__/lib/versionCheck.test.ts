/**
 * version-check 유틸리티 단위 테스트
 */
import { Linking } from "react-native";
import * as Application from "expo-application";

jest.mock("@/config/env", () => ({
  env: {
    API_URL: "https://api.pickket.kr",
    APP_VERSION: "0.1.0",
    IS_DEV: false,
  },
}));

const mockApiGet = jest.fn();
jest.mock("@/config/api", () => ({
  api: { get: (...args: unknown[]) => mockApiGet(...args) },
}));

import {
  getCurrentVersion,
  checkAppVersion,
  openStore,
} from "@/lib/version-check";

describe("version-check", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApiGet.mockReset();
  });

  describe("getCurrentVersion", () => {
    it("nativeApplicationVersion 반환", () => {
      expect(getCurrentVersion()).toBe("0.1.0");
    });

    it("nativeApplicationVersion 없으면 env.APP_VERSION fallback", () => {
      const orig = Application.nativeApplicationVersion;
      Object.defineProperty(Application, "nativeApplicationVersion", {
        value: null,
        writable: true,
        configurable: true,
      });
      expect(getCurrentVersion()).toBe("0.1.0");
      Object.defineProperty(Application, "nativeApplicationVersion", {
        value: orig,
        writable: true,
        configurable: true,
      });
    });
  });

  describe("checkAppVersion", () => {
    it("서버 응답 에러 시 up_to_date 반환", async () => {
      mockApiGet.mockRejectedValue(new Error("Network error"));

      const result = await checkAppVersion();
      expect(result.status).toBe("up_to_date");
      expect(result.currentVersion).toBe("0.1.0");
    });

    it("최소 버전 미달 → update_required", async () => {
      mockApiGet.mockResolvedValue({
        data: {
          minimum_version: "1.0.0",
          recommended_version: "1.0.0",
          release_notes: "중요 보안 업데이트",
        },
      });

      const result = await checkAppVersion();
      expect(result.status).toBe("update_required");
      expect(result.minimumVersion).toBe("1.0.0");
      expect(result.releaseNotes).toBe("중요 보안 업데이트");
    });

    it("권장 버전 미달 → update_recommended", async () => {
      mockApiGet.mockResolvedValue({
        data: {
          minimum_version: "0.0.1",
          recommended_version: "1.0.0",
        },
      });

      const result = await checkAppVersion();
      expect(result.status).toBe("update_recommended");
      expect(result.recommendedVersion).toBe("1.0.0");
    });

    it("현재 버전 >= 권장 버전 → up_to_date", async () => {
      mockApiGet.mockResolvedValue({
        data: {
          minimum_version: "0.0.1",
          recommended_version: "0.1.0",
        },
      });

      const result = await checkAppVersion();
      expect(result.status).toBe("up_to_date");
    });
  });

  describe("openStore", () => {
    it("canOpenURL true → openURL 호출 + true 반환", async () => {
      (Linking.canOpenURL as jest.Mock).mockResolvedValue(true);
      (Linking.openURL as jest.Mock).mockResolvedValue(undefined);

      const result = await openStore();
      expect(result).toBe(true);
      expect(Linking.openURL).toHaveBeenCalled();
    });

    it("canOpenURL false → false 반환", async () => {
      (Linking.canOpenURL as jest.Mock).mockResolvedValue(false);

      const result = await openStore();
      expect(result).toBe(false);
      expect(Linking.openURL).not.toHaveBeenCalled();
    });

    it("openURL 에러 시 false 반환", async () => {
      (Linking.canOpenURL as jest.Mock).mockResolvedValue(true);
      (Linking.openURL as jest.Mock).mockRejectedValue(new Error("fail"));

      const result = await openStore();
      expect(result).toBe(false);
    });
  });
});
