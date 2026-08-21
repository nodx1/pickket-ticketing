"use client";

import { ArrowUpDown } from "lucide-react";
import { useMemo, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

interface Column<T> {
  key: keyof T;
  label: string;
  render?: (row: T) => React.ReactNode;
}

interface DataTableProps<T extends object> {
  data: T[];
  columns: Column<T>[];
  searchTerm?: string;
  loading?: boolean;
  emptyMessage?: string;
  onRowClick?: (row: T) => void;
  getRowClassName?: (row: T) => string | undefined;
}

export function DataTable<T extends object>({
  data,
  columns,
  searchTerm = "",
  loading = false,
  emptyMessage = "데이터가 없습니다",
  onRowClick,
  getRowClassName,
}: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<keyof T | null>(null);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");

  const filtered = useMemo(() => {
    const lowered = searchTerm.trim().toLowerCase();
    if (!lowered) {
      return data;
    }

    return data.filter((row) =>
      Object.values(row as Record<string, unknown>).some((value) => String(value ?? "").toLowerCase().includes(lowered)),
    );
  }, [data, searchTerm]);

  const sorted = useMemo(() => {
    if (!sortKey) {
      return filtered;
    }

    return [...filtered].sort((left, right) => {
      const leftValue = String(left[sortKey] ?? "");
      const rightValue = String(right[sortKey] ?? "");
      return sortDirection === "asc"
        ? leftValue.localeCompare(rightValue, "ko")
        : rightValue.localeCompare(leftValue, "ko");
    });
  }, [filtered, sortDirection, sortKey]);

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((column) => (
              <TableHead key={String(column.key)} className="text-xs font-semibold uppercase tracking-wide text-content-subtle">
                <button
                  type="button"
                  aria-label={`${String(column.label) || String(column.key)} 정렬`}
                  className="inline-flex items-center gap-2"
                  onClick={() => {
                    if (sortKey === column.key) {
                      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
                    } else {
                      setSortKey(column.key);
                      setSortDirection("asc");
                    }
                  }}
                >
                  {column.label}
                  <ArrowUpDown className={cn("size-3.5", sortKey === column.key ? "text-primary" : "text-muted-foreground")} />
                </button>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            Array.from({ length: 5 }, (_, rowIndex) => (
              <TableRow key={`loading-${rowIndex}`}>
                {columns.map((column) => (
                  <TableCell key={`loading-cell-${String(column.key)}-${rowIndex}`}>
                    <Skeleton className="h-5 w-full max-w-[160px]" />
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : sorted.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columns.length} className="py-10 text-center text-sm text-muted-foreground">
                {emptyMessage}
              </TableCell>
            </TableRow>
          ) : sorted.map((row, index) => (
            <TableRow key={`row-${index}`} className={cn("transition hover:bg-bg-subtle", getRowClassName?.(row))}>
              {columns.map((column) => (
                <TableCell key={String(column.key)} className="tabular-nums">
                  {onRowClick ? (
                    <button
                      type="button"
                      className="w-full cursor-pointer text-left"
                      onClick={() => onRowClick(row)}
                    >
                      {column.render ? column.render(row) : String(row[column.key] ?? "")}
                    </button>
                  ) : (
                    <div className="w-full text-left">
                      {column.render ? column.render(row) : String(row[column.key] ?? "")}
                    </div>
                  )}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
