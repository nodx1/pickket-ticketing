"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@pickket/ui";
import {
  Users,
  Ticket,
  UserCheck,
  BarChart3,
  Shield,
  Hash,
  Calendar,
  MapPin,
  AlertTriangle,
  Loader2,
  Landmark,
} from "lucide-react";
import api from "@pickket/lib/api";

/* ── Types ─────────────────────────────────────────────────────────────── */

interface PublicReport {
  event_title: string;
  event_date: string;
  venue: string;
  location_city?: string;
  total_seats: number;
  tickets_issued: number;
  checked_in: number;
  attendance_rate: number;
  no_show_count: number;
  deposit_amount?: number;
  deposit_forfeited_total?: number;
  lottery?: {
    total_applicants: number;
    competition_ratio: number;
    seed: string;
  };
}

/* ── Helpers ───────────────────────────────────────────────────────────── */

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatNumber(value: number): string {
  return value.toLocaleString("ko-KR");
}

/* ── Page ──────────────────────────────────────────────────────────────── */

export default function PublicReportPage() {
  const t = useTranslations("event.publicReport");
  const params = useParams();
  const eventId = params.id as string;

  const [report, setReport] = useState<PublicReport | null>(null);
  const [loading, setLoading] = useState(true);
  // 🔴 번역된 문구가 아니라 **서버가 준 detail** 만 담는다(없으면 null).
  //    번역은 렌더 시점에 한다 — 옛 방식은 fetch 시점 언어로 굳었고,
  //    useCallback 이 t 를 가둬 React Compiler 가 최적화를 포기했다.
  const [error, setError] = useState<{ detail: string | null } | null>(null);

  const loadReport = useCallback(() => {
    if (!eventId) return;

    setLoading(true);
    setError(null);

    api
      .get(`/events/${eventId}/public-report`)
      .then((res) => {
        setReport(res.data);
      })
      .catch((err) => {
        // ⚠️ `??` 가 아니라 `||` 다 — 옛 코드가 `detail || t("loadError")` 였으므로
        //    빈 문자열도 "없음" 으로 봐야 한다. `??` 로 바꾸면 빈칸이 그대로 보인다.
        setError({ detail: err?.response?.data?.detail || null });
      })
      .finally(() => setLoading(false));
  }, [eventId]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      loadReport();
    }, 0);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [loadReport]);

  /* ── Loading state ───────────────────────────────────────────────────── */

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto pt-20 pb-16 px-4">
        <div className="flex flex-col items-center justify-center py-24">
          <Loader2 className="h-8 w-8 text-primary animate-spin mb-4" />
          <p className="text-muted-foreground">{t("loading")}</p>
        </div>
      </div>
    );
  }

  /* ── Error state ─────────────────────────────────────────────────────── */

  if (error || !report) {
    return (
      <div className="max-w-4xl mx-auto pt-20 pb-16 px-4">
        <div className="text-center py-24">
          <AlertTriangle className="h-12 w-12 text-muted-foreground/30 mx-auto mb-4" />
          <p className="text-lg text-muted-foreground">
            {error ? (error.detail ?? t("loadError")) : t("notFound")}
          </p>
        </div>
      </div>
    );
  }

  /* ── Render ──────────────────────────────────────────────────────────── */

  return (
    <div className="max-w-4xl mx-auto pt-20 pb-8 px-4">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-2 mb-4">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary">
            <Shield className="h-4 w-4 text-white" />
          </div>
          <span className="text-sm font-medium text-primary">
            {t("badgeLabel")}
          </span>
        </div>

        <h1 className="text-2xl md:text-3xl font-bold text-foreground mb-3">
          {report.event_title}
        </h1>

        <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <Calendar className="h-4 w-4" />
            <span>{formatDate(report.event_date)}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <MapPin className="h-4 w-4" />
            <span>
              {report.venue}
              {report.location_city && ` \u00B7 ${report.location_city}`}
            </span>
          </div>
        </div>
      </div>

      {/* Divider */}
      <div className="h-px bg-border mb-8" />

      {/* Key Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <Card className="border-0 shadow-[0_2px_16px_rgba(0,0,0,0.06)]">
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center gap-2 mb-2">
              <Users className="h-4 w-4 text-primary" />
              <span className="text-xs text-muted-foreground font-medium">
                {t("statTotalSeats")}
              </span>
            </div>
            <p className="text-2xl font-bold text-foreground">
              {formatNumber(report.total_seats)}
            </p>
          </CardContent>
        </Card>

        <Card className="border-0 shadow-[0_2px_16px_rgba(0,0,0,0.06)]">
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center gap-2 mb-2">
              <Ticket className="h-4 w-4 text-[#404040]" />
              <span className="text-xs text-muted-foreground font-medium">
                {t("statTicketsIssued")}
              </span>
            </div>
            <p className="text-2xl font-bold text-[#404040]">
              {formatNumber(report.tickets_issued)}
            </p>
          </CardContent>
        </Card>

        <Card className="border-0 shadow-[0_2px_16px_rgba(0,0,0,0.06)]">
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center gap-2 mb-2">
              <UserCheck className="h-4 w-4 text-cyan" />
              <span className="text-xs text-muted-foreground font-medium">
                {t("statCheckedIn")}
              </span>
            </div>
            <p className="text-2xl font-bold text-cyan">
              {formatNumber(report.checked_in)}
            </p>
          </CardContent>
        </Card>

        <Card className="border-0 shadow-[0_2px_16px_rgba(0,0,0,0.06)]">
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center gap-2 mb-2">
              <BarChart3 className="h-4 w-4 text-primary" />
              <span className="text-xs text-muted-foreground font-medium">
                {t("statAttendanceRate")}
              </span>
            </div>
            <p className="text-2xl font-bold text-primary">
              {formatPercent(report.attendance_rate)}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Lottery Info */}
      {report.lottery && (
        <Card className="mb-6 border-0 shadow-[0_2px_16px_rgba(0,0,0,0.06)]">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <Landmark className="h-4 w-4 text-primary" />
              {t("lotteryTitle")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div>
                <p className="text-xs text-muted-foreground font-medium mb-1">
                  {t("lotteryTotalApplicants")}
                </p>
                <p className="text-xl font-bold text-foreground">
                  {formatNumber(report.lottery.total_applicants)}{t("unitPerson")}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground font-medium mb-1">
                  {t("lotteryCompetitionRatio")}
                </p>
                <p className="text-xl font-bold text-foreground">
                  {report.lottery.competition_ratio.toFixed(2)} : 1
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground font-medium mb-1">
                  {t("lotterySeed")}
                </p>
                <div className="flex items-center gap-2">
                  <Hash className="h-4 w-4 text-muted-foreground" />
                  <code className="text-sm font-mono bg-white/10 px-3 py-1 rounded-lg text-foreground break-all">
                    {report.lottery.seed}
                  </code>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* No-show & Deposit Info */}
      <Card className="mb-6 border-0 shadow-[0_2px_16px_rgba(0,0,0,0.06)]">
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-warning" />
            {t("noShowDepositTitle")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div>
              <p className="text-xs text-muted-foreground font-medium mb-1">
                {t("noShowCount")}
              </p>
              <p className="text-xl font-bold text-warning">
                {formatNumber(report.no_show_count)}{t("unitPerson")}
              </p>
            </div>
            {report.deposit_amount != null && report.deposit_amount > 0 && (
              <div>
                <p className="text-xs text-muted-foreground font-medium mb-1">
                  {t("depositPerPerson")}
                </p>
                <p className="text-xl font-bold text-foreground">
                  {"\u20A9"}
                  {formatNumber(report.deposit_amount)}
                </p>
              </div>
            )}
            {report.deposit_forfeited_total != null &&
              report.deposit_forfeited_total > 0 && (
                <div>
                  <p className="text-xs text-muted-foreground font-medium mb-1">
                    {t("depositForfeitedTotal")}
                  </p>
                  <p className="text-xl font-bold text-red-500">
                    {"\u20A9"}
                    {formatNumber(report.deposit_forfeited_total)}
                  </p>
                </div>
              )}
          </div>
        </CardContent>
      </Card>

      {/* Footer */}
      <div className="text-center pt-6 pb-4">
        <p className="text-xs text-muted-foreground/60">
          {t("footerDescription")}
        </p>
        <p className="text-xs text-muted-foreground/40 mt-1">
          {t("footerBrand")}
        </p>
      </div>
    </div>
  );
}
