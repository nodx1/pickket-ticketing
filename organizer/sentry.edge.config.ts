import * as Sentry from "@sentry/nextjs";
import { scrubSentryEvent } from "@/lib/sentry-scrub";

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 0.1,
    environment: process.env.NODE_ENV,
    // PII 최소화 + 전송 전 스크럽. (감사 P1-22)
    sendDefaultPii: false,
    beforeSend: scrubSentryEvent,
  });
}
