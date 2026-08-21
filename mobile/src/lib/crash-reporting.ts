/**
 * Sentry 크래시 리포팅 + 글로벌 에러 핸들러
 *
 * 프로덕션 크래시 수집 및 모니터링.
 * __DEV__ 환경에서는 콘솔 출력만 수행.
 */
import * as Sentry from "@sentry/react-native";
import { env } from "@/config/env";

let isInitialized = false;

/**
 * 앱 시작 시 1회 호출 — Sentry 초기화 + ErrorUtils 글로벌 핸들러 연결
 */
export function initCrashReporting(): void {
  if (isInitialized) return;
  isInitialized = true;

  if (__DEV__) return;

  Sentry.init({
    dsn: env.SENTRY_DSN ?? "",
    release: `kr.pickket.app@${env.APP_VERSION}`,
    environment: __DEV__ ? "development" : "production",
    tracesSampleRate: 0.2,
    enableAutoSessionTracking: true,
    attachStacktrace: true,
    beforeBreadcrumb(breadcrumb) {
      if (breadcrumb.category === "http" || breadcrumb.category === "fetch") {
        if (breadcrumb.data) {
          delete breadcrumb.data["Authorization"];
          delete breadcrumb.data["authorization"];
          if (typeof breadcrumb.data["url"] === "string" && breadcrumb.data["url"].includes("/auth/")) {
            delete breadcrumb.data["request_body"];
            delete breadcrumb.data["response_body"];
          }
        }
      }
      return breadcrumb;
    },
    beforeSend(event) {
      // /auth/* 요청의 body / cookie 는 항상 스크럽
      if (event.request?.url?.includes("/auth/")) {
        delete event.request.data;
        delete event.request.cookies;
      }
      // Authorization 헤더 리다이렉트
      const headers = event.request?.headers;
      if (headers && typeof headers === "object" && "Authorization" in headers) {
        (headers as Record<string, string>)["Authorization"] = "Bearer [REDACTED]";
      }
      const scrub = (s: string): string =>
        s
          .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[EMAIL]")
          .replace(/\b01[0-9]{8,9}\b/g, "[PHONE]")
          .replace(
            /\bey[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g,
            "[JWT]",
          );
      if (event.message && typeof event.message === "string") {
        event.message = scrub(event.message);
      }
      return event;
    },
  });

  // React Native 글로벌 에러 핸들러 연결
  const defaultHandler = ErrorUtils.getGlobalHandler();
  ErrorUtils.setGlobalHandler((error: Error, isFatal?: boolean) => {
    Sentry.captureException(error, {
      tags: { fatal: String(isFatal ?? false) },
    });
    defaultHandler(error, isFatal);
  });

  // AUDIT §15 P1: 미처리 Promise rejection 글로벌 핸들러
  // React Native의 Promise rejection tracking은 별도 등록 필요
  const tracking = require("promise/setimmediate/rejection-tracking");
  tracking.enable({
    allRejections: true,
    onUnhandled: (id: number, error: unknown) => {
      const err = error instanceof Error ? error : new Error(String(error));
      Sentry.captureException(err, {
        tags: { type: "unhandled_promise_rejection", rejectionId: String(id) },
      });
    },
    onHandled: () => {
      // 뒤늦게 핸들된 rejection — 무시
    },
  });
}

/**
 * 수동 에러 보고 — ErrorBoundary, catch 블록 등에서 호출
 */
export function reportError(
  error: unknown,
  context?: Record<string, unknown>,
): void {
  if (__DEV__) {
    console.error("[CrashReporting]", error, context);
    return;
  }

  const err = error instanceof Error ? error : new Error(String(error));
  Sentry.captureException(err, {
    extra: context,
  });
}
