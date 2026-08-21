/**
 * useVoiceInput — 음성 입력 훅 (Phase B.1)
 *
 * 상태 머신: idle → requesting → listening → (result) → idle
 * 권한 거부 / 모듈 미설치 → error
 *
 * 사용처: SearchBar mic 버튼 (길게 누름으로 녹음 시작, 놓으면 종료)
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  isVoiceInputAvailable,
  requestVoicePermission,
  startVoiceRecognition,
} from "@/lib/voice-input";

type Status = "idle" | "requesting" | "listening" | "error";

interface Options {
  lang?: string;
  onFinalResult?: (transcript: string) => void;
}

export function useVoiceInput({ lang = "ko-KR", onFinalResult }: Options = {}) {
  const [status, setStatus] = useState<Status>("idle");
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);

  const available = isVoiceInputAvailable();

  const start = useCallback(async () => {
    if (!available) {
      setStatus("error");
      setError("unavailable");
      return;
    }
    setStatus("requesting");
    setError(null);
    setTranscript("");
    const granted = await requestVoicePermission();
    if (!granted) {
      setStatus("error");
      setError("permission_denied");
      return;
    }
    setStatus("listening");
    stopRef.current = startVoiceRecognition({
      lang,
      onResult: ({ transcript: t, isFinal }) => {
        setTranscript(t);
        if (isFinal) {
          onFinalResult?.(t);
          setStatus("idle");
        }
      },
      onError: (err) => {
        setError(err);
        setStatus("error");
      },
      onEnd: () => {
        setStatus((prev) => (prev === "listening" ? "idle" : prev));
      },
    });
  }, [available, lang, onFinalResult]);

  const stop = useCallback(() => {
    stopRef.current?.();
    stopRef.current = null;
    setStatus((prev) => (prev === "listening" ? "idle" : prev));
  }, []);

  useEffect(() => {
    return () => {
      stopRef.current?.();
    };
  }, []);

  return {
    available,
    status,
    transcript,
    error,
    start,
    stop,
    isListening: status === "listening",
  };
}
