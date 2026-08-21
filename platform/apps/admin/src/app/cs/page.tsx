"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, Search } from "lucide-react";
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@pickket/ui";
import {
  getCSTickets,
  getCSTicketStats,
  isApiCanceled,
  type CSTicketItem,
  type CSTicketStats,
} from "@pickket/lib/api";

import TicketList from "./_components/TicketList";

export default function CSTicketsPage() {
  const t = useTranslations("cs");
  const [tickets, setTickets] = useState<CSTicketItem[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<CSTicketStats | null>(null);
  const [loading, setLoading] = useState(true);

  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [priorityFilter, setPriorityFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [skip, setSkip] = useState(0);
  const limit = 50;

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    setSkip(0);
  }, [debouncedSearch, statusFilter, priorityFilter, categoryFilter]);

  const loadTickets = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, unknown> = { skip, limit };
      if (debouncedSearch) params.q = debouncedSearch;
      if (statusFilter !== "all") params.status = statusFilter;
      if (priorityFilter !== "all") params.priority = priorityFilter;
      if (categoryFilter !== "all") params.category = categoryFilter;

      const data = await getCSTickets(
        params as Parameters<typeof getCSTickets>[0],
      );
      setTickets(data.tickets);
      setTotal(data.total);
    } catch (err) {
      if (isApiCanceled(err)) return;
      toast.error(t("loadError"));
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, statusFilter, priorityFilter, categoryFilter, skip]);

  const loadStats = useCallback(async () => {
    try {
      const data = await getCSTicketStats();
      setStats(data);
    } catch (err) {
      if (isApiCanceled(err)) return;
      /* silent */
    }
  }, []);

  useEffect(() => {
    loadTickets();
  }, [loadTickets]);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="space-y-5 p-4 md:p-6">
      <h1 className="sr-only">{t("pageTitle")}</h1>

      {/* Stats cards */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
          <StatCard label={t("statAll")} value={stats.total} />
          <StatCard label={t("statOpen")} value={stats.open} color="blue" />
          <StatCard label={t("statInProgress")} value={stats.in_progress} color="yellow" />
          <StatCard
            label={t("statWaitingCustomer")}
            value={stats.waiting_customer}
            color="orange"
          />
          <StatCard label={t("statResolved")} value={stats.resolved} color="green" />
          <StatCard label={t("statClosed")} value={stats.closed} color="gray" />
          <StatCard label={t("statOverdue")} value={stats.overdue} color="red" />
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t("searchPlaceholder")}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-9 rounded-full"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[130px] rounded-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("statusAll")}</SelectItem>
            <SelectItem value="open">{t("statOpen")}</SelectItem>
            <SelectItem value="in_progress">{t("statInProgress")}</SelectItem>
            <SelectItem value="waiting_customer">{t("statWaitingCustomer")}</SelectItem>
            <SelectItem value="resolved">{t("statResolved")}</SelectItem>
            <SelectItem value="closed">{t("statClosed")}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={priorityFilter} onValueChange={setPriorityFilter}>
          <SelectTrigger className="w-[130px] rounded-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("priorityAll")}</SelectItem>
            <SelectItem value="low">{t("priorityLow")}</SelectItem>
            <SelectItem value="normal">{t("priorityNormal")}</SelectItem>
            <SelectItem value="high">{t("priorityHigh")}</SelectItem>
            <SelectItem value="urgent">{t("priorityUrgent")}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={categoryFilter} onValueChange={setCategoryFilter}>
          <SelectTrigger className="w-[130px] rounded-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("categoryAll")}</SelectItem>
            <SelectItem value="refund">{t("categoryRefund")}</SelectItem>
            <SelectItem value="payment">{t("categoryPayment")}</SelectItem>
            <SelectItem value="account">{t("categoryAccount")}</SelectItem>
            <SelectItem value="event">{t("categoryEvent")}</SelectItem>
            <SelectItem value="technical">{t("categoryTechnical")}</SelectItem>
            <SelectItem value="other">{t("categoryOther")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Ticket list */}
      <div className="rounded-lg border border-border bg-card">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : (
          <>
            <TicketList tickets={tickets} />
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-4 py-4 border-t border-border">
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-full"
                  disabled={skip === 0}
                  onClick={() => setSkip((s) => Math.max(0, s - limit))}
                >
                  {t("prev")}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {Math.floor(skip / limit) + 1} / {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-full"
                  disabled={skip + limit >= total}
                  onClick={() => setSkip((s) => s + limit)}
                >
                  {t("next")}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color?: "blue" | "yellow" | "orange" | "green" | "gray" | "red";
}) {
  const colorMap: Record<string, string> = {
    blue: "text-blue-600 dark:text-blue-400",
    yellow: "text-yellow-600 dark:text-yellow-400",
    orange: "text-orange-600 dark:text-orange-400",
    green: "text-green-600 dark:text-green-400",
    gray: "text-gray-500 dark:text-gray-400",
    red: "text-red-600 dark:text-red-400",
  };

  return (
    <div className="rounded-lg border border-border bg-card p-3 text-center">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={`text-lg font-bold font-tabular ${color ? colorMap[color] : ""}`}
      >
        {value}
      </p>
    </div>
  );
}
