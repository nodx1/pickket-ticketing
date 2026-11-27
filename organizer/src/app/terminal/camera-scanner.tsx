"use client";

/**
 * 현장 단말 카메라 — 휴대폰·태블릿 뒤쪽 카메라로 관객의 티켓 QR 을 계속 읽는다.
 *
 * - 읽은 값은 그대로 `onDecode` 로 넘긴다. 같은 QR 을 여러 번 보내지 않는 일은 부르는 쪽(shouldSendScan)이 한다.
 * - 카메라는 https(또는 localhost)에서만 켜진다. 권한 거부·카메라 없음은 `onError` 로 알려 스캐너 입력으로 돌릴 수 있게 한다.
 * - 개발 모드의 이펙트 두 번 실행에도 카메라가 겹치지 않게, 실행마다 따로 만든 칸에 붙이고 끝나면 그 칸째 지운다.
 */
import { useEffect, useRef } from "react";

export type CameraProblem = "insecure" | "denied" | "nocamera" | "error";

const PROBLEM_TEXT: Record<CameraProblem, string> = {
  insecure: "카메라는 https 주소에서만 켜져요. 피켓고 주소(https://go.pickket.kr)로 열어 주세요.",
  denied: "카메라 권한이 꺼져 있어요. 브라우저 주소창의 설정에서 카메라를 허용한 뒤 다시 시도해 주세요.",
  nocamera: "이 기기에서 카메라를 찾지 못했어요. 스캐너 입력으로 바꿔 주세요.",
  error: "카메라를 켜지 못했어요. 다시 시도하거나 스캐너 입력으로 바꿔 주세요.",
};

export function cameraProblemText(problem: CameraProblem): string {
  return PROBLEM_TEXT[problem];
}

export function classifyCameraError(err: unknown): CameraProblem {
  const text = err instanceof Error ? `${err.name} ${err.message}` : String(err ?? "");
  if (/NotAllowed|Permission|denied/i.test(text)) return "denied";
  if (/NotFound|not found|DevicesNotFound|OverconstrainedError/i.test(text)) return "nocamera";
  return "error";
}

export function CameraScanner({ onDecode, onError }: { onDecode: (text: string) => void; onError: (problem: CameraProblem) => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onDecodeRef = useRef(onDecode);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onDecodeRef.current = onDecode;
    onErrorRef.current = onError;
  }, [onDecode, onError]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      onErrorRef.current(window.isSecureContext ? "nocamera" : "insecure");
      return;
    }
    const mount = document.createElement("div");
    mount.id = `terminal-camera-${Math.random().toString(36).slice(2, 10)}`;
    mount.className = "size-full";
    host.appendChild(mount);

    let stopped = false;
    let scanner: import("html5-qrcode").Html5Qrcode | null = null;
    const started = (async () => {
      const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import("html5-qrcode");
      if (stopped) return;
      scanner = new Html5Qrcode(mount.id, {
        verbose: false,
        formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
        useBarCodeDetectorIfSupported: true,
      });
      try {
        await scanner.start(
          { facingMode: "environment" },
          {
            fps: 12,
            qrbox: (w: number, h: number) => {
              const side = Math.max(160, Math.floor(Math.min(w, h) * 0.72));
              return { width: side, height: side };
            },
          },
          (text: string) => {
            if (!stopped) onDecodeRef.current(text);
          },
          () => undefined,
        );
      } catch (err) {
        if (!stopped) onErrorRef.current(classifyCameraError(err));
      }
    })();

    return () => {
      stopped = true;
      void started.finally(async () => {
        try {
          if (scanner?.isScanning) await scanner.stop();
          scanner?.clear();
        } catch {
          /* 이미 멈춘 카메라 */
        }
        mount.remove();
      });
    };
  }, []);

  return (
    <div
      ref={hostRef}
      aria-label="카메라 화면 — 관객의 티켓 QR을 네모 안에 비춰 주세요"
      className="relative aspect-square w-full overflow-hidden rounded-2xl bg-black [&_video]:size-full [&_video]:object-cover"
    />
  );
}
