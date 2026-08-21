"use client";

import { useTranslations } from "next-intl";

interface PromiseMicroStripProps {
  variant?: "muted" | "dark";
  className?: string;
}

export function PromiseMicroStrip({
  variant = "muted",
  className = "",
}: PromiseMicroStripProps) {
  const t = useTranslations("promise");

  // Try to use i18n key, fallback to hardcoded
  const text = (() => {
    try {
      return t("micro_strip");
    } catch {
      return "정직한 가격 · 잠긴 티켓 · 액면가 대기 · 진짜 팬 우선";
    }
  })();

  const colorClass =
    variant === "dark" ? "text-white/60" : "text-muted-foreground/70";

  return (
    <p className={`text-xs tracking-wide ${colorClass} ${className}`}>
      {text}
    </p>
  );
}
