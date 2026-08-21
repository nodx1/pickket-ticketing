"use client";

import { motion } from "motion/react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
} from "recharts";
import {
  BarChart3,
  Users,
  Target,
  TrendingUp,
  Shield,
  CheckCircle2,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@pickket/ui";
import { Progress } from "@pickket/ui";
import { formatKRW } from "@pickket/lib";
import { useTranslations } from "next-intl";

interface FairnessReportProps {
  totalBids: number;
  totalAllocated: number;
  competitionRatio: number;
  priceMin: number | null;
  priceMax: number | null;
  priceMedian: number | null;
  giniCoefficient?: number | null;
  anomaliesBlocked: number;
}

type GiniLabelKey = "veryFair" | "fair" | "needsImprovement";

function getGiniLabelKey(gini: number): {
  labelKey: GiniLabelKey;
  color: string;
  progressColor: string;
} {
  if (gini >= 0.9) {
    return {
      labelKey: "veryFair",
      color: "text-green-600 dark:text-green-400",
      progressColor: "[&_[data-slot=progress-indicator]]:bg-green-500",
    };
  }
  if (gini >= 0.7) {
    return {
      labelKey: "fair",
      color: "text-primary dark:text-[#7B8AD4]",
      progressColor: "[&_[data-slot=progress-indicator]]:bg-primary",
    };
  }
  return {
    labelKey: "needsImprovement",
    color: "text-amber-600 dark:text-amber-400",
    progressColor: "[&_[data-slot=progress-indicator]]:bg-amber-500",
  };
}

function buildPriceDistribution(
  min: number | null,
  max: number | null,
  median: number | null,
  labelMin: string,
  labelMedian: string,
  labelMax: string,
) {
  if (min == null || max == null || median == null) return [];

  const range = max - min;
  const p25 = min + range * 0.25;
  const p75 = min + range * 0.75;

  return [
    { label: labelMin, value: min },
    { label: "P25", value: Math.round(p25) },
    { label: labelMedian, value: Math.round(median) },
    { label: "P75", value: Math.round(p75) },
    { label: labelMax, value: max },
  ];
}

export default function FairnessReport({
  totalBids,
  totalAllocated,
  competitionRatio,
  priceMin,
  priceMax,
  priceMedian,
  giniCoefficient,
  anomaliesBlocked,
}: FairnessReportProps) {
  const t = useTranslations("other.fairnessReport");
  const priceData = buildPriceDistribution(
    priceMin,
    priceMax,
    priceMedian,
    t("priceMin"),
    t("priceMedian"),
    t("priceMax"),
  );
  const hasGini = giniCoefficient != null && giniCoefficient !== undefined;
  const giniInfo = hasGini ? getGiniLabelKey(giniCoefficient!) : null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5 text-primary" />
            {t("title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Top metrics row */}
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-muted/50 rounded-xl p-4">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                <Users className="h-3 w-3" />
                {t("participants")}
              </div>
              <p className="text-2xl font-bold font-tabular">
                {totalBids.toLocaleString()}
                <span className="text-sm font-normal text-muted-foreground">
                  {t("personSuffix")}
                </span>
              </p>
            </div>
            <div className="bg-primary/5 rounded-xl p-4">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                <Target className="h-3 w-3" />
                {t("allocated")}
              </div>
              <p className="text-2xl font-bold text-primary font-tabular">
                {totalAllocated.toLocaleString()}
                <span className="text-sm font-normal text-muted-foreground">
                  {t("personSuffix")}
                </span>
              </p>
            </div>
            <div className="bg-muted/50 rounded-xl p-4">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                <TrendingUp className="h-3 w-3" />
                {t("competitionRatio")}
              </div>
              <p className="text-2xl font-bold font-tabular">
                {competitionRatio.toFixed(1)}
                <span className="text-sm font-normal text-muted-foreground">
                  :1
                </span>
              </p>
            </div>
          </div>

          {/* Price distribution + Gini */}
          <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
            {/* Price chart */}
            {priceData.length > 0 && (
              <div className="md:col-span-3">
                <h4 className="text-sm font-medium mb-2 text-muted-foreground">
                  {t("priceDistribution")}
                </h4>
                <div className="h-40 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={priceData}>
                      <XAxis
                        dataKey="label"
                        tick={{ fontSize: 11 }}
                        tickLine={false}
                        axisLine={false}
                      />
                      <YAxis hide />
                      <RechartsTooltip
                        contentStyle={{
                          borderRadius: "8px",
                          border: "1px solid var(--border)",
                          background: "var(--card)",
                          color: "var(--card-foreground)",
                        }}
                        formatter={(value: number | undefined) => [
                          formatKRW(value ?? 0),
                          t("priceTooltipLabel"),
                        ]}
                      />
                      <Bar
                        dataKey="value"
                        fill="var(--primary)"
                        radius={[4, 4, 0, 0]}
                        barSize={32}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                {priceMin != null && priceMax != null && (
                  <p className="text-xs text-muted-foreground mt-1 text-center">
                    {formatKRW(priceMin)} ~ {formatKRW(priceMax)}
                  </p>
                )}
              </div>
            )}

            {/* Gini coefficient */}
            {hasGini && giniInfo && (
              <div className="md:col-span-2 flex flex-col justify-center">
                <h4 className="text-sm font-medium mb-3 text-muted-foreground">
                  {t("fairnessIndex")}
                </h4>
                <div className="space-y-3">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm text-muted-foreground">Gini:</span>
                    <span
                      className={`text-3xl font-bold font-tabular ${giniInfo.color}`}
                    >
                      {giniCoefficient!.toFixed(2)}
                    </span>
                  </div>
                  <Progress
                    value={giniCoefficient! * 100}
                    className={`h-3 ${giniInfo.progressColor}`}
                  />
                  <div className="flex items-center gap-1.5">
                    <CheckCircle2 className={`h-4 w-4 ${giniInfo.color}`} />
                    <span className={`text-sm font-medium ${giniInfo.color}`}>
                      {t(`gini.${giniInfo.labelKey}`)}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Anomalies blocked */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.2 }}
            className="bg-gradient-to-r from-green-50 to-emerald-50 dark:from-green-950/20 dark:to-emerald-950/20 border border-green-200 dark:border-green-800 rounded-xl p-4"
          >
            <div className="flex items-center gap-3">
              <Shield className="h-6 w-6 text-green-600 dark:text-green-400 shrink-0" />
              <div>
                <p className="font-medium text-green-800 dark:text-green-300 text-sm">
                  {anomaliesBlocked > 0
                    ? t("anomaliesBlocked", { count: anomaliesBlocked ?? 0 })
                    : t("noAnomalies")}
                </p>
                <p className="text-sm text-green-700 dark:text-green-400 mt-0.5">
                  {anomaliesBlocked > 0
                    ? t("seatProtected")
                    : t("allFairlyProcessed")}
                </p>
              </div>
            </div>
          </motion.div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
