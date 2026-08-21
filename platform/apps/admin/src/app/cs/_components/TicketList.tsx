"use client";

import { useTranslations } from "next-intl";
import { motion } from "motion/react";
import { Badge } from "@pickket/ui";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import type { CSTicketItem } from "@pickket/lib/api";
import { formatDate } from "@pickket/lib";

import SlaTimer from "./SlaTimer";

const STATUS_COLOR: Record<string, string> = {
  open: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  in_progress:
    "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
  waiting_customer:
    "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
  resolved:
    "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
  closed: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

const PRIORITY_COLOR: Record<string, string> = {
  low: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  normal: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  high: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
  urgent: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
};

interface TicketListProps {
  tickets: CSTicketItem[];
}

export default function TicketList({ tickets }: TicketListProps) {
  const t = useTranslations("cs.ticketList");

  const STATUS_LABEL: Record<string, string> = {
    open: t("status.open"),
    in_progress: t("status.inProgress"),
    waiting_customer: t("status.waitingCustomer"),
    resolved: t("status.resolved"),
    closed: t("status.closed"),
  };

  const PRIORITY_LABEL: Record<string, string> = {
    low: t("priority.low"),
    normal: t("priority.normal"),
    high: t("priority.high"),
    urgent: t("priority.urgent"),
  };

  const CATEGORY_LABEL: Record<string, string> = {
    refund: t("category.refund"),
    payment: t("category.payment"),
    account: t("category.account"),
    event: t("category.event"),
    technical: t("category.technical"),
    other: t("category.other"),
  };

  if (tickets.length === 0) {
    return (
      <div className="text-center py-16 text-muted-foreground">
        {t("empty")}
      </div>
    );
  }

  return (
    <>
      <div className="hidden lg:grid grid-cols-[1fr_100px_80px_80px_120px_140px_100px_40px] gap-2 px-5 py-3 text-xs font-medium text-muted-foreground border-b border-border">
        <span>{t("col.subject")}</span>
        <span>{t("col.category")}</span>
        <span>{t("col.status")}</span>
        <span>{t("col.priority")}</span>
        <span>{t("col.assignee")}</span>
        <span>SLA</span>
        <span>{t("col.date")}</span>
        <span />
      </div>
      <div className="divide-y divide-border">
        {tickets.map((ticket, idx) => (
          <Link key={ticket.id} href={`/cs/${ticket.id}`}>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: idx * 0.02 }}
              className="grid grid-cols-1 lg:grid-cols-[1fr_100px_80px_80px_120px_140px_100px_40px] gap-2 px-5 py-3.5 text-sm items-center hover:bg-muted/50 transition-colors cursor-pointer"
            >
              <div className="flex flex-col gap-0.5">
                <span className="font-medium truncate">
                  {ticket.escalated && (
                    <span className="text-red-500 mr-1" title={t("escalated")}>
                      [!]
                    </span>
                  )}
                  {ticket.subject}
                </span>
                <span className="text-xs text-muted-foreground truncate hidden lg:block">
                  {ticket.reporter_name ||
                    ticket.reporter_email ||
                    ticket.reporter_id.slice(0, 8)}
                </span>
              </div>

              <span className="hidden lg:block">
                <Badge className="rounded-full text-xs" variant="outline">
                  {CATEGORY_LABEL[ticket.category] ?? ticket.category}
                </Badge>
              </span>

              <span className="hidden lg:block">
                <Badge
                  className={`rounded-full text-xs ${STATUS_COLOR[ticket.status] || ""}`}
                  variant="secondary"
                >
                  {STATUS_LABEL[ticket.status] ?? ticket.status}
                </Badge>
              </span>

              <span className="hidden lg:block">
                <Badge
                  className={`rounded-full text-xs ${PRIORITY_COLOR[ticket.priority] || ""}`}
                  variant="secondary"
                >
                  {PRIORITY_LABEL[ticket.priority] ?? ticket.priority}
                </Badge>
              </span>

              <span className="text-muted-foreground text-xs truncate hidden lg:block">
                {ticket.assignee_name ||
                  (ticket.assignee_id
                    ? ticket.assignee_id.slice(0, 8)
                    : t("unassigned"))}
              </span>

              <span className="hidden lg:block">
                <SlaTimer
                  deadline={ticket.sla_deadline ?? null}
                  status={ticket.status}
                />
              </span>

              <span className="text-right text-xs text-muted-foreground hidden lg:block">
                {formatDate(ticket.created_at)}
              </span>

              <span className="hidden lg:flex items-center justify-center text-muted-foreground">
                <ArrowUpRight className="h-3.5 w-3.5" />
              </span>

              {/* Mobile summary */}
              <div className="flex gap-2 items-center lg:hidden flex-wrap">
                <Badge
                  className={`rounded-full text-xs ${STATUS_COLOR[ticket.status] || ""}`}
                  variant="secondary"
                >
                  {STATUS_LABEL[ticket.status] ?? ticket.status}
                </Badge>
                <Badge
                  className={`rounded-full text-xs ${PRIORITY_COLOR[ticket.priority] || ""}`}
                  variant="secondary"
                >
                  {PRIORITY_LABEL[ticket.priority] ?? ticket.priority}
                </Badge>
                <SlaTimer
                  deadline={ticket.sla_deadline ?? null}
                  status={ticket.status}
                />
              </div>
            </motion.div>
          </Link>
        ))}
      </div>
    </>
  );
}

export { STATUS_COLOR, PRIORITY_COLOR };
