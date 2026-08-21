"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { useTranslations } from "next-intl";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("errors.globalError");
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);
  return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center text-center px-4">
      <h2 className="text-xl font-bold text-foreground mb-2">
        {t("title")}
      </h2>
      <p className="text-sm text-muted-foreground mb-6">
        {t("description")}
      </p>
      <button
        onClick={reset}
        className="rounded-full bg-primary hover:bg-brand-hover text-white px-6 py-2.5 text-sm font-semibold transition-colors"
      >
        {t("retry")}
      </button>
    </div>
  );
}
