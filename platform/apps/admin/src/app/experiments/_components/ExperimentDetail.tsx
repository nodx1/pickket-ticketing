"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  ArrowLeft,
  Calendar,
  Loader2,
  Pause,
  Play,
  Square,
  Users,
} from "lucide-react";
import { Badge, Button } from "@pickket/ui";
import {
  getABTest,
  updateABTest,
  type ABTestDetail as ABTestDetailType,
  type ABTestStatus,
  type ABTestVariantResult,
} from "@pickket/lib/api";

interface Props {
  experimentId: string;
  onBack: () => void;
}

const STATUS_COLORS: Record<ABTestStatus, string> = {
  DRAFT: "secondary",
  RUNNING: "default",
  PAUSED: "outline",
  COMPLETED: "destructive",
};

export default function ExperimentDetail({ experimentId, onBack }: Props) {
  const t = useTranslations("experiment.detail");
  const [detail, setDetail] = useState<ABTestDetailType | null>(null);
  const [loading, setLoading] = useState(true);

  const STATUS_LABELS: Record<ABTestStatus, { label: string; color: string }> =
    {
      DRAFT: { label: t("statusDraft"), color: STATUS_COLORS.DRAFT },
      RUNNING: { label: t("statusRunning"), color: STATUS_COLORS.RUNNING },
      PAUSED: { label: t("statusPaused"), color: STATUS_COLORS.PAUSED },
      COMPLETED: {
        label: t("statusCompleted"),
        color: STATUS_COLORS.COMPLETED,
      },
    };

  const load = useCallback(async () => {
    try {
      const data = await getABTest(experimentId);
      setDetail(data);
    } catch {
      toast.error(t("loadError"));
    } finally {
      setLoading(false);
    }
  }, [experimentId, t]);

  useEffect(() => {
    load();
  }, [load]);

  const handleStatusChange = async (newStatus: ABTestStatus) => {
    try {
      await updateABTest(experimentId, { status: newStatus });
      toast.success(
        t("statusChanged", {
          label: STATUS_LABELS[newStatus].label ?? "",
        }),
      );
      load();
    } catch {
      toast.error(t("statusChangeError"));
    }
  };

  if (loading || !detail) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[40vh]">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const statusInfo = STATUS_LABELS[detail.status];
  const variants = detail.results?.variants || [];
  const totalAssignments = detail.results?.total_assignments || 0;

  // Find best performing variant
  const bestVariant = variants.reduce<ABTestVariantResult | null>(
    (best, v) => (!best || v.conversion_rate > best.conversion_rate ? v : best),
    null,
  );

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold">{detail.name}</h1>
            <Badge
              variant={
                statusInfo.color as
                  | "default"
                  | "secondary"
                  | "outline"
                  | "destructive"
              }
            >
              {statusInfo.label}
            </Badge>
          </div>
          {detail.description && (
            <p className="text-sm text-muted-foreground mt-1">
              {detail.description}
            </p>
          )}
        </div>
        <div className="flex gap-1">
          {detail.status === "DRAFT" && (
            <Button size="sm" onClick={() => handleStatusChange("RUNNING")}>
              <Play className="h-4 w-4 mr-1" />
              {t("actionStart")}
            </Button>
          )}
          {detail.status === "RUNNING" && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleStatusChange("PAUSED")}
              >
                <Pause className="h-4 w-4 mr-1" />
                {t("actionPause")}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => handleStatusChange("COMPLETED")}
              >
                <Square className="h-4 w-4 mr-1" />
                {t("actionComplete")}
              </Button>
            </>
          )}
          {detail.status === "PAUSED" && (
            <Button size="sm" onClick={() => handleStatusChange("RUNNING")}>
              <Play className="h-4 w-4 mr-1" />
              {t("actionResume")}
            </Button>
          )}
        </div>
      </div>

      {/* Meta info */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div className="p-4 border rounded-xl bg-card">
          <div className="text-xs text-muted-foreground mb-1">
            {t("metaTotalAssignments")}
          </div>
          <div className="text-xl font-bold flex items-center gap-1">
            <Users className="h-4 w-4 text-muted-foreground" />
            {totalAssignments.toLocaleString()}
          </div>
        </div>
        <div className="p-4 border rounded-xl bg-card">
          <div className="text-xs text-muted-foreground mb-1">
            {t("metaVariantCount")}
          </div>
          <div className="text-xl font-bold">{detail.variants.length}</div>
        </div>
        <div className="p-4 border rounded-xl bg-card">
          <div className="text-xs text-muted-foreground mb-1">
            {t("metaMetric")}
          </div>
          <div className="text-sm font-medium truncate">
            {detail.metric_key || "-"}
          </div>
        </div>
        <div className="p-4 border rounded-xl bg-card">
          <div className="text-xs text-muted-foreground mb-1">
            {t("metaTargetRate")}
          </div>
          <div className="text-xl font-bold">
            {detail.target_audience?.percentage ?? 100}%
          </div>
        </div>
      </div>

      {/* Date range */}
      {(detail.start_date || detail.end_date) && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-6">
          <Calendar className="h-4 w-4" />
          {detail.start_date &&
            new Date(detail.start_date).toLocaleDateString("ko-KR")}
          {detail.start_date && detail.end_date && " ~ "}
          {detail.end_date &&
            new Date(detail.end_date).toLocaleDateString("ko-KR")}
        </div>
      )}

      {/* Variant results table */}
      <h2 className="text-lg font-semibold mb-3">{t("variantResultsTitle")}</h2>
      {variants.length === 0 ? (
        <div className="text-center py-10 text-muted-foreground border rounded-xl">
          {t("noData")}
        </div>
      ) : (
        <div className="border rounded-xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="bg-muted/50 text-xs text-muted-foreground">
                <th className="text-left p-3 font-medium">{t("colVariant")}</th>
                <th className="text-right p-3 font-medium">{t("colAssignments")}</th>
                <th className="text-right p-3 font-medium">{t("colImpressions")}</th>
                <th className="text-right p-3 font-medium">{t("colConversions")}</th>
                <th className="text-right p-3 font-medium">{t("colConversionRate")}</th>
                <th className="text-right p-3 font-medium">{t("colAvgValue")}</th>
              </tr>
            </thead>
            <tbody>
              {variants.map((v) => {
                const isBest =
                  bestVariant?.name === v.name && variants.length > 1;
                return (
                  <tr
                    key={v.name}
                    className="border-t hover:bg-muted/30 transition-colors"
                  >
                    <td className="p-3">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{v.name}</span>
                        {isBest && (
                          <Badge variant="default" className="text-xs">
                            {t("badgeBest")}
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="p-3 text-right tabular-nums">
                      {v.assignments.toLocaleString()}
                    </td>
                    <td className="p-3 text-right tabular-nums">
                      {v.impressions.toLocaleString()}
                    </td>
                    <td className="p-3 text-right tabular-nums">
                      {v.conversions.toLocaleString()}
                    </td>
                    <td className="p-3 text-right tabular-nums font-medium">
                      {v.conversion_rate.toFixed(2)}%
                    </td>
                    <td className="p-3 text-right tabular-nums text-muted-foreground">
                      {v.avg_value != null ? v.avg_value.toFixed(2) : "-"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Conversion rate bar chart */}
      {variants.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-medium text-muted-foreground mb-3">
            {t("conversionRateComparison")}
          </h3>
          <div className="space-y-2">
            {variants.map((v) => {
              const maxRate = Math.max(
                ...variants.map((x) => x.conversion_rate),
                1,
              );
              const pct = (v.conversion_rate / maxRate) * 100;
              const isBest =
                bestVariant?.name === v.name && variants.length > 1;
              return (
                <div key={v.name} className="flex items-center gap-3">
                  <span className="text-sm w-24 truncate">{v.name}</span>
                  <div className="flex-1 h-6 bg-muted rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${
                        isBest ? "bg-primary" : "bg-primary/40"
                      }`}
                      style={{ width: `${Math.max(pct, 2)}%` }}
                    />
                  </div>
                  <span className="text-sm tabular-nums w-16 text-right">
                    {v.conversion_rate.toFixed(2)}%
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
