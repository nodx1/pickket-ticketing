"use client";

import { Lock, Unlock } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { ko } from "date-fns/locale";
import { useTranslations } from "next-intl";
import type { FileLock } from "./use-dev-stream";

interface Props {
  locks: Record<string, FileLock>;
}

export function FileLockMap({ locks }: Props) {
  const t = useTranslations("dev.fileLockMap");
  const entries = Object.entries(locks);

  if (entries.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-[var(--pk-border)] p-6 text-center">
        <Unlock className="h-5 w-5 mx-auto text-[var(--pk-text-secondary)] mb-2" />
        <p className="text-sm text-[var(--pk-text-secondary)]">
          {t("noLockedFiles")}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[var(--pk-border)] bg-[var(--pk-surface)] overflow-hidden">
      <div className="divide-y divide-[var(--pk-border)]">
        {entries.map(([fp, lock]) => {
          let ago = "-";
          try {
            ago = formatDistanceToNow(new Date(lock.locked_at), {
              addSuffix: true,
              locale: ko,
            });
          } catch {}

          return (
            <div
              key={fp}
              className="flex items-center gap-3 px-4 py-3 hover:bg-[var(--pk-bg)] transition-colors"
            >
              <Lock className="h-4 w-4 text-[var(--pk-hot)] shrink-0" />
              <span className="flex-1 text-sm font-mono text-[var(--pk-text)] truncate">
                {fp}
              </span>
              <div className="text-right shrink-0">
                <p className="text-xs font-medium text-[var(--pk-accent-light)]">
                  {lock.developer}
                </p>
                <p className="text-xs text-[var(--pk-text-secondary)]">
                  {lock.branch || "-"}
                </p>
              </div>
              <span className="text-xs text-[var(--pk-text-secondary)] shrink-0 hidden sm:block">
                {ago}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
