"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button } from "@pickket/ui";
import { useTranslations } from "next-intl";

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("errors.adminError");

  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-6 px-4 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-destructive/10">
        <AlertTriangle className="h-8 w-8 text-destructive" />
      </div>
      <div className="space-y-2">
        <h2 className="text-lg font-bold text-foreground">
          {t("title")}
        </h2>
        <p className="text-sm text-muted-foreground max-w-md">
          {t("description")}
          <br />
          {t("contact")}
        </p>
      </div>
      <Button onClick={reset} variant="outline" className="rounded-full gap-2">
        <RotateCcw className="h-4 w-4" />
        {t("retry")}
      </Button>
    </div>
  );
}
