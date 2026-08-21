"use client";

import { useCallback, useEffect, useState } from "react";
import { Clock, Loader2, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

interface QueueStatus {
  position: number;
  status: string;
  estimatedWait: number;
  accessToken?: string | null;
}

export interface QueueAdmission {
  sessionToken: string;
  accessToken: string | null;
  required: boolean;
}

export function QueueWaiting({
  eventId,
  onActivated,
}: {
  eventId: string;
  onActivated?: (admission: QueueAdmission) => void;
}) {
  const [sessionToken, setSessionToken] = useState("");
  const [status, setStatus] = useState<QueueStatus | null>(null);
  const [error, setError] = useState("");
  /**
   * 🔴 재시도 트리거 (2026-08-01).
   *
   * 종전엔 참여가 실패하면 **끝**이었다 — 구매 버튼은 "대기열 확인 중..." 으로 잠긴 채
   * 남고, 화면 어디에도 다시 시도할 방법이 없었다. 새로고침하라는 안내조차 없었다
   * (그 안내는 *상태 조회* 실패 문구에만 있었다). 네트워크가 한 번 튀면 그 손님은 못 산다.
   */
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    setError("");
    setStatus(null);
    setSessionToken("");
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    // AbortController: StrictMode 이중 실행 / eventId 변경 시 이전 요청 취소 (#16 수정).
    const controller = new AbortController();
    async function join() {
      try {
        const res = await fetch(`/api/events/${eventId}/public/queue/join`, {
          method: "POST",
          signal: controller.signal,
        });
        const data = (await res.json()) as {
          data?: {
            sessionToken: string;
            position: number;
            status: string;
            estimatedWait: number;
            accessToken?: string | null;
          };
          error?: string;
        };
        if (!res.ok || !data.data) {
          throw new Error(data.error ?? "queue join failed");
        }
        setSessionToken(data.data.sessionToken);
        setStatus({
          position: data.data.position,
          status: data.data.status,
          estimatedWait: data.data.estimatedWait,
          accessToken: data.data.accessToken,
        });
        if (data.data.status === "active") {
          onActivated?.({
            sessionToken: data.data.sessionToken,
            accessToken: data.data.accessToken ?? null,
            required: Boolean(data.data.sessionToken),
          });
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") return;
        setError("대기열 참여에 실패했습니다. 잠시 후 다시 시도해 주세요.");
      }
    }
    void join();
    return () => {
      controller.abort();
    };
    // `attempt` 가 바뀌면 참여를 처음부터 다시 한다.
  }, [eventId, attempt]);

  useEffect(() => {
    if (!sessionToken) return;
    let failCount = 0;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/events/${eventId}/public/queue/status?token=${sessionToken}`);
        if (!res.ok) {
          failCount++;
          console.warn("대기열 상태 조회 실패:", res.status, `(${failCount}회)`);
          if (failCount >= 5) {
            clearInterval(interval);
            setError("대기열 상태를 확인할 수 없습니다. 페이지를 새로고침해주세요.");
          }
          return;
        }
        failCount = 0;
        const data = (await res.json()) as { data: QueueStatus };
        setStatus(data.data);
        if (data.data.status === "active") {
          clearInterval(interval);
          onActivated?.({
            sessionToken,
            accessToken: data.data.accessToken ?? null,
            required: true,
          });
        }
      } catch {
        failCount++;
        if (failCount >= 5) {
          clearInterval(interval);
          setError("대기열 상태를 확인할 수 없습니다. 페이지를 새로고침해주세요.");
        }
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [eventId, sessionToken, onActivated]);

  if (error) {
    return (
      <Card className="border-destructive/40">
        <CardContent className="space-y-4 p-8 text-center">
          <p className="text-sm text-destructive">{error}</p>
          {/* 🔴 여기 버튼이 없으면 손님은 구매를 포기하는 것 말고 할 수 있는 게 없다. */}
          <Button type="button" variant="outline" onClick={retry} className="gap-2">
            <RotateCw className="size-4" />
            다시 시도
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!status) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center gap-2 p-8">
          <Loader2 className="size-5 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">대기열에 참여하는 중...</p>
        </CardContent>
      </Card>
    );
  }

  if (status.status === "active") {
    return null;
  }

  return (
    <Card className="border-primary/30">
      <CardContent className="space-y-6 p-8 text-center">
        <div>
          <p className="text-sm text-muted-foreground">현재 대기 순번</p>
          <p className="mt-2 text-5xl font-black tracking-[-0.04em] text-foreground">
            {status.position}
          </p>
        </div>

        <div className="mx-auto h-2 w-full max-w-xs rounded-full bg-muted/30">
          <div
            className="h-2 rounded-full bg-gradient-to-r from-primary to-accent transition-all"
            style={{ width: `${Math.max(5, 100 - status.position * 2)}%` }}
          />
        </div>

        <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Clock className="size-4" />
          <span>예상 대기 시간: 약 {Math.max(1, Math.round(status.estimatedWait / 60))}분</span>
        </div>

        <p className="text-xs text-muted-foreground">
          페이지를 닫지 마세요. 순번이 되면 자동으로 구매 페이지로 이동합니다.
        </p>
      </CardContent>
    </Card>
  );
}
