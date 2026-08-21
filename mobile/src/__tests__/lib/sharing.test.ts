/**
 * sharing 유틸리티 단위 테스트
 */
import { Share } from "react-native";
import * as analytics from "@/lib/analytics";

jest.mock("@/lib/analytics", () => ({
  trackShare: jest.fn(),
}));

import { shareEvent, shareTicket } from "@/lib/sharing";

const mockTrackShare = analytics.trackShare as jest.Mock;
let shareSpy: jest.SpyInstance;

describe("sharing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    shareSpy = jest.spyOn(Share, "share");
  });

  afterEach(() => {
    shareSpy.mockRestore();
  });

  describe("shareEvent", () => {
    it("공유 성공 시 trackShare 호출 + true 반환", async () => {
      shareSpy.mockResolvedValue({
        action: Share.sharedAction,
        activityType: "com.apple.UIKit.activity.CopyToPasteboard",
      });

      const result = await shareEvent({
        eventId: "ev-1",
        title: "BTS 콘서트",
        date: "2026-05-01",
        venue: "잠실종합운동장",
      });

      expect(result).toBe(true);
      expect(mockTrackShare).toHaveBeenCalledWith(
        "ev-1",
        "com.apple.UIKit.activity.CopyToPasteboard",
      );
    });

    it("공유 취소 시 false 반환", async () => {
      shareSpy.mockResolvedValue({
        action: Share.dismissedAction,
      });

      const result = await shareEvent({
        eventId: "ev-1",
        title: "BTS 콘서트",
      });

      expect(result).toBe(false);
      expect(mockTrackShare).not.toHaveBeenCalled();
    });

    it("Share.share 에러 시 false 반환", async () => {
      shareSpy.mockRejectedValue(new Error("Share failed"));

      const result = await shareEvent({
        eventId: "ev-1",
        title: "테스트",
      });

      expect(result).toBe(false);
    });

    it("activityType 없으면 'unknown' 전달", async () => {
      shareSpy.mockResolvedValue({
        action: Share.sharedAction,
        activityType: undefined,
      });

      await shareEvent({ eventId: "ev-1", title: "테스트" });
      expect(mockTrackShare).toHaveBeenCalledWith("ev-1", "unknown");
    });
  });

  describe("shareTicket", () => {
    it("티켓 공유 성공 시 true 반환", async () => {
      shareSpy.mockResolvedValue({
        action: Share.sharedAction,
        activityType: "share",
      });

      const result = await shareTicket({
        eventId: "ev-2",
        title: "IU 콘서트",
        date: "2026-06-01",
      });

      expect(result).toBe(true);
      expect(mockTrackShare).toHaveBeenCalledWith("ev-2", "share");
    });

    it("date 없으면 메시지에 날짜 미포함", async () => {
      shareSpy.mockResolvedValue({
        action: Share.sharedAction,
        activityType: undefined,
      });

      await shareTicket({ eventId: "ev-2", title: "IU 콘서트" });

      const callArgs = shareSpy.mock.calls[0];
      const message: string = callArgs[0].message;
      expect(message).toContain("IU 콘서트");
      expect(message).not.toContain("(");
    });

    it("공유 에러 시 false 반환", async () => {
      shareSpy.mockRejectedValue(new Error("fail"));

      const result = await shareTicket({
        eventId: "ev-2",
        title: "테스트",
      });

      expect(result).toBe(false);
    });
  });
});
