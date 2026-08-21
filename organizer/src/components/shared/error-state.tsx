"use client";

import { AlertTriangle, RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface ErrorStateProps {
  /** 기본: "불러오지 못했습니다" */
  title?: string;
  /** 기본 안내 문구. 서버 에러 메시지를 넣어도 됨. */
  description?: string;
  /** 재시도 핸들러 — 있으면 "다시 시도" 버튼 노출 */
  onRetry?: () => void;
}

/**
 * 데이터 로드 실패 공용 상태. `catch{}` 로 삼켜 빈 상태처럼 보이던 실패를
 * 명시적 에러+재시도로 드러낸다(감사 S2). EmptyState 와 시각 일관성 유지.
 */
export function ErrorState({
  title = "불러오지 못했습니다",
  description = "일시적인 오류일 수 있습니다. 잠시 후 다시 시도해주세요.",
  onRetry,
}: ErrorStateProps) {
  return (
    <Card className="border-dashed border-destructive/30">
      <CardHeader className="items-center text-center">
        <div className="mb-4 flex size-16 items-center justify-center rounded-full bg-destructive/12 text-destructive">
          <AlertTriangle aria-hidden="true" className="size-8" />
        </div>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5 text-center">
        <p className="text-sm leading-7 text-content-subtle">{description}</p>
        {onRetry ? (
          <Button variant="outline" onClick={onRetry}>
            <RefreshCcw className="size-4" />
            다시 시도
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
