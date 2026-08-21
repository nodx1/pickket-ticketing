import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useNetworkStatus } from "../hooks/useNetworkStatus";

describe("useNetworkStatus", () => {
  let addEventListenerSpy: ReturnType<typeof vi.spyOn>;
  let removeEventListenerSpy: ReturnType<typeof vi.spyOn>;
  let originalOnLine: boolean;

  beforeEach(() => {
    originalOnLine = navigator.onLine;
    addEventListenerSpy = vi.spyOn(window, "addEventListener");
    removeEventListenerSpy = vi.spyOn(window, "removeEventListener");
  });

  afterEach(() => {
    addEventListenerSpy.mockRestore();
    removeEventListenerSpy.mockRestore();
    Object.defineProperty(navigator, "onLine", {
      value: originalOnLine,
      writable: true,
      configurable: true,
    });
  });

  it("returns { isOnline } object", () => {
    const { result } = renderHook(() => useNetworkStatus());
    expect(result.current).toHaveProperty("isOnline");
    expect(typeof result.current.isOnline).toBe("boolean");
  });

  it("reports online when navigator.onLine is true", () => {
    Object.defineProperty(navigator, "onLine", {
      value: true,
      writable: true,
      configurable: true,
    });
    const { result } = renderHook(() => useNetworkStatus());
    expect(result.current.isOnline).toBe(true);
  });

  it("reports offline when navigator.onLine is false", () => {
    Object.defineProperty(navigator, "onLine", {
      value: false,
      writable: true,
      configurable: true,
    });
    const { result } = renderHook(() => useNetworkStatus());
    expect(result.current.isOnline).toBe(false);
  });

  it("registers online and offline event listeners", () => {
    renderHook(() => useNetworkStatus());

    const onlineCalls = addEventListenerSpy.mock.calls.filter(
      ([event]) => event === "online"
    );
    const offlineCalls = addEventListenerSpy.mock.calls.filter(
      ([event]) => event === "offline"
    );

    expect(onlineCalls.length).toBe(1);
    expect(offlineCalls.length).toBe(1);
  });

  it("updates to online when online event fires", () => {
    Object.defineProperty(navigator, "onLine", {
      value: false,
      writable: true,
      configurable: true,
    });

    const { result } = renderHook(() => useNetworkStatus());
    expect(result.current.isOnline).toBe(false);

    act(() => {
      window.dispatchEvent(new Event("online"));
    });

    expect(result.current.isOnline).toBe(true);
  });

  it("updates to offline when offline event fires", () => {
    Object.defineProperty(navigator, "onLine", {
      value: true,
      writable: true,
      configurable: true,
    });

    const { result } = renderHook(() => useNetworkStatus());
    expect(result.current.isOnline).toBe(true);

    act(() => {
      window.dispatchEvent(new Event("offline"));
    });

    expect(result.current.isOnline).toBe(false);
  });

  it("cleans up event listeners on unmount", () => {
    const { unmount } = renderHook(() => useNetworkStatus());
    unmount();

    const onlineCleanup = removeEventListenerSpy.mock.calls.filter(
      ([event]) => event === "online"
    );
    const offlineCleanup = removeEventListenerSpy.mock.calls.filter(
      ([event]) => event === "offline"
    );

    expect(onlineCleanup.length).toBe(1);
    expect(offlineCleanup.length).toBe(1);
  });

  it("handles rapid online/offline toggling", () => {
    const { result } = renderHook(() => useNetworkStatus());

    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(result.current.isOnline).toBe(false);

    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(result.current.isOnline).toBe(true);

    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(result.current.isOnline).toBe(false);
  });
});
