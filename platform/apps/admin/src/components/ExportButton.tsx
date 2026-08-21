"use client";

import { Download } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@pickket/ui";

interface ExportButtonProps {
  data: Record<string, unknown>[];
  filename?: string;
  columns?: { key: string; label: string }[];
  className?: string;
}

function toCsv(
  data: Record<string, unknown>[],
  columns?: { key: string; label: string }[]
): string {
  if (data.length === 0) return "";

  const cols = columns ?? Object.keys(data[0]).map((k) => ({ key: k, label: k }));
  const header = cols.map((c) => `"${c.label}"`).join(",");
  const rows = data.map((row) =>
    cols
      .map((c) => {
        const val = row[c.key];
        if (val == null) return '""';
        return `"${String(val).replace(/"/g, '""')}"`;
      })
      .join(",")
  );

  return "\uFEFF" + [header, ...rows].join("\n");
}

export default function ExportButton({
  data,
  filename = "export",
  columns,
  className,
}: ExportButtonProps) {
  const tActions = useTranslations("actions");
  const handleExport = () => {
    const csv = toCsv(data, columns);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${filename}_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleExport}
      disabled={data.length === 0}
      className={className}
    >
      <Download className="h-3.5 w-3.5 mr-1.5" />
      {tActions("export")} CSV
    </Button>
  );
}
