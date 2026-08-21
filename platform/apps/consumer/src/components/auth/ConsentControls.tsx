"use client";

import type { ChangeEvent, ReactNode } from "react";
import Link from "next/link";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useTranslations } from "next-intl";

export function ConsentItem({
  inputId,
  detailsId,
  checked,
  onChange,
  label,
  required,
  linkHref,
  linkLabel,
  expanded,
  onToggleExpand,
  summary,
  children,
}: {
  inputId: string;
  detailsId?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  required: boolean;
  linkHref?: string;
  linkLabel?: string;
  expanded?: boolean;
  onToggleExpand?: () => void;
  summary?: string | null;
  children?: ReactNode;
}) {
  const t = useTranslations("auth.consentControls");
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-2 min-h-[36px]">
        <input
          id={inputId}
          type="checkbox"
          checked={checked}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            onChange(event.target.checked)
          }
          className="rounded accent-primary w-3.5 h-3.5 shrink-0"
        />
        <label
          htmlFor={inputId}
          className="text-sm text-foreground flex-1 cursor-pointer"
        >
          {label}
          {required ? (
            <span className="ml-1 text-xs font-medium text-primary">
              {t("required")}
            </span>
          ) : (
            <span className="ml-1 text-xs font-medium text-muted-foreground">
              {t("optional")}
            </span>
          )}
        </label>
        <div className="flex items-center gap-1.5 shrink-0">
          {onToggleExpand && (
            <button
              type="button"
              onClick={onToggleExpand}
              aria-label={
                expanded
                  ? t("collapseDetail", { label: label ?? "" })
                  : t("expandDetail", { label: label ?? "" })
              }
              aria-expanded={Boolean(expanded)}
              aria-controls={detailsId}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              {expanded ? (
                <ChevronUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
            </button>
          )}
          {linkHref && (
            <Link
              href={linkHref}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-primary hover:underline font-medium"
            >
              {linkLabel || t("view")}
            </Link>
          )}
        </div>
      </div>
      {expanded && summary && (
        <p
          id={detailsId}
          className="text-xs text-muted-foreground pl-6 leading-relaxed"
        >
          {summary}
        </p>
      )}
      {expanded && children && (
        <div id={detailsId ? `${detailsId}-extra` : undefined}>{children}</div>
      )}
    </div>
  );
}

export function SubToggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event: ChangeEvent<HTMLInputElement>) =>
          onChange(event.target.checked)
        }
        className="rounded accent-primary w-3 h-3"
      />
      <span className="text-xs text-muted-foreground">{label}</span>
    </label>
  );
}
