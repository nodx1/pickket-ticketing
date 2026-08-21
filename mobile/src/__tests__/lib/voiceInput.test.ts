/**
 * voice-input 래퍼 단위 테스트 (Phase B.1)
 *
 * expo-speech-recognition 모듈 로딩 폴백 검증 — require 실패 시 isAvailable=false
 */
import {
  isVoiceInputAvailable,
  requestVoicePermission,
  startVoiceRecognition,
  __resetVoiceModuleCache,
} from "@/lib/voice-input";

beforeEach(() => {
  __resetVoiceModuleCache();
  jest.resetModules();
});

describe("voice-input (fallback)", () => {
  it("expo-speech-recognition 없을 때 isVoiceInputAvailable=false", () => {
    // 기본: node_modules에 패키지 없음 → require 실패
    expect(isVoiceInputAvailable()).toBe(false);
  });

  it("모듈 없을 때 requestVoicePermission=false", async () => {
    await expect(requestVoicePermission()).resolves.toBe(false);
  });

  it("모듈 없을 때 startVoiceRecognition → onError('unavailable')", () => {
    const onError = jest.fn();
    const onResult = jest.fn();
    const onEnd = jest.fn();
    const cleanup = startVoiceRecognition({
      lang: "ko-KR",
      onResult,
      onError,
      onEnd,
    });
    expect(onError).toHaveBeenCalledWith("unavailable");
    expect(onResult).not.toHaveBeenCalled();
    // cleanup은 noop이지만 호출 가능해야 함
    expect(() => cleanup()).not.toThrow();
  });
});
