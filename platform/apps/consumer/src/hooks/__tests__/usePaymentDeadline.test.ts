import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePaymentDeadline } from "../usePaymentDeadline";

describe("usePaymentDeadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("with null/undefined deadline", () => {
    it("returns expired state for null deadline", () => {
      const { result } = renderHook(() => usePaymentDeadline(null));
      expect(result.current.expired).toBe(true);
      expect(result.current.display).toBe("만료됨");
    });

    it("returns expired state for undefined deadline", () => {
      const { result } = renderHook(() => usePaymentDeadline(undefined));
      expect(result.current.expired).toBe(true);
      expect(result.current.display).toBe("만료됨");
    });

    it("has zero totalSeconds", () => {
      const { result } = renderHook(() => usePaymentDeadline(null));
      expect(result.current.totalSeconds).toBe(0);
    });
  });

  describe("with future deadline", () => {
    it("shows remaining time", () => {
      const now = new Date("2026-03-04T10:00:00Z");
      vi.setSystemTime(now);

      // 1 hour and 30 minutes from now
      const deadline = "2026-03-04T11:30:00Z";
      const { result } = renderHook(() => usePaymentDeadline(deadline));

      expect(result.current.expired).toBe(false);
      expect(result.current.hours).toBe(1);
      expect(result.current.minutes).toBe(30);
    });

    it("formats display as HH:MM:SS when hours > 0", () => {
      const now = new Date("2026-03-04T10:00:00Z");
      vi.setSystemTime(now);

      const deadline = "2026-03-04T12:05:30Z";
      const { result } = renderHook(() => usePaymentDeadline(deadline));

      expect(result.current.display).toMatch(/^02:05:\d{2}$/);
    });

    it("formats display as MM:SS when hours = 0", () => {
      const now = new Date("2026-03-04T10:00:00Z");
      vi.setSystemTime(now);

      const deadline = "2026-03-04T10:15:00Z";
      const { result } = renderHook(() => usePaymentDeadline(deadline));

      expect(result.current.display).toMatch(/^\d{2}:\d{2}$/);
      expect(result.current.hours).toBe(0);
    });
  });

  describe("urgency levels", () => {
    it("is not urgent when > 1 hour remains", () => {
      const now = new Date("2026-03-04T10:00:00Z");
      vi.setSystemTime(now);

      const deadline = "2026-03-04T12:00:00Z";
      const { result } = renderHook(() => usePaymentDeadline(deadline));

      expect(result.current.isUrgent).toBe(false);
      expect(result.current.isCritical).toBe(false);
    });

    it("is urgent when < 1 hour remains", () => {
      const now = new Date("2026-03-04T10:00:00Z");
      vi.setSystemTime(now);

      const deadline = "2026-03-04T10:45:00Z";
      const { result } = renderHook(() => usePaymentDeadline(deadline));

      expect(result.current.isUrgent).toBe(true);
      expect(result.current.isCritical).toBe(false);
    });

    it("is critical when < 10 minutes remain", () => {
      const now = new Date("2026-03-04T10:00:00Z");
      vi.setSystemTime(now);

      const deadline = "2026-03-04T10:05:00Z";
      const { result } = renderHook(() => usePaymentDeadline(deadline));

      expect(result.current.isUrgent).toBe(true);
      expect(result.current.isCritical).toBe(true);
    });
  });

  describe("expiration", () => {
    it("marks as expired when deadline passes", () => {
      const now = new Date("2026-03-04T10:00:00Z");
      vi.setSystemTime(now);

      const deadline = "2026-03-04T10:00:05Z"; // 5 seconds from now
      const { result } = renderHook(() => usePaymentDeadline(deadline));

      expect(result.current.expired).toBe(false);

      // Advance past deadline
      act(() => {
        vi.advanceTimersByTime(6000);
      });

      expect(result.current.expired).toBe(true);
      expect(result.current.display).toBe("만료됨");
    });

    it("calls onExpire callback when time expires", () => {
      const now = new Date("2026-03-04T10:00:00Z");
      vi.setSystemTime(now);

      const onExpire = vi.fn();
      const deadline = "2026-03-04T10:00:03Z"; // 3 seconds from now

      renderHook(() => usePaymentDeadline(deadline, onExpire));

      expect(onExpire).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(4000);
      });

      expect(onExpire).toHaveBeenCalledTimes(1);
    });

    it("calls onExpire only once", () => {
      const now = new Date("2026-03-04T10:00:00Z");
      vi.setSystemTime(now);

      const onExpire = vi.fn();
      const deadline = "2026-03-04T10:00:02Z";

      renderHook(() => usePaymentDeadline(deadline, onExpire));

      act(() => {
        vi.advanceTimersByTime(5000);
      });

      expect(onExpire).toHaveBeenCalledTimes(1);
    });
  });

  describe("already expired deadline", () => {
    it("starts in expired state", () => {
      const now = new Date("2026-03-04T10:00:00Z");
      vi.setSystemTime(now);

      const pastDeadline = "2026-03-04T09:00:00Z";
      const { result } = renderHook(() => usePaymentDeadline(pastDeadline));

      expect(result.current.expired).toBe(true);
      expect(result.current.totalSeconds).toBe(0);
    });
  });

  describe("countdown ticking", () => {
    it("decrements seconds over time", () => {
      const now = new Date("2026-03-04T10:00:00Z");
      vi.setSystemTime(now);

      const deadline = "2026-03-04T10:01:00Z"; // 60 seconds from now
      const { result } = renderHook(() => usePaymentDeadline(deadline));

      const initialSeconds = result.current.totalSeconds;

      act(() => {
        vi.advanceTimersByTime(5000);
      });

      expect(result.current.totalSeconds).toBe(initialSeconds - 5);
    });
  });
});
