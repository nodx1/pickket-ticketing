/**
 * useVoiceInput 단위 테스트 (Phase B.1)
 *
 * 전략: voice-input 래퍼를 모킹 → 모듈 유/무, 권한 승인/거부, 결과 흐름 검증
 */
import { renderHook, act, waitFor } from "@testing-library/react-native";

jest.mock("@/lib/voice-input", () => ({
  isVoiceInputAvailable: jest.fn(),
  requestVoicePermission: jest.fn(),
  startVoiceRecognition: jest.fn(),
}));

// haptics mock (네이티브 의존성 회피)
jest.mock("@/lib/haptics", () => ({
  success: jest.fn(),
  light: jest.fn(),
  medium: jest.fn(),
  error: jest.fn(),
}));

import {
  isVoiceInputAvailable,
  requestVoicePermission,
  startVoiceRecognition,
} from "@/lib/voice-input";
import { useVoiceInput } from "@/hooks/useVoiceInput";

const mockAvailable = isVoiceInputAvailable as jest.Mock;
const mockPermission = requestVoicePermission as jest.Mock;
const mockStart = startVoiceRecognition as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("useVoiceInput", () => {
  it("네이티브 모듈 없으면 available=false, start 시 error", async () => {
    mockAvailable.mockReturnValue(false);
    const { result } = renderHook(() => useVoiceInput());

    expect(result.current.available).toBe(false);

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("unavailable");
  });

  it("권한 거부 시 error", async () => {
    mockAvailable.mockReturnValue(true);
    mockPermission.mockResolvedValue(false);
    const { result } = renderHook(() => useVoiceInput());

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("permission_denied");
  });

  it("권한 승인 + 최종 결과 → onFinalResult 호출 + idle 복귀", async () => {
    mockAvailable.mockReturnValue(true);
    mockPermission.mockResolvedValue(true);

    let captured: Parameters<typeof startVoiceRecognition>[0] | null = null;
    mockStart.mockImplementation((opts) => {
      captured = opts;
      return jest.fn();
    });

    const onFinal = jest.fn();
    const { result } = renderHook(() =>
      useVoiceInput({ onFinalResult: onFinal, lang: "ko-KR" }),
    );

    await act(async () => {
      await result.current.start();
    });

    await waitFor(() => expect(result.current.status).toBe("listening"));

    act(() => {
      captured!.onResult({ transcript: "재즈", isFinal: false });
    });
    expect(result.current.transcript).toBe("재즈");
    expect(onFinal).not.toHaveBeenCalled();

    act(() => {
      captured!.onResult({ transcript: "재즈 공연", isFinal: true });
    });

    expect(onFinal).toHaveBeenCalledWith("재즈 공연");
    expect(result.current.status).toBe("idle");
  });

  it("stop 호출 시 listening → idle 전환 + 언마운트 정리", async () => {
    mockAvailable.mockReturnValue(true);
    mockPermission.mockResolvedValue(true);
    const stopFn = jest.fn();
    mockStart.mockReturnValue(stopFn);

    const { result, unmount } = renderHook(() => useVoiceInput());

    await act(async () => {
      await result.current.start();
    });
    await waitFor(() => expect(result.current.status).toBe("listening"));

    act(() => {
      result.current.stop();
    });
    expect(stopFn).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("idle");

    unmount();
    // 언마운트 cleanup은 stopRef가 null이라 추가 호출 없음
    expect(stopFn).toHaveBeenCalledTimes(1);
  });
});
