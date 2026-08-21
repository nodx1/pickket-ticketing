"use client";

import { useTranslations } from "next-intl";
import { CheckCircle2, Circle } from "lucide-react";

interface TransferTimelineProps {
  status: string;
}

function getActiveIndex(status: string): number {
  if (status === "completed") return 3;
  if (status === "identity_verified") return 2;
  if (status === "initiated") return 1;
  return 0;
}

export default function TransferTimeline({ status }: TransferTimelineProps) {
  const t = useTranslations("transfer.timeline");

  const STEPS = [
    t("stepInitiated"),
    t("stepIdentity"),
    t("stepVerified"),
    t("stepCompleted"),
  ];

  if (status === "cancelled") {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
        {t("cancelled")}
      </div>
    );
  }

  const activeIndex = getActiveIndex(status);

  return (
    <div className="grid gap-2">
      {STEPS.map((label, idx) => {
        const done = idx < activeIndex;
        const active = idx === activeIndex;

        return (
          <div key={label} className="flex items-center gap-2 text-sm">
            {done ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <Circle className={active ? "h-4 w-4 text-amber-600 dark:text-amber-400" : "h-4 w-4 text-muted-foreground"} />
            )}
            <span className={active ? "font-semibold text-foreground" : "text-muted-foreground"}>
              {label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
