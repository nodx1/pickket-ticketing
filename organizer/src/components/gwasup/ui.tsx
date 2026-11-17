"use client";

/**
 * 과업 화면 공통 조각 — 디자인 토큰(globals.css)만 쓴다.
 *   PageHeader   페이지 제목(58개 파일에 복사된 제목 스타일을 한 곳으로 — UI 감사 P-4)
 *   StatCard     숫자 카드
 *   HashText     해시값(앞뒤만 보이고 눌러서 복사)
 *   Timeline     단계 진행(정책 고정 → 시드 커밋 → … → 증명서)
 *   Pill         상태 표시
 */
import { useState, type ReactNode } from "react";
import { Check, Copy, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 max-w-3xl">
        {eyebrow ? <p className="text-sm text-content-subtle">{eyebrow}</p> : null}
        <h1 className="mt-1 text-3xl font-black tracking-[-0.04em] text-foreground">{title}</h1>
        {description ? <div className="mt-2 text-sm leading-6 text-content-subtle">{description}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Section({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-lg border border-border bg-card p-5 shadow-sm", className)}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-foreground">{title}</h2>
          {description ? <p className="mt-1 text-sm text-content-subtle">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: LucideIcon;
  tone?: "default" | "success" | "warning" | "danger" | "primary";
}) {
  const toneClass = {
    default: "bg-bg-muted text-content-subtle",
    success: "bg-success/10 text-success",
    warning: "bg-warning/10 text-warning",
    danger: "bg-destructive/10 text-destructive",
    primary: "bg-primary/10 text-primary",
  }[tone];
  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-content-subtle">{label}</p>
        {Icon ? (
          <span className={cn("flex size-7 items-center justify-center rounded-md", toneClass)}>
            <Icon className="size-4" />
          </span>
        ) : null}
      </div>
      <p className="mt-2 text-2xl font-black tracking-[-0.03em] text-foreground tabular-nums">{value}</p>
      {hint ? <p className="mt-1 text-xs text-content-subtle">{hint}</p> : null}
    </div>
  );
}

export function HashText({ value, label, full = false }: { value: string | null | undefined; label?: string; full?: boolean }) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="text-sm text-content-subtle">—</span>;
  const shown = full || value.length <= 20 ? value : `${value.slice(0, 10)}…${value.slice(-8)}`;
  return (
    <button
      type="button"
      title={`${label ? `${label}: ` : ""}${value}\n눌러서 복사`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          /* 클립보드 권한 없음 — 무시 */
        }
      }}
      className="group inline-flex max-w-full items-center gap-1.5 rounded-md bg-bg-muted px-2 py-1 font-mono text-xs text-foreground transition hover:bg-bg-emphasis"
    >
      <span className={cn(full && "break-all text-left")}>{shown}</span>
      {copied ? <Check className="size-3.5 shrink-0 text-success" /> : <Copy className="size-3.5 shrink-0 text-content-subtle group-hover:text-foreground" />}
    </button>
  );
}

export interface TimelineStep {
  label: string;
  at: string | null | undefined;
  description?: string;
}

export function Timeline({ steps, format }: { steps: TimelineStep[]; format: (iso: string) => string }) {
  return (
    <ol className="relative space-y-3">
      {steps.map((s, i) => {
        const done = Boolean(s.at);
        return (
          <li key={s.label} className="flex gap-3">
            <div className="flex flex-col items-center">
              <span
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold",
                  done ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-content-subtle",
                )}
              >
                {done ? <Check className="size-3.5" /> : i + 1}
              </span>
              {i < steps.length - 1 ? <span className={cn("mt-1 h-full w-px", done ? "bg-primary/40" : "bg-border")} /> : null}
            </div>
            <div className="min-w-0 pb-1">
              <p className={cn("text-sm font-semibold", done ? "text-foreground" : "text-content-subtle")}>{s.label}</p>
              <p className="text-xs text-content-subtle">{s.at ? format(s.at) : "대기 중"}</p>
              {s.description ? <p className="mt-0.5 text-xs text-content-subtle">{s.description}</p> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function Pill({ tone = "default", children }: { tone?: "default" | "success" | "warning" | "danger" | "primary"; children: ReactNode }) {
  const cls = {
    default: "bg-bg-muted text-content-subtle",
    success: "bg-success/10 text-success",
    warning: "bg-warning/15 text-warning",
    danger: "bg-destructive/10 text-destructive",
    primary: "bg-primary/10 text-primary",
  }[tone];
  return <span className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold", cls)}>{children}</span>;
}

export function BarRow({ label, value, max, suffix, tone = "primary" }: { label: ReactNode; value: number; max: number; suffix?: string; tone?: "primary" | "success" | "danger" }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const bar = { primary: "bg-primary", success: "bg-success", danger: "bg-destructive" }[tone];
  return (
    <div className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3 text-sm">
      <span className="truncate text-content-subtle">{label}</span>
      <span className="h-2.5 overflow-hidden rounded-full bg-bg-muted">
        <span className={cn("block h-full rounded-full transition-[width] duration-500", bar)} style={{ width: `${pct}%` }} />
      </span>
      <span className="w-16 text-right font-semibold tabular-nums text-foreground">
        {value.toLocaleString("ko-KR", { maximumFractionDigits: 1 })}
        {suffix}
      </span>
    </div>
  );
}

export async function gw<T>(eventId: string, path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { fetchWithAuth } = await import("@/lib/fetchWithAuth");
  const { json, ...rest } = init ?? {};
  const res = await fetchWithAuth<{ success: boolean; data: T }>(`/api/events/${eventId}/gwasup/${path}`, {
    ...rest,
    headers: { ...(rest.headers ?? {}), ...(json !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  return res.data;
}
