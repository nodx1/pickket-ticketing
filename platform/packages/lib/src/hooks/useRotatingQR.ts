import { useCallback, useEffect, useRef, useState } from "react";
import type { TicketQrResponse } from "../api";

interface RotatingQRState {
  /** 현재 QR 페이로드 (QRCodeSVG의 value) */
  qrPayload: string;
  /** 다음 회전까지 남은 초 */
  secondsRemaining: number;
  /** TOTP 모드 여부 (서버 사이드 회전) */
  isTotp: boolean;
  /** 로딩 중 */
  loading: boolean;
}

/**
 * 서버 사이드 회전 QR 훅 — 서버에서 생성된 QR을 주기적으로 폴링.
 * TOTP seed는 서버에만 존재하며 클라이언트로 전송되지 않음.
 *
 * @param initialQrResponse - 최초 QR 응답 (null이면 로딩 상태)
 * @param fetchQr - QR 재요청 함수 (서버 폴링용)
 */
export function useRotatingQR(
  initialQrResponse: TicketQrResponse | null,
  fetchQr?: () => Promise<TicketQrResponse | null>,
): RotatingQRState {
  const [qrPayload, setQrPayload] = useState("");
  const [secondsRemaining, setSecondsRemaining] = useState(15);
  const [loading, setLoading] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fetchQrRef = useRef(fetchQr);
  fetchQrRef.current = fetchQr;

  // TOTP 모드: expires_in_seconds가 짧으면 (≤30초) 서버 사이드 회전으로 판단
  const isTotp = Boolean(
    initialQrResponse && initialQrResponse.expires_in_seconds <= 30 && fetchQr,
  );

  // 서버 폴링으로 QR 갱신
  const refreshFromServer = useCallback(async () => {
    if (!fetchQrRef.current) return;
    try {
      const fresh = await fetchQrRef.current();
      if (fresh) {
        setQrPayload(fresh.qr_data);
        setSecondsRemaining(fresh.expires_in_seconds);
        setLoading(false);
      }
    } catch {
      // 네트워크 오류 — 기존 QR 유지, 다음 주기에 재시도
    }
  }, []);

  useEffect(() => {
    if (!initialQrResponse) {
      setLoading(true);
      return;
    }

    // 초기 QR 설정
    setQrPayload(initialQrResponse.qr_data);
    setSecondsRemaining(initialQrResponse.expires_in_seconds);
    setLoading(false);

    if (isTotp) {
      // TOTP 모드: 매초 카운트다운 + 만료 전 서버 폴링
      let remaining = initialQrResponse.expires_in_seconds;

      intervalRef.current = setInterval(() => {
        remaining -= 1;
        if (remaining <= 2) {
          // 만료 임박 — 서버에서 새 QR 가져오기
          remaining = initialQrResponse.expires_in_seconds;
          refreshFromServer();
        }
        setSecondsRemaining(Math.max(0, remaining));
      }, 1000);
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [initialQrResponse, isTotp, refreshFromServer]);

  return { qrPayload, secondsRemaining, isTotp, loading };
}
