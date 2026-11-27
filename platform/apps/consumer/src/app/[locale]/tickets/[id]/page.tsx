"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { motion } from "motion/react";
import { toast } from "sonner";
import {
  Ticket,
  Calendar,
  MapPin,
  QrCode,
  Shield,
  Sun,
  RefreshCw,
  ArrowRightLeft,
  Gem,
  Tag,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";

import { Badge } from "@pickket/ui";
import { Button } from "@pickket/ui";
import {
  getEvent,
  getNftByTicket,
  getTicket,
  getTicketQr,
  type NftTicketRecord,
  type TicketQrResponse,
} from "@pickket/lib/api";
import {
  formatKRW,
  formatDate,
  getSaleModeDescription,
  getOrganizerLabels,
  API_URL,
} from "@pickket/lib";
import { useAuthStore } from "@pickket/store";
import { useTranslations } from "next-intl";
import { useAuthReady } from "@/providers/AuthProvider";
import CreateListingDialog from "@/components/resale/CreateListingDialog";
import { useQuery } from "@tanstack/react-query";
import { ticketQrRefetchMs } from "@/lib/ticket-qr";

type ApiError = { response?: { data?: { detail?: string } } };

const TICKET_STATUS_CLS: Record<string, string> = {
  active: "bg-emerald-600/10 text-emerald-600 dark:text-emerald-400",
  used: "bg-white/10 text-muted-foreground",
  cancelled: "bg-red-600/10 text-red-600 dark:text-red-400",
  transferred: "bg-blue-500/10 text-blue-400",
  expired: "bg-orange-500/10 text-orange-400",
};
const API_BASE = API_URL;

export default function TicketDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { user } = useAuthStore();
  const ready = useAuthReady();
  const t = useTranslations("ticket");
  const ticketId = params.id as string;

  useEffect(() => {
    // Wait until AuthProvider has completed the /users/me session check before
    // redirecting; without this, the initial user=null (store default) would
    // immediately redirect a valid logged-in user on direct URL access.
    if (ready && user === null) {
      router.replace("/auth");
    }
  }, [ready, user, router]);

  const [resaleDialogOpen, setResaleDialogOpen] = useState(false);

  // Main ticket data query
  const { data: ticketData, isLoading: loading } = useQuery({
    queryKey: ["ticket", ticketId],
    queryFn: async () => {
      const res = await getTicket(ticketId);
      const ticketResult = res.data;

      let eventData: {
        title: string;
        date: string | null;
        venue: string | null;
        category?: string;
        home_team?: string;
        away_team?: string;
        artist_name?: string;
        subject_name?: string | null;
        event_date_end?: string;
      } | null = null;

      try {
        const evRes = await getEvent(ticketResult.event_id);
        eventData = {
          title: evRes.data?.title || t("event_fallback"),
          date: evRes.data?.event_date || null,
          venue: evRes.data?.venue || null,
          category: evRes.data?.category,
          home_team: evRes.data?.home_team,
          away_team: evRes.data?.away_team,
          artist_name: evRes.data?.artist_name,
          subject_name: evRes.data?.subject_name,
          event_date_end: evRes.data?.event_date_end,
        };
      } catch {
        // ignore
      }

      let nft: NftTicketRecord | null = null;
      try {
        nft = await getNftByTicket(ticketId);
      } catch {
        // ignore
      }

      return { ticket: ticketResult, eventData, nft };
    },
    meta: {
      onError: (err: unknown) => {
        const msg =
          (err as ApiError)?.response?.data?.detail || t("load_error");
        toast.error(msg);
      },
    },
  });

  const ticket = ticketData?.ticket ?? null;
  const eventData = ticketData?.eventData ?? null;
  const nft = ticketData?.nft ?? null;
  const tierName = ticket?.tier_name ?? null;

  // QR code query - only when ticket is active
  const {
    data: qrData = null,
    isLoading: qrLoading,
    refetch: fetchQr,
  } = useQuery<TicketQrResponse | null>({
    queryKey: ["ticket", ticketId, "qr"],
    queryFn: async () => {
      const res = await getTicketQr(ticketId);
      return res.data;
    },
    enabled: ticket?.status === "active",
    // 서버가 정한 주기(30초)로 새 QR 을 받는다. 입구는 60초까지 인정해 떠 있는 QR 은 늘 유효하다.
    refetchInterval: (query) => ticketQrRefetchMs(query.state.data),
  });

  const statusBadge = ticket
    ? {
        label: t(`status_${ticket.status}`) || ticket.status,
        cls:
          TICKET_STATUS_CLS[ticket.status] ??
          "bg-white/10 text-muted-foreground",
      }
    : null;

  if (loading) {
    return (
      <div className="bg-background min-h-screen mx-auto max-w-md px-5 pt-20 pb-5 lg:px-6 lg:pb-6">
        <div className="h-96 rounded-2xl bg-white/5 animate-pulse" />
      </div>
    );
  }

  if (!ticket) {
    return (
      <div className="bg-background min-h-screen mx-auto max-w-md px-5 pt-20 pb-5 lg:px-6 lg:pb-6 text-center space-y-3">
        <p className="text-sm text-muted-foreground">{t("not_found")}</p>
        <Button onClick={() => router.push("/mypage?tab=tickets")}>
          {t("go_mypage")}
        </Button>
      </div>
    );
  }

  return (
    <motion.main
      className="bg-background min-h-screen mx-auto max-w-md px-5 pt-20 pb-5 lg:px-6 lg:pb-6 space-y-5"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
    >
      {/* Ticket card */}
      <div className="rounded-2xl bg-card shadow-lg overflow-hidden">
        {/* Top colored header */}
        <div className="bg-gradient-to-br from-primary/90 to-primary p-5 text-white">
          <div className="flex items-start justify-between">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Ticket className="h-4 w-4" />
                <span className="text-xs font-medium opacity-80">Pickket</span>
              </div>
              <h2 className="text-lg font-bold leading-tight">
                {eventData?.title ?? t("event_fallback")}
              </h2>
            </div>
            {statusBadge && (
              <Badge className={`rounded-full ${statusBadge.cls}`}>
                {statusBadge.label}
              </Badge>
            )}
          </div>

          <div className="mt-4 space-y-1.5">
            {eventData?.date && (
              <div className="flex items-center gap-2 text-sm opacity-90">
                <Calendar className="h-3.5 w-3.5" />
                <span>{formatDate(eventData.date)}</span>
              </div>
            )}
            {eventData?.venue && (
              <div className="flex items-center gap-2 text-sm opacity-90">
                <MapPin className="h-3.5 w-3.5" />
                <span>{eventData.venue}</span>
              </div>
            )}
          </div>
        </div>

        {/* Tear line effect */}
        <div className="relative">
          <div className="absolute left-0 right-0 top-0 flex justify-between -mx-[8px] px-[8px]">
            <div className="w-4 h-4 rounded-full bg-background -translate-x-2 -translate-y-2" />
            <div className="w-4 h-4 rounded-full bg-background translate-x-2 -translate-y-2" />
          </div>
          <div className="border-t border-dashed border-white/[0.08]" />
        </div>

        {/* Ticket info */}
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3 text-sm">
            {tierName && (
              <div className="col-span-2">
                <p className="text-xs text-muted-foreground">{t("tier")}</p>
                <p className="font-semibold text-foreground">{tierName}</p>
              </div>
            )}
            <div>
              <p className="text-xs text-muted-foreground">
                {t("purchase_price")}
              </p>
              <p className="font-semibold font-tabular text-foreground">
                {formatKRW(ticket.purchase_price)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t("sale_mode")}</p>
              <p className="font-semibold text-foreground">
                {getSaleModeDescription(ticket.sale_mode)}
              </p>
            </div>
          </div>

          {/* Domain-specific info */}
          {eventData?.category && (
            <div className="space-y-2 pt-3 border-t border-white/[0.06]">
              {/* Sports: team info */}
              {eventData.category === "sports" &&
                eventData.home_team &&
                eventData.away_team && (
                  <div className="flex items-center justify-center gap-2 text-sm">
                    <span className="font-bold text-foreground">
                      {eventData.home_team}
                    </span>
                    <span className="text-xs text-primary/70 font-semibold">
                      VS
                    </span>
                    <span className="font-bold text-foreground">
                      {eventData.away_team}
                    </span>
                  </div>
                )}
              {/* Concert/Musical/Classical: artist name */}
              {["concert", "musical", "classical"].includes(
                eventData.category,
              ) &&
                (eventData.artist_name || eventData.subject_name) && (
                  <div>
                    <p className="text-xs text-muted-foreground">
                      {eventData.category === "classical"
                        ? t("performer_classical")
                        : eventData.category === "musical"
                          ? t("performer_musical")
                          : t("performer_concert")}
                    </p>
                    <p className="font-semibold text-sm text-foreground">
                      {eventData.subject_name || eventData.artist_name}
                    </p>
                  </div>
                )}
              {/* Exhibition: artist + period */}
              {eventData.category === "exhibition" && (
                <>
                  {eventData.subject_name && (
                    <div>
                      <p className="text-xs text-muted-foreground">
                        {t("artist")}
                      </p>
                      <p className="font-semibold text-sm text-foreground">
                        {eventData.subject_name}
                      </p>
                    </div>
                  )}
                  {eventData.event_date_end && eventData.date && (
                    <div>
                      <p className="text-xs text-muted-foreground">
                        {t("exhibition_period")}
                      </p>
                      <p className="font-semibold text-sm text-foreground">
                        {new Date(eventData.date).getMonth() + 1}.
                        {new Date(eventData.date).getDate()} ~{" "}
                        {new Date(eventData.event_date_end).getMonth() + 1}.
                        {new Date(eventData.event_date_end).getDate()}
                      </p>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* QR Code section */}
          {ticket.status === "active" && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <QrCode className="h-4 w-4" />
                  {eventData?.category
                    ? getOrganizerLabels(eventData.category).ticketNoun
                    : t("qr_label")}{" "}
                  QR
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void fetchQr({})}
                  disabled={qrLoading}
                  className="h-7 text-xs"
                  aria-label={t("qr_refresh_aria")}
                >
                  <RefreshCw
                    className={`h-3 w-3 mr-1 ${qrLoading ? "animate-spin" : ""}`}
                  />
                  {t("qr_refresh")}
                </Button>
              </div>

              <div className="flex flex-col items-center p-6 rounded-xl bg-white border border-white/[0.08]">
                {qrData ? (
                  <QRCodeSVG
                    value={qrData.qr_data}
                    size={200}
                    level="M"
                    includeMargin
                  />
                ) : (
                  <div className="h-[200px] w-[200px] flex items-center justify-center">
                    {qrLoading ? (
                      <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
                    ) : (
                      <QrCode className="h-12 w-12 text-muted-foreground/30" />
                    )}
                  </div>
                )}
              </div>

              {/* Security notices */}
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Shield className="h-3 w-3 shrink-0" />
                  <span>{t("qr_screenshot_invalid")}</span>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Sun className="h-3 w-3 shrink-0" />
                  <span>{t("qr_brightness")}</span>
                </div>
              </div>
            </div>
          )}

          {ticket.status !== "active" && (
            <div className="text-center py-8">
              <p className="text-sm text-muted-foreground">
                {ticket.status === "used"
                  ? t("used_message")
                  : ticket.status === "cancelled"
                    ? t("cancelled_message")
                    : ticket.status === "transferred"
                      ? t("transferred_message")
                      : t("invalid_message")}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Action buttons */}
      {ticket.status === "used" && nft && (
        <section className="rounded-3xl border border-white/[0.08] bg-card p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Gem className="h-5 w-5 text-amber-500" />
            <div>
              <p className="font-semibold text-foreground">NFT 수집품</p>
              <p className="text-xs text-muted-foreground">
                체크인 완료 티켓의 디지털 기념품입니다.
              </p>
            </div>
          </div>
          <div className="rounded-2xl bg-white/10 p-4">
            <p className="font-medium text-foreground">{nft.token_name}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {nft.description}
            </p>
            <div className="mt-3 grid gap-2">
              {(nft.attributes || []).map((attribute) => (
                <div
                  key={`${attribute.trait_type}-${attribute.value}`}
                  className="flex items-center justify-between text-sm"
                >
                  <span className="text-muted-foreground">
                    {attribute.trait_type}
                  </span>
                  <span className="font-medium text-foreground">
                    {attribute.value}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              className="flex-1 rounded-xl"
              onClick={() =>
                navigator.share?.({
                  title: nft.token_name,
                  text: nft.description,
                  url: window.location.href,
                })
              }
            >
              공유
            </Button>
            <Button
              type="button"
              variant="outline"
              className="flex-1 rounded-xl"
              onClick={() =>
                window.open(
                  `${API_BASE}/api/v1/nft/${nft.id}/metadata.json`,
                  "_blank",
                  "noopener,noreferrer",
                )
              }
            >
              메타데이터 보기
            </Button>
          </div>
        </section>
      )}

      {ticket.status === "active" && (
        <div className="flex gap-2">
          {ticket.is_resalable && (
            <Button
              variant="outline"
              className="flex-1 rounded-xl"
              onClick={() => setResaleDialogOpen(true)}
              aria-label={t("resale_register")}
            >
              <Tag className="h-4 w-4 mr-1.5" />
              {t("resale_register")}
            </Button>
          )}
          <Button
            variant="outline"
            className="flex-1 rounded-xl"
            onClick={() => router.push(`/mypage?tab=tickets`)}
            aria-label={t("transfer")}
          >
            <ArrowRightLeft className="h-4 w-4 mr-1.5" />
            {t("transfer")}
          </Button>
        </div>
      )}

      {/* Resale Listing Dialog */}
      {ticket.is_resalable && (
        <CreateListingDialog
          open={resaleDialogOpen}
          onOpenChange={setResaleDialogOpen}
          ticket={{
            id: ticket.id,
            event_id: ticket.event_id,
            event_title: eventData?.title ?? t("event_fallback"),
            tier_name: tierName || "General",
            original_price: ticket.purchase_price,
          }}
          onSuccess={() => {
            toast.success(t("resale_success"));
            router.push("/mypage?tab=resale");
          }}
        />
      )}
    </motion.main>
  );
}
