/**
 * deep-linking 유틸리티 단위 테스트
 */
import * as Linking from "expo-linking";
import { router } from "expo-router";

jest.mock("expo-linking", () => ({
  parse: jest.fn(),
  getInitialURL: jest.fn(),
  addEventListener: jest.fn(),
}));

jest.mock("expo-router", () => ({
  router: {
    push: jest.fn(),
  },
}));

import {
  parseDeepLink,
  handleDeepLink,
  getInitialDeepLink,
  addDeepLinkListener,
} from "@/lib/deep-linking";

const mockParse = Linking.parse as jest.Mock;
const mockGetInitialURL = Linking.getInitialURL as jest.Mock;
const mockAddEventListener = Linking.addEventListener as jest.Mock;

describe("deep-linking", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("parseDeepLink", () => {
    it("pickket://event/123 → /event/123", () => {
      mockParse.mockReturnValue({ scheme: "pickket", path: "event/123", hostname: null });
      expect(parseDeepLink("pickket://event/123")).toBe("/event/123");
    });

    it("pickket://e/slug → /e/slug", () => {
      mockParse.mockReturnValue({ scheme: "pickket", path: "e/slug-name", hostname: null });
      expect(parseDeepLink("pickket://e/slug-name")).toBe("/e/slug-name");
    });

    it("pickket://ticket/abc → /ticket/abc", () => {
      mockParse.mockReturnValue({ scheme: "pickket", path: "ticket/abc", hostname: null });
      expect(parseDeepLink("pickket://ticket/abc")).toBe("/ticket/abc");
    });

    it("pickket://order/xyz → /order/xyz", () => {
      mockParse.mockReturnValue({ scheme: "pickket", path: "order/xyz", hostname: null });
      expect(parseDeepLink("pickket://order/xyz")).toBe("/order/xyz");
    });

    it("pickket://payment/success → null (결제 화면 처리)", () => {
      mockParse.mockReturnValue({ scheme: "pickket", path: "payment/success", hostname: null });
      expect(parseDeepLink("pickket://payment/success")).toBeNull();
    });

    it("pickket://payment/fail → null", () => {
      mockParse.mockReturnValue({ scheme: "pickket", path: "payment/fail", hostname: null });
      expect(parseDeepLink("pickket://payment/fail")).toBeNull();
    });

    it("pickket://unknown → null", () => {
      mockParse.mockReturnValue({ scheme: "pickket", path: "unknown", hostname: null });
      expect(parseDeepLink("pickket://unknown")).toBeNull();
    });

    it("https://pickket.kr/events/123 → /event/123", () => {
      mockParse.mockReturnValue({
        scheme: "https",
        hostname: "pickket.kr",
        path: "events/123",
      });
      expect(parseDeepLink("https://pickket.kr/events/123")).toBe("/event/123");
    });

    it("https://pickket.kr/ko/events/123 → /event/123 (locale strip)", () => {
      mockParse.mockReturnValue({
        scheme: "https",
        hostname: "pickket.kr",
        path: "ko/events/123",
      });
      expect(parseDeepLink("https://pickket.kr/ko/events/123")).toBe("/event/123");
    });

    it("https://pickket.kr/en/tickets/456 → /ticket/456", () => {
      mockParse.mockReturnValue({
        scheme: "https",
        hostname: "pickket.kr",
        path: "en/tickets/456",
      });
      expect(parseDeepLink("https://pickket.kr/en/tickets/456")).toBe("/ticket/456");
    });

    it("https://pickket.kr/orders/789 → /order/789", () => {
      mockParse.mockReturnValue({
        scheme: "https",
        hostname: "pickket.kr",
        path: "orders/789",
      });
      expect(parseDeepLink("https://pickket.kr/orders/789")).toBe("/order/789");
    });

    it("https://pickket.kr/e/my-event → /e/my-event", () => {
      mockParse.mockReturnValue({
        scheme: "https",
        hostname: "pickket.kr",
        path: "e/my-event",
      });
      expect(parseDeepLink("https://pickket.kr/e/my-event")).toBe("/e/my-event");
    });

    it("신뢰할 수 없는 호스트 → null", () => {
      mockParse.mockReturnValue({
        scheme: "https",
        hostname: "evil.com",
        path: "events/123",
      });
      expect(parseDeepLink("https://evil.com/events/123")).toBeNull();
    });

    it("stg.pickket.kr → 허용", () => {
      mockParse.mockReturnValue({
        scheme: "https",
        hostname: "stg.pickket.kr",
        path: "events/123",
      });
      expect(parseDeepLink("https://stg.pickket.kr/events/123")).toBe("/event/123");
    });

    it("resource만 있고 id 없으면 null", () => {
      mockParse.mockReturnValue({
        scheme: "https",
        hostname: "pickket.kr",
        path: "events",
      });
      expect(parseDeepLink("https://pickket.kr/events")).toBeNull();
    });

    it("알 수 없는 resource → null", () => {
      mockParse.mockReturnValue({
        scheme: "https",
        hostname: "pickket.kr",
        path: "unknown/123",
      });
      expect(parseDeepLink("https://pickket.kr/unknown/123")).toBeNull();
    });

    it("파싱 에러 → null", () => {
      mockParse.mockImplementation(() => {
        throw new Error("parse error");
      });
      expect(parseDeepLink("invalid-url")).toBeNull();
    });
  });

  describe("handleDeepLink", () => {
    it("유효한 딥링크 → router.push + true", () => {
      mockParse.mockReturnValue({ scheme: "pickket", path: "event/123", hostname: null });

      const result = handleDeepLink("pickket://event/123");
      expect(result).toBe(true);
      expect(router.push).toHaveBeenCalledWith("/event/123");
    });

    it("무효한 딥링크 → false", () => {
      mockParse.mockReturnValue({ scheme: "pickket", path: "unknown", hostname: null });

      const result = handleDeepLink("pickket://unknown");
      expect(result).toBe(false);
      expect(router.push).not.toHaveBeenCalled();
    });
  });

  describe("getInitialDeepLink", () => {
    it("초기 URL 있으면 파싱된 라우트 반환", async () => {
      mockGetInitialURL.mockResolvedValue("pickket://event/999");
      mockParse.mockReturnValue({ scheme: "pickket", path: "event/999", hostname: null });

      const result = await getInitialDeepLink();
      expect(result).toBe("/event/999");
    });

    it("초기 URL 없으면 null", async () => {
      mockGetInitialURL.mockResolvedValue(null);

      const result = await getInitialDeepLink();
      expect(result).toBeNull();
    });
  });

  describe("addDeepLinkListener", () => {
    it("Linking.addEventListener 등록 + 유효한 URL 시 콜백 호출", () => {
      let capturedHandler: ((event: { url: string }) => void) | undefined;
      mockAddEventListener.mockImplementation((_type: string, handler: (event: { url: string }) => void) => {
        capturedHandler = handler;
        return { remove: jest.fn() };
      });

      const callback = jest.fn();
      addDeepLinkListener(callback);

      expect(mockAddEventListener).toHaveBeenCalledWith("url", expect.any(Function));

      // 유효한 딥링크 수신 시 콜백 호출
      mockParse.mockReturnValue({ scheme: "pickket", path: "event/123", hostname: null });
      capturedHandler!({ url: "pickket://event/123" });
      expect(callback).toHaveBeenCalledWith("/event/123");
    });

    it("무효한 URL 수신 시 콜백 미호출", () => {
      let capturedHandler: ((event: { url: string }) => void) | undefined;
      mockAddEventListener.mockImplementation((_type: string, handler: (event: { url: string }) => void) => {
        capturedHandler = handler;
        return { remove: jest.fn() };
      });

      const callback = jest.fn();
      addDeepLinkListener(callback);

      mockParse.mockReturnValue({ scheme: "pickket", path: "unknown", hostname: null });
      capturedHandler!({ url: "pickket://unknown" });
      expect(callback).not.toHaveBeenCalled();
    });
  });
});
