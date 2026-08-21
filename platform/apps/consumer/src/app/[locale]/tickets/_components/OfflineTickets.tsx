"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { QRCodeSVG } from "qrcode.react";
import { WifiOff, Ticket, Calendar, MapPin, RefreshCw } from "lucide-react";
import { Button } from "@pickket/ui";
import { formatKRW, formatDate } from "@pickket/lib";
import { useNetworkStatus } from "@pickket/lib/hooks";
import {
  getOfflineTickets,
  removeOfflineTicket,
  type OfflineTicket,
} from "@pickket/lib/offline-tickets";

/**
 * OfflineTickets (P2-5)
 *
 * 오프라인 상태에서 IndexedDB에 캐시된 티켓을 표시한다.
 * QR 코드와 이벤트 기본 정보를 포함한다.
 *
 * 주의: QR 데이터는 캐시 시점의 것이므로
 * 만료되었을 수 있다는 안내를 표시한다.
 */
export default function OfflineTickets() {
  const t = useTranslations("ticket.offlineTickets");
  const { isOnline } = useNetworkStatus();
  const router = useRouter();
  const [tickets, setTickets] = useState<OfflineTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const loadTickets = useCallback(async () => {
    try {
      const cached = await getOfflineTickets();
      setTickets(cached);
    } catch {
      // IndexedDB를 사용할 수 없는 경우
      setTickets([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTickets();
  }, [loadTickets]);

  // 온라인으로 돌아오면 티켓 페이지 새로고침 유도
  useEffect(() => {
    if (isOnline && tickets.length > 0) {
      // 온라인 복귀 시 자동으로 최신 데이터로 전환하기 위해 새로고침
      const timer = setTimeout(() => {
        router.refresh();
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [isOnline, tickets.length, router]);

  const handleRemove = async (ticketId: string) => {
    await removeOfflineTicket(ticketId);
    setTickets((prev) => prev.filter((t) => t.ticketId !== ticketId));
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-md p-5 space-y-4">
        <div className="h-48 rounded-2xl bg-white/5 animate-pulse" />
        <div className="h-48 rounded-2xl bg-white/5 animate-pulse" />
      </div>
    );
  }

  if (tickets.length === 0) {
    return (
      <div className="mx-auto max-w-md p-5 text-center space-y-4">
        <WifiOff className="mx-auto h-12 w-12 text-[var(--pk-text-secondary)]/40" />
        <div className="space-y-1">
          <p className="text-sm font-semibold text-[var(--pk-text)]">
            {t("offlineMode")}
          </p>
          <p className="text-sm text-[var(--pk-text-secondary)]">
            {t("noCache")}
          </p>
        </div>
        <Button
          variant="outline"
          className="rounded-xl"
          onClick={() => window.location.reload()}
        >
          <RefreshCw className="h-4 w-4 mr-1.5" />
          {t("retry")}
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md p-5 space-y-4">
      {/* 오프라인 배너 */}
      {!isOnline && (
        <div className="flex items-center gap-3 rounded-xl bg-amber-500/10 border border-amber-500/20 p-3">
          <WifiOff className="h-5 w-5 text-amber-500 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-amber-500">
              {t("offlineMode")}
            </p>
            <p className="text-xs text-amber-500/80">
              {t("offlineBannerDesc")}
            </p>
          </div>
        </div>
      )}

      {/* 온라인 복귀 배너 */}
      {isOnline && (
        <div className="flex items-center gap-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 p-3">
          <RefreshCw className="h-5 w-5 text-emerald-500 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-emerald-500">
              {t("backOnline")}
            </p>
            <p className="text-xs text-emerald-500/80">
              {t("backOnlineDesc")}
            </p>
          </div>
        </div>
      )}

      {/* 캐시된 티켓 목록 */}
      {tickets.map((ticket) => (
        <div
          key={ticket.ticketId}
          className="rounded-2xl bg-[var(--pk-surface)] shadow-lg overflow-hidden"
        >
          {/* 헤더 */}
          <button
            type="button"
            className="w-full bg-gradient-to-br from-[var(--pk-accent)]/80 to-[var(--pk-accent)] p-4 text-white text-left"
            onClick={() =>
              setExpandedId(
                expandedId === ticket.ticketId ? null : ticket.ticketId,
              )
            }
          >
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <Ticket className="h-4 w-4" />
                  <span className="text-xs font-medium opacity-80">
                    Pickket
                  </span>
                  <span className="text-xs opacity-60">({t("offlineCache")})</span>
                </div>
                <h3 className="text-base font-bold leading-tight">
                  {ticket.eventInfo.title}
                </h3>
              </div>
            </div>

            <div className="mt-3 space-y-1">
              {ticket.eventInfo.date && (
                <div className="flex items-center gap-2 text-sm opacity-90">
                  <Calendar className="h-3.5 w-3.5" />
                  <span>{formatDate(ticket.eventInfo.date)}</span>
                </div>
              )}
              {ticket.eventInfo.venue && (
                <div className="flex items-center gap-2 text-sm opacity-90">
                  <MapPin className="h-3.5 w-3.5" />
                  <span>{ticket.eventInfo.venue}</span>
                </div>
              )}
            </div>
          </button>

          {/* 티어 라인 */}
          <div className="relative">
            <div className="absolute left-0 right-0 top-0 flex justify-between -mx-[8px] px-[8px]">
              <div className="w-4 h-4 rounded-full bg-[var(--pk-bg)] -translate-x-2 -translate-y-2" />
              <div className="w-4 h-4 rounded-full bg-[var(--pk-bg)] translate-x-2 -translate-y-2" />
            </div>
            <div className="border-t border-dashed border-white/[0.08]" />
          </div>

          {/* 티켓 정보 + QR */}
          <div className="p-4 space-y-3">
            <div className="grid grid-cols-2 gap-2 text-sm">
              {ticket.eventInfo.tierName && (
                <div className="col-span-2">
                  <p className="text-xs text-[var(--pk-text-secondary)]">
                    {t("seatGrade")}
                  </p>
                  <p className="font-semibold text-[var(--pk-text)]">
                    {ticket.eventInfo.tierName}
                  </p>
                </div>
              )}
              <div>
                <p className="text-xs text-[var(--pk-text-secondary)]">
                  {t("paymentAmount")}
                </p>
                <p className="font-semibold font-tabular text-[var(--pk-text)]">
                  {formatKRW(ticket.eventInfo.purchasePrice)}
                </p>
              </div>
            </div>

            {/* QR 코드 — 접힌 상태에서도 기본 표시, 펼치면 크게 */}
            {expandedId === ticket.ticketId ? (
              <div className="space-y-3">
                <div className="flex flex-col items-center p-6 rounded-xl bg-white border border-white/[0.08]">
                  <QRCodeSVG
                    value={ticket.qrData}
                    size={200}
                    level="M"
                    includeMargin
                  />
                </div>

                <p className="text-xs text-center text-amber-500/80">
                  {t("cachedQrNote")}
                </p>

                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1 rounded-xl text-xs"
                    onClick={() => void handleRemove(ticket.ticketId)}
                  >
                    {t("deleteCache")}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center p-3 rounded-xl bg-white border border-white/[0.08]">
                <QRCodeSVG
                  value={ticket.qrData}
                  size={120}
                  level="M"
                  includeMargin
                />
                <p className="mt-2 text-xs text-[var(--pk-text-secondary)]">
                  {t("tapToExpand")}
                </p>
              </div>
            )}
          </div>
        </div>
      ))}

      <p className="text-center text-xs text-[var(--pk-text-secondary)]">
        {t("lastCached")}{" "}
        {tickets[0] && new Date(tickets[0].cachedAt).toLocaleString("ko-KR")}
      </p>
    </div>
  );
}
