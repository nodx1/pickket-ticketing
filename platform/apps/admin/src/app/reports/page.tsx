"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { motion } from "motion/react";
import { toast } from "sonner";
import { Download, FileBarChart, Loader2 } from "lucide-react";
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Input,
  Label,
} from "@pickket/ui";
import {
  getReportTypes,
  generateAdminReport,
  type ReportType,
  type ReportResponse,
} from "@pickket/lib/api";
import { formatKRW } from "@pickket/lib";

function toCSV(data: Record<string, unknown>[]): string {
  if (!data.length) return "";
  const headers = Object.keys(data[0]);
  const rows = data.map((row) =>
    headers
      .map((h) => {
        const val = row[h];
        if (val === null || val === undefined) return "";
        const str = String(val);
        return str.includes(",") || str.includes('"')
          ? `"${str.replace(/"/g, '""')}"`
          : str;
      })
      .join(","),
  );
  return [headers.join(","), ...rows].join("\n");
}

function downloadCSV(data: Record<string, unknown>[], filename: string) {
  const csv = toCSV(data);
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${filename}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function AdminReportsPage() {
  const t = useTranslations("reports");
  const [reportTypes, setReportTypes] = useState<ReportType[]>([]);
  const [selectedType, setSelectedType] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [loading, setLoading] = useState(false);
  const [typesLoading, setTypesLoading] = useState(true);
  const [report, setReport] = useState<ReportResponse | null>(null);

  useEffect(() => {
    getReportTypes()
      .then(setReportTypes)
      .catch(() => toast.error(t("errorLoadTypes")))
      .finally(() => setTypesLoading(false));
  }, []);

  const handleGenerate = useCallback(async () => {
    if (!selectedType) {
      toast.error(t("errorSelectType"));
      return;
    }
    setLoading(true);
    setReport(null);
    try {
      const result = await generateAdminReport({
        report_type: selectedType,
        date_from: dateFrom || undefined,
        date_to: dateTo || undefined,
      });
      setReport(result);
      toast.success(t("successGenerate"));
    } catch {
      toast.error(t("errorGenerate"));
    } finally {
      setLoading(false);
    }
  }, [selectedType, dateFrom, dateTo]);

  const handleDownloadCSV = () => {
    if (!report?.data?.length) return;
    downloadCSV(
      report.data,
      `report_${report.report_type}_${new Date().toISOString().slice(0, 10)}`,
    );
  };

  const columns = report?.data?.length ? Object.keys(report.data[0]) : [];

  const formatCellValue = (key: string, value: unknown): string => {
    if (value === null || value === undefined) return "-";
    if (typeof value === "number") {
      if (
        key.includes("revenue") ||
        key.includes("amount") ||
        key.includes("refund_amount")
      ) {
        return formatKRW(value);
      }
      if (key.includes("rate") || key.includes("fill_rate")) {
        return `${value}%`;
      }
      return value.toLocaleString("ko-KR");
    }
    return String(value);
  };

  const COLUMN_LABELS: Record<string, string> = {
    date: t("col.date"),
    order_count: t("col.orderCount"),
    revenue: t("col.revenue"),
    tickets: t("col.tickets"),
    signups: t("col.signups"),
    organizer_signups: t("col.organizerSignups"),
    event_id: t("col.eventId"),
    title: t("col.title"),
    category: t("col.category"),
    total_seats: t("col.totalSeats"),
    status: t("col.status"),
    event_date: t("col.eventDate"),
    tickets_sold: t("col.ticketsSold"),
    order_count_event: t("col.orderCount"),
    fill_rate: t("col.fillRate"),
    refund_count: t("col.refundCount"),
    refund_amount: t("col.refundAmount"),
  };

  return (
    <div className="space-y-5 p-4 md:p-6">
      <h1 className="sr-only">{t("title")}</h1>
      <div className="flex items-center gap-3">
        <FileBarChart className="h-5 w-5 text-primary" />
        <span className="text-lg font-semibold text-foreground">
          {t("title")}
        </span>
      </div>

      {/* Controls */}
      <div className="rounded-lg border border-border bg-card p-5">
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 items-end">
          <div>
            <Label className="text-sm font-medium mb-1.5 block">
              {t("labelType")}
            </Label>
            {typesLoading ? (
              <div className="h-10 flex items-center">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            ) : (
              <Select value={selectedType} onValueChange={setSelectedType}>
                <SelectTrigger className="rounded-lg">
                  <SelectValue placeholder={t("placeholderSelect")} />
                </SelectTrigger>
                <SelectContent>
                  {reportTypes.map((rt) => (
                    <SelectItem key={rt.key} value={rt.key}>
                      {rt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div>
            <Label className="text-sm font-medium mb-1.5 block">{t("labelDateFrom")}</Label>
            <Input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="rounded-lg"
            />
          </div>
          <div>
            <Label className="text-sm font-medium mb-1.5 block">{t("labelDateTo")}</Label>
            <Input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="rounded-lg"
            />
          </div>
          <div>
            <Button
              onClick={handleGenerate}
              disabled={loading || !selectedType}
              className="w-full rounded-lg"
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <FileBarChart className="h-4 w-4 mr-2" />
              )}
              {t("btnGenerate")}
            </Button>
          </div>
        </div>
        {selectedType && (
          <p className="text-xs text-muted-foreground mt-2">
            {reportTypes.find((rt) => rt.key === selectedType)?.description}
          </p>
        )}
      </div>

      {/* Report Results */}
      {report && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-4"
        >
          {/* Summary Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {Object.entries(report.summary).map(([key, value]) => (
              <div
                key={key}
                className="rounded-lg border border-border bg-card p-4"
              >
                <p className="text-xs text-muted-foreground mb-1">
                  {COLUMN_LABELS[key] || key.replace(/_/g, " ")}
                </p>
                <p className="text-lg font-bold font-tabular">
                  {formatCellValue(key, value)}
                </p>
              </div>
            ))}
          </div>

          {/* Data Table */}
          <div className="rounded-lg border border-border bg-card">
            <div className="flex items-center justify-between px-5 py-3 border-b border-border">
              <span className="text-sm font-medium">
                {t("dataCount", { count: report.data.length ?? 0 })}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="rounded-full gap-1.5"
                onClick={handleDownloadCSV}
                disabled={!report.data.length}
              >
                <Download className="h-3.5 w-3.5" />
                {t("btnDownloadCSV")}
              </Button>
            </div>
            {report.data.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                {t("emptyData")}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      {columns.map((col) => (
                        <th
                          key={col}
                          className="text-left px-5 py-3 font-medium text-xs text-muted-foreground whitespace-nowrap"
                        >
                          {COLUMN_LABELS[col] || col.replace(/_/g, " ")}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {report.data.map((row, idx) => (
                      <motion.tr
                        key={JSON.stringify(row)}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: idx * 0.01 }}
                        className="border-b last:border-b-0 hover:bg-muted/30 transition-colors"
                      >
                        {columns.map((col) => (
                          <td
                            key={col}
                            className="px-5 py-3.5 whitespace-nowrap font-tabular"
                          >
                            {formatCellValue(col, row[col])}
                          </td>
                        ))}
                      </motion.tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </motion.div>
      )}
    </div>
  );
}
