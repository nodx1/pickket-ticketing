/**
 * useRotatingQR 훅 단위 테스트
 */
import { renderHook, act } from "@testing-library/react-native";
import { useRotatingQR } from "@/hooks/useRotatingQR";
import type { TicketQrResponse } from "@/config/api";

// 타이머 모킹
jest.useFakeTimers();

describe("useRotatingQR", () => {
  afterEach(() => {
    jest.clearAllTimers();
  });

  it("initialQrResponse null → loading true", () => {
    const { result } = renderHook(() => useRotatingQR(null));

    expect(result.current.loading).toBe(true);
    expect(result.current.qrPayload).toBe("");
  });

  it("static QR (expires > 30s) → isTotp false, 페이로드 설정", () => {
    const qrResponse: TicketQrResponse = {
      qr_data: "static-qr-payload",
      expires_in_seconds: 60,
    } as TicketQrResponse;

    const { result } = renderHook(() => useRotatingQR(qrResponse));

    expect(result.current.loading).toBe(false);
    expect(result.current.qrPayload).toBe("static-qr-payload");
    expect(result.current.secondsRemaining).toBe(60);
    expect(result.current.isTotp).toBe(false);
  });

  it("TOTP QR (expires <= 30s + fetchQr 있음) → isTotp true", () => {
    const qrResponse: TicketQrResponse = {
      qr_data: "totp-qr-payload",
      expires_in_seconds: 15,
    } as TicketQrResponse;

    const fetchQr = jest.fn();

    const { result } = renderHook(() => useRotatingQR(qrResponse, fetchQr));

    expect(result.current.isTotp).toBe(true);
    expect(result.current.qrPayload).toBe("totp-qr-payload");
    expect(result.current.secondsRemaining).toBe(15);
  });

  it("TOTP 모드에서 초마다 카운트다운", () => {
    const qrResponse: TicketQrResponse = {
      qr_data: "totp-qr",
      expires_in_seconds: 15,
    } as TicketQrResponse;

    const fetchQr = jest.fn().mockResolvedValue({
      qr_data: "new-totp-qr",
      expires_in_seconds: 15,
    });

    const { result } = renderHook(() => useRotatingQR(qrResponse, fetchQr));

    // 1초 경과
    act(() => {
      jest.advanceTimersByTime(1000);
    });

    expect(result.current.secondsRemaining).toBe(14);
  });

  it("TOTP 모드에서 refreshLeadSec 도달 시 fetchQr 호출", async () => {
    const qrResponse: TicketQrResponse = {
      qr_data: "totp-qr",
      expires_in_seconds: 15,
    } as TicketQrResponse;

    const fetchQr = jest.fn().mockResolvedValue({
      qr_data: "refreshed-qr",
      expires_in_seconds: 15,
    });

    renderHook(() => useRotatingQR(qrResponse, fetchQr));

    // 13초 경과 → remaining = 2 → refreshLeadSec(2) 도달
    act(() => {
      jest.advanceTimersByTime(13000);
    });

    // jitter timeout 실행
    act(() => {
      jest.advanceTimersByTime(500);
    });

    expect(fetchQr).toHaveBeenCalled();
  });

  it("fetchQr 없으면 isTotp false (expires <= 30이어도)", () => {
    const qrResponse: TicketQrResponse = {
      qr_data: "no-fetch-qr",
      expires_in_seconds: 15,
    } as TicketQrResponse;

    const { result } = renderHook(() => useRotatingQR(qrResponse, undefined));

    expect(result.current.isTotp).toBe(false);
  });

  it("expires <= 10s → refreshLeadSec = 3", () => {
    const qrResponse: TicketQrResponse = {
      qr_data: "short-qr",
      expires_in_seconds: 8,
    } as TicketQrResponse;

    const fetchQr = jest.fn().mockResolvedValue({
      qr_data: "new-short-qr",
      expires_in_seconds: 8,
    });

    renderHook(() => useRotatingQR(qrResponse, fetchQr));

    // 5초 경과 → remaining = 3 → refreshLeadSec(3) 도달
    act(() => {
      jest.advanceTimersByTime(5000);
    });

    act(() => {
      jest.advanceTimersByTime(500);
    });

    expect(fetchQr).toHaveBeenCalled();
  });

  it("언마운트 시 인터벌/타임아웃 클리어", () => {
    const qrResponse: TicketQrResponse = {
      qr_data: "cleanup-qr",
      expires_in_seconds: 15,
    } as TicketQrResponse;

    const fetchQr = jest.fn();

    const { unmount } = renderHook(() => useRotatingQR(qrResponse, fetchQr));

    unmount();

    // 언마운트 후 타이머 진행해도 에러 없음
    act(() => {
      jest.advanceTimersByTime(20000);
    });
  });
});
