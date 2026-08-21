/**
 * analytics 단위 테스트 — 동의 게이팅 + 버퍼링
 *
 * analytics.ts는 모듈 레벨 상태(consentGranted, eventBuffer)를 가지므로
 * jest.isolateModules로 각 테스트마다 독립 인스턴스를 생성.
 */

// 공유 mock 참조
let mockTrackEvents: jest.Mock;
let mockStorageGet: jest.Mock;
let mockStorageSet: jest.Mock;

function loadAnalytics(): typeof import("@/lib/analytics") {
  let mod: typeof import("@/lib/analytics");

  jest.isolateModules(() => {
    // 각 isolateModules 내에서 mock 설정
    mockTrackEvents = jest.fn().mockResolvedValue(undefined);
    mockStorageGet = jest.fn().mockResolvedValue(null);
    mockStorageSet = jest.fn().mockResolvedValue(undefined);

    jest.doMock("@/config/api", () => ({
      trackEvents: mockTrackEvents,
      setAuthStateResetter: jest.fn(),
    }));

    jest.doMock("@/lib/storage", () => ({
      storage: {
        get: mockStorageGet,
        set: mockStorageSet,
      },
    }));

    mod = require("@/lib/analytics");
  });

  return mod!;
}

describe("analytics", () => {
  describe("동의 미부여 시", () => {
    it("이벤트 전송하지 않음", () => {
      const analytics = loadAnalytics();

      analytics.trackScreenView("home");
      analytics.trackEventView("event-1");

      // flush 시도
      analytics.flushAnalytics();

      // 동의 없으므로 버퍼에 아무것도 추가 안 됨
      expect(mockTrackEvents).not.toHaveBeenCalled();
    });
  });

  describe("동의 부여 후", () => {
    it("이벤트 수집 후 flushAnalytics 시 전송", async () => {
      const analytics = loadAnalytics();
      await analytics.setAnalyticsConsent(true);

      analytics.trackScreenView("home");
      analytics.trackEventView("event-1");
      analytics.flushAnalytics();

      // flush()는 async → microtask 대기
      await new Promise((r) => setImmediate(r));

      expect(mockTrackEvents).toHaveBeenCalledTimes(1);
      expect(mockTrackEvents).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ event_type: "page_view" }),
          expect.objectContaining({ event_type: "event_view" }),
        ]),
      );
    });

    it("trackPurchase 이벤트 형식", async () => {
      const analytics = loadAnalytics();
      await analytics.setAnalyticsConsent(true);

      analytics.trackPurchase("ev-1", "tier-1", 66000);
      analytics.flushAnalytics();
      await new Promise((r) => setImmediate(r));

      expect(mockTrackEvents).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            event_type: "purchase",
            target_type: "event",
            target_id: "ev-1",
            metadata: expect.objectContaining({ tier_id: "tier-1", amount: 66000 }),
          }),
        ]),
      );
    });

    it("trackSearch/trackFavorite/trackShare/trackClick 형식", async () => {
      const analytics = loadAnalytics();
      await analytics.setAnalyticsConsent(true);

      analytics.trackSearch("concert", 5);
      analytics.trackFavorite("ev-1");
      analytics.trackShare("ev-1", "kakao");
      analytics.trackClick("event", "ev-2");
      analytics.flushAnalytics();
      await new Promise((r) => setImmediate(r));

      expect(mockTrackEvents).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ event_type: "search" }),
          expect.objectContaining({ event_type: "favorite" }),
          expect.objectContaining({ event_type: "share" }),
          expect.objectContaining({ event_type: "click" }),
        ]),
      );
    });
  });

  describe("initAnalyticsConsent", () => {
    it("storage에서 true 로드 → 이벤트 전송 가능", async () => {
      const analytics = loadAnalytics();
      mockStorageGet.mockResolvedValue("true");

      await analytics.initAnalyticsConsent();

      analytics.trackScreenView("test");
      analytics.flushAnalytics();
      await new Promise((r) => setImmediate(r));

      expect(mockTrackEvents).toHaveBeenCalled();
    });

    it("storage에서 null 로드 → 이벤트 전송 안 됨", async () => {
      const analytics = loadAnalytics();
      mockStorageGet.mockResolvedValue(null);

      await analytics.initAnalyticsConsent();

      analytics.trackScreenView("test");
      analytics.flushAnalytics();
      await new Promise((r) => setImmediate(r));

      expect(mockTrackEvents).not.toHaveBeenCalled();
    });
  });

  describe("setAnalyticsConsent", () => {
    it("동의 상태 저장", async () => {
      const analytics = loadAnalytics();
      await analytics.setAnalyticsConsent(true);

      expect(mockStorageSet).toHaveBeenCalledWith("analytics_consent", "true");
    });

    it("false 저장", async () => {
      const analytics = loadAnalytics();
      await analytics.setAnalyticsConsent(false);

      expect(mockStorageSet).toHaveBeenCalledWith("analytics_consent", "false");
    });
  });
});
