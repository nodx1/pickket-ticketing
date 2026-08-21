"use client";

import * as React from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

import { cn } from "@pickket/lib/utils";
import { Button } from "./button";

const ERROR_MESSAGES: Record<string, { title: string; description: string }> = {
  "401": {
    title: "인증이 필요합니다",
    description: "로그인 후 다시 시도해 주세요.",
  },
  "403": {
    title: "접근 권한이 없습니다",
    description: "이 페이지에 접근할 수 있는 권한이 없습니다.",
  },
  "404": {
    title: "페이지를 찾을 수 없습니다",
    description: "요청하신 페이지가 존재하지 않거나 삭제되었습니다.",
  },
  "500": {
    title: "서버 오류가 발생했습니다",
    description:
      "잠시 후 다시 시도해 주세요. 문제가 지속되면 고객센터에 문의해 주세요.",
  },
  "502": {
    title: "서버에 연결할 수 없습니다",
    description: "잠시 후 다시 시도해 주세요.",
  },
  "503": {
    title: "서비스 점검 중입니다",
    description: "잠시 후 다시 이용해 주세요.",
  },
  default: {
    title: "오류가 발생했습니다",
    description: "예상치 못한 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.",
  },
};

function getErrorCode(error: Error): string | null {
  // Check for status code in error message (e.g. "Request failed with status code 404")
  const match = error.message.match(/(\d{3})/);
  if (match && ERROR_MESSAGES[match[1]]) return match[1];
  // Check for common error properties
  if ("statusCode" in error) return String((error as any).statusCode);
  if ("status" in error) return String((error as any).status);
  return null;
}

interface ErrorBoundaryFallbackProps {
  error: Error;
  resetErrorBoundary: () => void;
  className?: string;
}

function ErrorBoundaryFallback({
  error,
  resetErrorBoundary,
  className,
}: ErrorBoundaryFallbackProps) {
  const code = getErrorCode(error);
  const messages =
    (code ? ERROR_MESSAGES[code] : undefined) ?? ERROR_MESSAGES["default"]!;

  return (
    <div
      role="alert"
      data-slot="error-fallback"
      className={cn(
        "flex flex-col items-center justify-center gap-3 py-16 px-4 text-center",
        className,
      )}
    >
      <div className="flex size-14 items-center justify-center rounded-full bg-destructive/10 dark:bg-destructive/20">
        <AlertTriangle className="size-7 text-destructive" />
      </div>
      <div className="space-y-1">
        <h3 className="text-base font-semibold text-foreground">
          {messages.title}
        </h3>
        <p className="text-sm text-muted-foreground">{messages.description}</p>
        {code && (
          <p className="text-xs text-muted-foreground/60">오류 코드: {code}</p>
        )}
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={resetErrorBoundary}
        className="mt-2 gap-1.5"
      >
        <RefreshCw className="size-3.5" />
        다시 시도
      </Button>
    </div>
  );
}

export { ErrorBoundaryFallback, type ErrorBoundaryFallbackProps };
