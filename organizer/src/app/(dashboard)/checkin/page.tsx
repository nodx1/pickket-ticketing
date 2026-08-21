"use client";

/**
 * 현장 입장 QR 체크인 페이지 (스태프/admin 전용).
 *
 * 흐름:
 *   1. 카메라 켜기 (모바일 후면 카메라 우선)
 *   2. QR 자동 인식 → v2 backend /api/v1/tickets/validate-qr 호출
 *   3. 결과 표시 (입장 성공/이미 입장/무효)
 *
 * 인증: (dashboard) layout 이 getServerSession 으로 검증 — 미로그인 시 자동 /login 리다이렉트.
 * 권한: v2 backend 가 자동 검증 (event organizer 또는 admin 만 통과).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchWithRefresh } from "@/lib/fetchWithAuth";
import { Html5Qrcode } from "html5-qrcode";
import { CheckCircle2, XCircle, AlertTriangle, Camera, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

type Phase = "idle" | "scanning" | "result" | "no-permission";

interface ValidateResult {
  status: "ok" | "already_used" | "invalid";
  message: string;
  ticket_id?: string | null;
  attendee_name?: string | null;
  event_title?: string | null;
  tier_name?: string | null;
  seat_label?: string | null;
  checked_in_at?: string | null;
}

const SCANNER_ID = "qr-reader";

// v2 backend 직접 호출 (.pickket.kr 도메인 쿠키 자동 전송).
const V2_API = process.env.NEXT_PUBLIC_V2_API_URL;

function getCsrfToken(): string {
  if (typeof document === "undefined") return "";
  const match = document.cookie.match(/(?:^|;\s*)pickket_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

async function callValidate(qrPayload: string): Promise<ValidateResult> {
  if (!V2_API) {
    return {
      status: "invalid",
      message: "체크인 API URL이 설정되지 않았습니다",
    };
  }

  // 🔴 401 이면 **스태프가 아무것도 안 해도** 갱신 후 자동 재시도한다 (2026-07-31).
  //    access 쿠키는 5분이라 스태프가 잠깐 쉬면 사라진다. 종전엔 그 401 이
  //    `검증 실패 (401)` 로 떨어져 **위조 티켓과 똑같은 빨간 X** 가 됐다 —
  //    게이트 앞에서 정상 손님을 돌려보내게 된다.
  //
  //    ⚠️ 재시도는 **찍힌 그 payload 로** 한다. 회전 QR 은 몇 초마다 값이 바뀌므로
  //       다시 읽으면 안 된다(인자로 받은 `qrPayload` 를 그대로 재사용).
  //    ⚠️ 헤더를 **함수로** 넘긴다. 갱신하면 `pickket_csrf` 도 새로 발급되므로
  //       같은 헤더를 재사용하면 낡은 CSRF 로 403 이 된다(빨간 X 가 다른 빨간 X 로 바뀔 뿐).
  //    ⚠️ 부작용 없음: v2 `validate_qr` 은 `Depends(get_current_user)` 라 401 이면
  //       핸들러 본문에 진입조차 못 한다 → **첫 시도가 입장 기록을 남기지 않는다**(실측 확인).
  const res = await fetchWithRefresh(`${V2_API}/api/v1/tickets/validate-qr`, () => ({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": getCsrfToken(),
    },
    body: JSON.stringify({ qr_payload: qrPayload }),
  }));
  if (!res.ok) {
    if (res.status === 403) {
      return { status: "invalid", message: "이 이벤트의 스태프 권한이 없습니다" };
    }
    if (res.status === 401) {
      // 갱신까지 실패한 경우 — 여기가 마지막 안내다.
      // 🔴 "만료" 라고 쓰지 않는다. 스태프가 **티켓이** 만료된 줄 안다.
      //    QR 은 60초 freshness 라(v2 `verify_qr(max_age_seconds=60)`) 재로그인 뒤에는
      //    다시 찍어야 한다.
      return {
        status: "invalid",
        message: "로그인이 만료되어 검증하지 못했습니다. 다시 로그인한 뒤 다시 스캔해 주세요",
      };
    }
    return { status: "invalid", message: `검증 실패 (${res.status})` };
  }
  return (await res.json()) as ValidateResult;
}

function ResultCard({
  result,
  onNext,
}: {
  result: ValidateResult;
  onNext: () => void;
}) {
  const icon =
    result.status === "ok" ? (
      <CheckCircle2 className="h-20 w-20 text-success" />
    ) : result.status === "already_used" ? (
      <AlertTriangle className="h-20 w-20 text-warning" />
    ) : (
      <XCircle className="h-20 w-20 text-destructive" />
    );

  const bg =
    result.status === "ok"
      ? "bg-success/10"
      : result.status === "already_used"
        ? "bg-warning/10"
        : "bg-destructive/10";

  return (
    <div className="flex flex-col items-center gap-4 p-6 text-center">
      <div className={`rounded-full p-6 ${bg}`}>{icon}</div>
      <h2 className="text-2xl font-bold">{result.message}</h2>
      {result.attendee_name && (
        <div className="w-full max-w-md rounded-2xl border border-border bg-card p-5 space-y-2 text-left">
          <div className="flex justify-between">
            <span className="text-sm text-muted-foreground">입장자</span>
            <span className="text-sm font-semibold">{result.attendee_name}</span>
          </div>
          {result.event_title && (
            <div className="flex justify-between">
              <span className="text-sm text-muted-foreground">이벤트</span>
              <span className="text-sm font-semibold">{result.event_title}</span>
            </div>
          )}
          {result.tier_name && (
            <div className="flex justify-between">
              <span className="text-sm text-muted-foreground">등급</span>
              <span className="text-sm font-semibold">{result.tier_name}</span>
            </div>
          )}
          {result.seat_label && (
            <div className="flex justify-between">
              <span className="text-sm text-muted-foreground">좌석</span>
              <span className="text-sm font-semibold">{result.seat_label}</span>
            </div>
          )}
          {result.checked_in_at && (
            <div className="flex justify-between">
              <span className="text-sm text-muted-foreground">입장 시각</span>
              <span className="text-sm font-semibold tabular-nums">
                {new Date(result.checked_in_at).toLocaleTimeString("ko-KR", {
                  timeZone: "Asia/Seoul",
                })}
              </span>
            </div>
          )}
        </div>
      )}
      <Button onClick={onNext} size="lg" className="mt-4 gap-2">
        <RotateCcw className="h-4 w-4" />
        다음 입장자 스캔
      </Button>
    </div>
  );
}

export default function CheckinPage() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<ValidateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const submittingRef = useRef(false);

  const stopScanner = useCallback(async () => {
    if (scannerRef.current) {
      try {
        await scannerRef.current.stop();
        scannerRef.current.clear();
      } catch {
        // ignore
      }
      scannerRef.current = null;
    }
  }, []);

  const handleScan = useCallback(
    async (qrText: string) => {
      if (submittingRef.current) return;
      submittingRef.current = true;
      await stopScanner();
      try {
        const res = await callValidate(qrText);
        setResult(res);
        setPhase("result");
      } catch (err: unknown) {
        setResult({
          status: "invalid",
          message:
            err instanceof Error ? err.message : "검증 중 오류가 발생했습니다",
        });
        setPhase("result");
      } finally {
        submittingRef.current = false;
      }
    },
    [stopScanner],
  );

  const startScanner = useCallback(async () => {
    setError(null);
    setResult(null);
    setPhase("scanning");
    try {
      const scanner = new Html5Qrcode(SCANNER_ID);
      scannerRef.current = scanner;
      await scanner.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        (decoded) => {
          void handleScan(decoded);
        },
        () => {
          // ignore per-frame decode errors
        },
      );
    } catch (err: unknown) {
      setPhase("no-permission");
      setError(
        err instanceof Error ? err.message : "카메라 권한을 허용해야 스캔할 수 있습니다",
      );
    }
  }, [handleScan]);

  useEffect(() => {
    return () => {
      void stopScanner();
    };
  }, [stopScanner]);

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] py-8">
      <div className="w-full max-w-md">
        <header className="mb-6 text-center">
          <h1 className="text-2xl font-bold">현장 입장 체크인</h1>
          <p className="text-sm text-muted-foreground mt-1">
            입장자의 QR 코드를 카메라로 스캔하면 자동 검증됩니다.
          </p>
        </header>

        {/*
          스캐너 컨테이너는 항상 DOM에 유지해야 html5-qrcode 가 element 를 찾을 수 있음.
          (phase === "scanning" 조건부 렌더링 시 setPhase 후 start() 가 즉시 실행되면
           아직 React 가 DOM 커밋 전이라 getElementById 실패 → getUserMedia 호출 못 가고
           카메라 권한 팝업도 안 뜨는 버그가 있었음.)
        */}
        <div
          id={SCANNER_ID}
          className={
            phase === "scanning"
              ? "w-full aspect-square rounded-2xl overflow-hidden bg-black"
              : "hidden"
          }
        />

        {phase === "idle" && (
          <div className="flex flex-col items-center gap-6 text-center">
            <Camera className="h-20 w-20 text-primary" />
            <p className="text-sm text-muted-foreground max-w-sm">
              스캐너 시작을 누르면 카메라 권한 요청 후 자동으로 인식합니다.
            </p>
            <Button onClick={startScanner} size="lg" className="px-8">
              스캐너 시작
            </Button>
          </div>
        )}

        {phase === "scanning" && (
          <div className="flex flex-col items-center gap-3">
            <p className="text-sm text-muted-foreground mb-2">
              QR 코드를 화면 가운데 비춰주세요
            </p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void stopScanner();
                setPhase("idle");
              }}
              className="mt-2"
            >
              취소
            </Button>
          </div>
        )}

        <div aria-live="polite" aria-atomic="true">
          {phase === "result" && result && (
            <ResultCard
              result={result}
              onNext={() => {
                setResult(null);
                void startScanner();
              }}
            />
          )}
        </div>

        {phase === "no-permission" && (
          <div className="flex flex-col items-center gap-4 text-center">
            <AlertTriangle className="h-16 w-16 text-warning" />
            <h2 className="text-xl font-bold">카메라 권한이 필요합니다</h2>
            <p className="text-sm text-muted-foreground">{error}</p>
            <p className="text-xs text-muted-foreground">
              브라우저 주소창 옆 자물쇠/설정 → 카메라 허용 후 다시 시도하세요.
            </p>
            <Button onClick={startScanner} className="mt-2">
              다시 시도
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
