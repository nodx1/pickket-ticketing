"use client";

import { Suspense, useCallback, useState, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { motion } from "motion/react";
import {
  Star,
  Ticket,
  TrendingUp,
  ClipboardList,
  Wallet,
  ShoppingCart,
} from "lucide-react";
import { Button } from "@pickket/ui";
import { Badge } from "@pickket/ui";
import { useAuthStore } from "@pickket/store";
import { CARD, BTN } from "@/lib/styles";
import api, { getBidHistory, getUserStats } from "@pickket/lib/api";
import { useTranslations } from "next-intl";
import CreateListingDialog from "@/components/resale/CreateListingDialog";
import TransferFlow from "@/components/transfer/TransferFlow";
import TransferChoiceDialog from "@/components/waitlist/TransferChoiceDialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import ProfileTab from "./_components/ProfileTab";
import BidHistoryTab from "./_components/BidHistoryTab";
import TicketsTab, { type TicketItem } from "./_components/TicketsTab";
import ResaleTab from "./_components/ResaleTab";
import PointsTab from "./_components/PointsTab";
import OrdersTab from "./_components/OrdersTab";

/* ---------- Types ---------- */
interface BidHistoryItem {
  id: string;
  event_id: string;
  event_title: string;
  max_willingness_to_pay: number;
  quantity: number;
  status: string;
  sale_mode?: string;
  effective_weight?: number | null;
  final_price: number | null;
  created_at: string;
}

interface UserStatsData {
  total_bids: number;
  total_wins: number;
  total_losses: number;
  win_rate: number;
  total_savings: number;
}

type ActiveTab =
  | "profile"
  | "bids"
  | "tickets"
  | "orders"
  | "resale"
  | "points";
type ApiError = { response?: { status?: number; data?: { detail?: string } } };

const VALID_TABS: ActiveTab[] = [
  "profile",
  "bids",
  "tickets",
  "orders",
  "resale",
  "points",
];

function parseActiveTab(tab: string | null): ActiveTab {
  if (tab && VALID_TABS.includes(tab as ActiveTab)) return tab as ActiveTab;
  return "profile";
}

/* ---------- Skeleton Loader ---------- */
function MyPageSkeleton() {
  return (
    <div className="max-w-7xl mx-auto space-y-6 px-8 py-5">
      <div className="h-9 bg-card rounded-2xl animate-pulse w-40" />
      <div className="h-10 bg-card rounded-2xl animate-pulse w-64" />
      <div className="rounded-2xl shadow-sm p-5 lg:p-6 space-y-4 bg-background border border-border/50">
        <div className="h-8 bg-card rounded-2xl animate-pulse w-48" />
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="space-y-1.5">
              <div className="h-4 bg-card rounded animate-pulse w-32" />
              <div className="h-2 bg-card rounded-full animate-pulse" />
            </div>
          ))}
        </div>
      </div>
      <div className="rounded-2xl shadow-sm p-5 lg:p-6 bg-background border border-border/50">
        <div className="h-48 bg-card rounded-2xl animate-pulse" />
      </div>
    </div>
  );
}

/* ---------- Tab config ---------- */
const TABS: { key: ActiveTab; icon: typeof Star; labelKey: string }[] = [
  { key: "profile", icon: Star, labelKey: "tab_profile" },
  { key: "bids", icon: ClipboardList, labelKey: "tab_bids" },
  { key: "tickets", icon: Ticket, labelKey: "tab_tickets" },
  { key: "orders", icon: ShoppingCart, labelKey: "tab_orders" },
  { key: "resale", icon: TrendingUp, labelKey: "tab_resale" },
  { key: "points", icon: Wallet, labelKey: "tab_points" },
];

/* ---------- Main Component ---------- */
function MyPageContent() {
  const { user } = useAuthStore();
  const router = useRouter();
  const searchParams = useSearchParams();
  const t = useTranslations("mypage");

  const queryClient = useQueryClient();
  const [activeTab, setActiveTabState] = useState<ActiveTab>(() =>
    parseActiveTab(searchParams.get("tab")),
  );
  const setActiveTab = useCallback(
    (tab: ActiveTab) => {
      setActiveTabState(tab);
      router.replace(`/mypage?tab=${tab}`, { scroll: false });
    },
    [router],
  );
  const [listingTicket, setListingTicket] = useState<TicketItem | null>(null);
  const [transferTicket, setTransferTicket] = useState<TicketItem | null>(null);
  const [transferChoiceTicket, setTransferChoiceTicket] =
    useState<TicketItem | null>(null);

  /* Core profile data (profile + bids — shared across profile & bids tabs) */
  const { setAuth } = useAuthStore();
  const {
    data: coreData,
    isLoading: loading,
    isError: error,
  } = useQuery({
    queryKey: ["mypage", "core"],
    queryFn: async () => {
      const [meRes, bidsRes, statsRes] = await Promise.all([
        api.get("/users/me", { params: { _t: Date.now() } }),
        getBidHistory(),
        getUserStats(),
      ]);
      if (meRes.data) setAuth(meRes.data, "cookie");
      return {
        bidHistory: bidsRes.data as BidHistoryItem[],
        stats: statsRes.data as UserStatsData,
      };
    },
    retry: (failureCount, err) => {
      if ((err as ApiError)?.response?.status === 401) {
        router.replace("/auth");
        return false;
      }
      return failureCount < 2;
    },
  });

  const bidHistory = coreData?.bidHistory ?? [];
  const _stats = coreData?.stats ?? null;

  const fetchData = () =>
    queryClient.invalidateQueries({ queryKey: ["mypage", "core"] });

  /* Composite fan weight */
  const weight = useMemo(() => {
    if (!user) return 0.5;
    const behaviorScore = Math.max(
      0,
      1 -
        0.5 * (user.no_show_rate ?? 0) -
        0.3 * (user.cancel_rate ?? 0) -
        0.2 * (user.dispute_rate ?? 0),
    );
    const rawWeight =
      (user.verification_level ?? 0) * 0.3 +
      (user.loyalty_score ?? 0) * 0.25 +
      (user.history_score ?? 0) * 0.2 +
      (user.is_fanclub_member ? 0.15 : 0) +
      behaviorScore * 0.1;
    return Math.max(0.5, Math.min(2.0, 0.5 + rawWeight * 1.5));
  }, [user]);

  if (loading || !user) return <MyPageSkeleton />;

  if (error)
    return (
      <div className="max-w-7xl mx-auto px-8 py-20 text-center space-y-4">
        <p className="text-lg font-semibold text-foreground">
          {t("load_error_title")}
        </p>
        <Button
          onClick={() => {
            void fetchData();
          }}
          className="rounded-full"
        >
          {t("retry")}
        </Button>
      </div>
    );

  return (
    <div className="bg-background min-h-screen">
      <motion.main
        className="max-w-7xl mx-auto space-y-6 px-8 pb-5 pt-24"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
      >
        {/* Profile Hero */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
          className={CARD.base}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="h-16 w-16 rounded-full bg-gradient-to-br from-primary to-cyan flex items-center justify-center text-white text-xl font-bold">
                {user?.name?.charAt(0) || "P"}
              </div>
              <div>
                <h1 className="text-2xl font-bold">
                  {user.name || t("default_name")}
                </h1>
                <p className="text-sm text-muted-foreground">{user.email}</p>
              </div>
            </div>
            <div className="text-right">
              <div className="flex items-center gap-1.5 justify-end">
                <Star className="h-6 w-6 text-amber-500 fill-amber-500" />
                <span className="text-4xl font-bold text-primary/70 font-tabular">
                  {weight.toFixed(2)}
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t("activity_score")}
              </p>
              <Badge className={`mt-1 ${BTN.primary}`}>
                {weight >= 1.5
                  ? t("level_super")
                  : weight >= 1.0
                    ? t("level_active")
                    : t("level_new")}
              </Badge>
            </div>
          </div>
        </motion.div>

        {/* Pill Toggle Tabs */}
        <div
          role="tablist"
          className="inline-flex gap-1 bg-muted rounded-full p-1 overflow-x-auto scrollbar-hide"
        >
          {TABS.map(({ key, icon: Icon, labelKey }) => (
            <button
              key={key}
              type="button"
              role="tab"
              id={`mypage-tab-${key}`}
              aria-selected={activeTab === key}
              aria-controls={`mypage-panel-${key}`}
              onClick={() => setActiveTab(key)}
              className={`flex items-center gap-1.5 px-5 py-2.5 rounded-full text-sm font-medium whitespace-nowrap shrink-0 transition-all duration-200 ${
                activeTab === key
                  ? "bg-primary text-white shadow-md"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon className="h-4 w-4" />
              {t(labelKey)}
            </button>
          ))}
        </div>

        {/* Tab content */}
        {activeTab === "profile" && (
          <div
            role="tabpanel"
            id="mypage-panel-profile"
            aria-labelledby="mypage-tab-profile"
          >
            <ProfileTab user={user} bidHistory={bidHistory} />
          </div>
        )}
        {activeTab === "bids" && (
          <div
            role="tabpanel"
            id="mypage-panel-bids"
            aria-labelledby="mypage-tab-bids"
          >
            <BidHistoryTab />
          </div>
        )}
        {activeTab === "tickets" && (
          <div
            role="tabpanel"
            id="mypage-panel-tickets"
            aria-labelledby="mypage-tab-tickets"
          >
            <TicketsTab onTransferChoice={setTransferChoiceTicket} />
          </div>
        )}
        {activeTab === "orders" && (
          <div
            role="tabpanel"
            id="mypage-panel-orders"
            aria-labelledby="mypage-tab-orders"
          >
            <OrdersTab />
          </div>
        )}
        {activeTab === "resale" && (
          <div
            role="tabpanel"
            id="mypage-panel-resale"
            aria-labelledby="mypage-tab-resale"
          >
            <ResaleTab />
          </div>
        )}
        {activeTab === "points" && (
          <div
            role="tabpanel"
            id="mypage-panel-points"
            aria-labelledby="mypage-tab-points"
          >
            <PointsTab />
          </div>
        )}

        {/* Dialogs */}
        {listingTicket && (
          <CreateListingDialog
            open={!!listingTicket}
            onOpenChange={(open) => {
              if (!open) setListingTicket(null);
            }}
            ticket={{
              id: listingTicket.id,
              event_id: listingTicket.event_id,
              event_title: listingTicket.event_title,
              tier_name: listingTicket.tier_name,
              original_price:
                listingTicket.original_price ?? listingTicket.purchase_price,
            }}
            onSuccess={() => {
              queryClient.invalidateQueries({
                queryKey: ["mypage", "tickets"],
              });
              if (activeTab === "resale")
                queryClient.invalidateQueries({
                  queryKey: ["mypage", "resale"],
                });
            }}
          />
        )}

        {transferTicket && (
          <TransferFlow
            open={!!transferTicket}
            transferId={transferTicket.id}
            onClose={() => setTransferTicket(null)}
            onCompleted={() => {
              setTransferTicket(null);
              queryClient.invalidateQueries({
                queryKey: ["mypage", "tickets"],
              });
            }}
          />
        )}

        {transferChoiceTicket && (
          <TransferChoiceDialog
            open={!!transferChoiceTicket}
            onOpenChange={(open) => {
              if (!open) setTransferChoiceTicket(null);
            }}
            ticketTitle={transferChoiceTicket.event_title}
            tierName={transferChoiceTicket.tier_name}
            facePrice={
              transferChoiceTicket.original_price ??
              transferChoiceTicket.purchase_price ??
              0
            }
            waitlistCount={0}
            onFaceValueTransfer={() => {
              setListingTicket({
                ...transferChoiceTicket,
                original_price:
                  transferChoiceTicket.original_price ??
                  transferChoiceTicket.purchase_price,
              });
            }}
            onResaleListing={() => setListingTicket(transferChoiceTicket)}
            onPeerTransfer={() => setTransferTicket(transferChoiceTicket)}
          />
        )}
      </motion.main>
    </div>
  );
}

export default function MyPage() {
  return (
    <Suspense fallback={<MyPageSkeleton />}>
      <MyPageContent />
    </Suspense>
  );
}
