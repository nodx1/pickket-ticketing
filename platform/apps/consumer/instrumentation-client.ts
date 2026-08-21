import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN || "",
  tracesSampleRate: 0.1,
  environment: process.env.NODE_ENV,
  enabled: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
});

type RouterTransitionHook = (...args: unknown[]) => void;

const sentryRouterTransitionHook =
  (Sentry as typeof Sentry & { captureRouterTransitionStart?: RouterTransitionHook })
    .captureRouterTransitionStart;

export const onRouterTransitionStart: RouterTransitionHook = (...args) => {
  if (typeof sentryRouterTransitionHook === "function") {
    sentryRouterTransitionHook(...args);
  }
};
