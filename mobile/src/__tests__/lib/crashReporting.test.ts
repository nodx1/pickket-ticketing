/**
 * crash-reporting 유틸리티 단위 테스트
 */
import * as Sentry from "@sentry/react-native";

jest.mock("@sentry/react-native", () => ({
  init: jest.fn(),
  captureException: jest.fn(),
}));

jest.mock("@/config/env", () => ({
  env: {
    SENTRY_DSN: "https://test@sentry.io/123",
    APP_VERSION: "0.1.0",
  },
}));

// __DEV__ 는 jest 환경에서 기본 true

describe("crash-reporting", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // 모듈 캐시 리셋해서 isInitialized 초기화
    jest.resetModules();
  });

  describe("initCrashReporting", () => {
    it("__DEV__ 환경에서는 Sentry.init 호출하지 않음", () => {
      const { initCrashReporting } = require("@/lib/crash-reporting") as typeof import("@/lib/crash-reporting");

      initCrashReporting();

      expect(Sentry.init).not.toHaveBeenCalled();
    });

    it("중복 호출 시 한 번만 실행", () => {
      const { initCrashReporting } = require("@/lib/crash-reporting") as typeof import("@/lib/crash-reporting");

      initCrashReporting();
      initCrashReporting();

      // __DEV__=true이므로 init 안 호출되지만, 두 번째 호출도 early return
      expect(Sentry.init).not.toHaveBeenCalled();
    });
  });

  describe("reportError", () => {
    it("__DEV__ 환경에서는 console.error 호출", () => {
      const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      const { reportError } = require("@/lib/crash-reporting") as typeof import("@/lib/crash-reporting");

      reportError(new Error("test error"), { page: "home" });

      expect(consoleSpy).toHaveBeenCalledWith(
        "[CrashReporting]",
        expect.any(Error),
        { page: "home" },
      );
      expect(Sentry.captureException).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("__DEV__ 환경에서 문자열 에러도 처리", () => {
      const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      const { reportError } = require("@/lib/crash-reporting") as typeof import("@/lib/crash-reporting");

      reportError("string error");

      expect(consoleSpy).toHaveBeenCalledWith(
        "[CrashReporting]",
        "string error",
        undefined,
      );
      consoleSpy.mockRestore();
    });
  });
});
