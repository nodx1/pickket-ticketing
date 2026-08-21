/**
 * 서버 사이드 회전 QR 훅
 * v2의 @pickket/lib/hooks/useRotatingQR.ts와 동일 로직
 *
 * AUDIT 2026-04-20 §13 P0:
 * - 디바이스 바인딩: axios interceptor가 모든 요청에 X-Device-Id 헤더 자동 주입.
 *   백엔드는 /tickets/{id}/bind-device에서 저장, /tickets/{id}/qr에서 일치 강제.
 * - 회전 윈도우: 서버 expires_in_seconds를 존중하되, 10초 이하일 때는
 *   최소 3초 전 refresh 시작 (과거: 2초 전) — 화면공유 리플레이 창 최소화.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { TicketQrResponse } from "@/config/api";

interface RotatingQRState {
  qrPayload: string;
  secondsRemaining: number;
  isTotp: boolean;
  loading: boolean;
  /** 회전 갱신이 네트워크 오류로 실패해 현재 QR 이 만료됐을 수 있음(P2-C19). UI 가 경고를 표시해야 함. */
  stale: boolean;
}

export function useRotatingQR(
  initialQrResponse: TicketQrResponse | null,
  fetchQr?: () => Promise<TicketQrResponse | null>,
): RotatingQRState {
  const [qrPayload, setQrPayload] = useState("");
  const [secondsRemaining, setSecondsRemaining] = useState(15);
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchQrRef = useRef(fetchQr);
  fetchQrRef.current = fetchQr;

  const isTotp = Boolean(
    initialQrResponse && initialQrResponse.expires_in_seconds <= 30 && fetchQr,
  );

  const refreshFromServer = useCallback(async () => {
    if (!fetchQrRef.current) return;
    try {
      const fresh = await fetchQrRef.current();
      if (fresh) {
        setQrPayload(fresh.qr_data);
        setSecondsRemaining(fresh.expires_in_seconds);
        // 서버 응답의 expires_in_seconds로 회전 주기 ref 갱신 — 다음 interval reset에 반영(P2-C2)
        serverPeriodRef.current = fresh.expires_in_seconds;
        setLoading(false);
        setStale(false);
      }
    } catch {
      // 네트워크 오류 — 기존 QR 은 만료됐을 수 있으므로 stale 표시(입장 거부 대비). 다음 주기 재시도.
      setStale(true);
    }
  }, []);

  // 서버가 갱신한 expires_in_seconds를 interval 내부에서 참조할 수 있도록 ref에 보관.
  // state(secondsRemaining)를 직접 참조하면 클로저가 초기값에 고착돼 서버 단축 값이 무시됨(P2-C2).
  const serverPeriodRef = useRef<number>(initialQrResponse?.expires_in_seconds ?? 15);
  useEffect(() => {
    if (initialQrResponse) {
      serverPeriodRef.current = initialQrResponse.expires_in_seconds;
    }
  }, [initialQrResponse]);

  useEffect(() => {
    if (!initialQrResponse) {
      setLoading(true);
      // fetchQr가 있으면 즉시 서버 호출 시도 — initialQrResponse=null 인 활성 티켓 무한 스피너 방지(P2-C15)
      if (fetchQrRef.current) {
        void refreshFromServer();
      }
      return;
    }

    setQrPayload(initialQrResponse.qr_data);
    setSecondsRemaining(initialQrResponse.expires_in_seconds);
    setLoading(false);

    if (isTotp) {
      let remaining = initialQrResponse.expires_in_seconds;
      // AUDIT §13 P0: 리플레이 창 축소 — 기존 2초 전 refresh → 3초 전.
      // 10초 미만 회전 시 특히 중요 (expires_in_seconds를 서버가 줄이면 자동 적용).
      const getRefreshLeadSec = () => (serverPeriodRef.current <= 10 ? 3 : 2);

      intervalRef.current = setInterval(() => {
        remaining -= 1;
        if (remaining <= getRefreshLeadSec()) {
          // 서버에서 갱신된 주기를 사용 — 서버가 30→10초로 단축해도 반영됨(P2-C2)
          remaining = serverPeriodRef.current;
          // jitter ±200ms로 thundering herd 방지
          const jitter = Math.random() * 400 - 200;
          timeoutRef.current = setTimeout(() => {
            void refreshFromServer().then(() => {
              // 서버 응답 후 serverPeriodRef가 갱신되므로 다음 reset에 반영됨
            });
          }, jitter);
        }
        setSecondsRemaining(Math.max(0, remaining));
      }, 1000);
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [initialQrResponse, isTotp, refreshFromServer]);

  return { qrPayload, secondsRemaining, isTotp, loading, stale };
}
