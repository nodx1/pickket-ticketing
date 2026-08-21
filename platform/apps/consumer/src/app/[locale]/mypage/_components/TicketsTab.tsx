"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { Ticket, ChevronRight } from "lucide-react";
import { Button } from "@pickket/ui";
import { Badge } from "@pickket/ui";
import { formatDateShort, CATEGORIES } from "@pickket/lib";
import api from "@pickket/lib/api";
import { useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";

interface TicketItem {
  id: string;
  event_id: string;
  event_title: string;
  event_date: string;
  tier_name: string;
  status: string;
  checked_in: boolean;
  seat_label?: string;
  original_price?: number;
  purchase_price?: number;
  event_category?: string;
}

interface TicketsTabProps {
  onTransferChoice: (ticket: TicketItem) => void;
}

export type { TicketItem };

export default function TicketsTab({ onTransferChoice }: TicketsTabProps) {
  const router = useRouter();
  const t = useTranslations("mypage");
  const [ticketCategoryFilter, setTicketCategoryFilter] =
    useState<string>("all");

  const { data: tickets = [], isLoading: ticketsLoading } = useQuery<
    TicketItem[]
  >({
    queryKey: ["mypage", "tickets"],
    queryFn: async () => {
      const res = await api.get<{ tickets: TicketItem[]; total: number }>(
        "/tickets/my",
        { params: { _t: Date.now() } },
      );
      return res.data.tickets;
    },
  });

  const TICKET_CATEGORIES = useMemo(
    () => [
      { value: "all", label: t("all_categories") },
      ...CATEGORIES.map((c) => ({ value: c.slug, label: c.label })),
    ],
    [t],
  );

  const filteredTickets = useMemo(() => {
    if (ticketCategoryFilter === "all") return tickets;
    return tickets.filter((t) => t.event_category === ticketCategoryFilter);
  }, [tickets, ticketCategoryFilter]);

  return (
    <div className="space-y-6">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05 }}
      >
        <div className="rounded-2xl shadow-sm p-5 lg:p-6 bg-background border border-border/50">
          <h2 className="flex items-center gap-2 text-lg font-semibold mb-4">
            <Ticket className="h-5 w-5 text-primary/70" />
            {t("tab_tickets")}
          </h2>

          {/* Category filter chips */}
          {tickets.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-4">
              {TICKET_CATEGORIES.map((cat) => (
                <button
                  key={cat.value}
                  type="button"
                  onClick={() => setTicketCategoryFilter(cat.value)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-200 ${
                    ticketCategoryFilter === cat.value
                      ? "bg-primary text-white shadow-sm"
                      : "bg-muted text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {cat.label}
                </button>
              ))}
            </div>
          )}

          {ticketsLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div
                  key={i}
                  className="h-20 bg-card rounded-2xl animate-pulse"
                />
              ))}
            </div>
          ) : tickets.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Ticket className="h-8 w-8 mx-auto mb-2 opacity-30" />
              <p>{t("no_tickets")}</p>
              <Button
                variant="link"
                className="mt-2"
                onClick={() => router.push("/events")}
              >
                {t("browse_events")} <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          ) : filteredTickets.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Ticket className="h-8 w-8 mx-auto mb-2 opacity-30" />
              <p>{t("no_category_tickets")}</p>
              <Button
                variant="link"
                className="mt-2"
                onClick={() => setTicketCategoryFilter("all")}
              >
                {t("view_all")}
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredTickets.map((ticket, index) => (
                <motion.div
                  key={ticket.id}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: index * 0.03 }}
                  className="flex items-center justify-between p-4 rounded-2xl shadow-none hover:shadow-md hover:-translate-y-0.5 transition-all duration-200 cursor-pointer bg-card"
                  onClick={() => router.push(`/tickets/${ticket.id}`)}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-sm truncate">
                        {ticket.event_title}
                      </p>
                      {ticket.event_category && (
                        <Badge className="text-xs rounded-full px-2.5 py-0.5 bg-card text-muted-foreground shrink-0">
                          {CATEGORIES.find(
                            (c) => c.slug === ticket.event_category,
                          )?.label ?? ticket.event_category}
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                      <span>{formatDateShort(ticket.event_date)}</span>
                      {ticket.tier_name && <span>{ticket.tier_name}</span>}
                      {ticket.seat_label && <span>{ticket.seat_label}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 ml-3 shrink-0">
                    <Badge
                      className={`text-xs rounded-full px-2.5 py-0.5 ${
                        ticket.checked_in
                          ? "bg-green-100 text-green-700"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {ticket.checked_in
                        ? t("checked_in")
                        : t("not_checked_in")}
                    </Badge>
                    {ticket.status !== "cancelled" && !ticket.checked_in && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="rounded-full text-xs h-8 px-3 border-emerald-200 text-emerald-700 hover:bg-emerald-50"
                        onClick={(e) => {
                          e.stopPropagation();
                          onTransferChoice(ticket);
                        }}
                      >
                        {t("transfer")}
                      </Button>
                    )}
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </div>
                </motion.div>
              ))}
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
}
