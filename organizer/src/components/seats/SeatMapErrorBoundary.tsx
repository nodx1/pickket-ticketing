"use client";

/**
 * SeatMapErrorBoundary — 트랙 7.5
 *
 * SeatMap / SeatMapWebGL 등 좌석 렌더링 컴포넌트에서 발생한 런타임 에러를 격리.
 * - WebGL 컨텍스트 lost
 * - PixiJS / opencv.js / tfjs 모듈 로드 실패
 * - 치명적 hit-test 에러
 *
 * 에러 발생 시 사용자에게 폴백 UI 표시 + Sentry 로깅 (선택).
 */

import React, { Component, type ErrorInfo, type ReactNode } from "react";
import { fetchWithRefresh } from "@/lib/fetchWithAuth";

interface Props {
  children: ReactNode;
  /** 에러 발생 시 호출 — Sentry/메트릭 전송 등 */
  onError?: (error: Error, info: ErrorInfo) => void;
  /** 폴백 UI — 미지정 시 기본 UI */
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  errorMessage: string;
}

export class SeatMapErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, errorMessage: "" };

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      errorMessage: error.message || "좌석 렌더링 중 오류가 발생했습니다",
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Sentry / 메트릭 훅
    if (this.props.onError) {
      this.props.onError(error, info);
    }
    // 콘솔 출력 (개발 모드)
    if (process.env.NODE_ENV !== "production") {
      console.error("[SeatMapErrorBoundary]", error, info);
    }
    // Prometheus 메트릭 — 가능하면 비동기 fetch
    if (typeof window !== "undefined") {
      try {
        void fetchWithRefresh("/api/metrics/seat-error", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: error.message,
            stack: error.stack?.slice(0, 500),
            componentStack: info.componentStack?.slice(0, 500),
          }),
        }).catch(() => {
          /* 메트릭 실패는 무시 */
        });
      } catch {
        /* noop */
      }
    }
  }

  reset = () => {
    this.setState({ hasError: false, errorMessage: "" });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div
          role="alert"
          className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center"
        >
          <p className="text-base font-semibold text-destructive">
            좌석 화면을 표시할 수 없습니다
          </p>
          <p className="text-sm text-muted-foreground">
            {this.state.errorMessage}
          </p>
          <p className="text-xs text-muted-foreground">
            잠시 후 새로고침하거나, 문제가 계속되면 고객센터로 문의해주세요.
          </p>
          <button
            type="button"
            onClick={this.reset}
            className="rounded-full border border-border bg-background px-4 py-1 text-sm font-medium text-foreground hover:border-primary hover:text-primary"
          >
            다시 시도
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
