"use client";

import { useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import {
  TrendingUp,
  ChevronRight,
  CheckCircle2,
  ShoppingCart,
  Wallet,
  Tag,
} from "lucide-react";
import { Button } from "@pickket/ui";
import { Badge } from "@pickket/ui";
import { formatKRW, formatDateShort } from "@pickket/lib";
import {
  getMyResaleListings,
  getMyResaleBuyOrders,
  cancelResaleListing,
  cancelResaleBuyOrder,
  type MyResaleListing,
  type MyResaleBuyOrder,
} from "@pickket/lib/api";
import { useTranslations } from "next-intl";
import { CARD, BTN } from "@/lib/styles";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

type ApiError = { response?: { status?: number; data?: { detail?: string } } };

export default function ResaleTab() {
  const router = useRouter();
  const t = useTranslations("mypage");
  const queryClient = useQueryClient();

  const { data: resaleData, isLoading: resaleLoading } = useQuery({
    queryKey: ["mypage", "resale"],
    queryFn: async () => {
      const [listingsRes, buyOrdersRes] = await Promise.allSettled([
        getMyResaleListings(),
        getMyResaleBuyOrders(),
      ]);
      const resaleListings =
        listingsRes.status === "fulfilled" ? listingsRes.value.data : [];
      const resaleBuyOrders =
        buyOrdersRes.status === "fulfilled" ? buyOrdersRes.value.data : [];
      const failed = [listingsRes, buyOrdersRes].filter(
        (r) => r.status === "rejected",
      ) as PromiseRejectedResult[];
      const nonServiceError = failed.find(
        (r) => (r.reason as ApiError)?.response?.status !== 503,
      );
      if (nonServiceError) {
        const message =
          (nonServiceError.reason as ApiError)?.response?.data?.detail ||
          t("resale_fetch_error");
        toast.error(message);
      }
      return { resaleListings, resaleBuyOrders };
    },
  });

  // useMemo로 안정화 — ?? [] 는 매 렌더마다 새 배열을 만들어 하위 useMemo 재실행 방지
  const resaleListings = useMemo(
    () => (resaleData?.resaleListings ?? []) as MyResaleListing[],
    [resaleData?.resaleListings],
  );
  const resaleBuyOrders = useMemo(
    () => (resaleData?.resaleBuyOrders ?? []) as MyResaleBuyOrder[],
    [resaleData?.resaleBuyOrders],
  );

  const cancelListingMutation = useMutation({
    mutationFn: (listingId: string) => cancelResaleListing(listingId),
    onSuccess: () => {
      toast.success(t("cancel_success"));
      queryClient.invalidateQueries({ queryKey: ["mypage", "resale"] });
    },
    onError: (err: unknown) => {
      toast.error(
        (err as ApiError)?.response?.data?.detail || t("cancel_listing_error"),
      );
    },
  });

  const cancelBuyOrderMutation = useMutation({
    mutationFn: (buyOrderId: string) => cancelResaleBuyOrder(buyOrderId),
    onSuccess: () => {
      toast.success(t("cancel_success"));
      queryClient.invalidateQueries({ queryKey: ["mypage", "resale"] });
    },
    onError: (err: unknown) => {
      toast.error(
        (err as ApiError)?.response?.data?.detail ||
          t("cancel_buy_order_error"),
      );
    },
  });

  const handleCancelListing = useCallback(
    (listingId: string) => cancelListingMutation.mutate(listingId),
    [cancelListingMutation],
  );

  const handleCancelBuyOrder = useCallback(
    (buyOrderId: string) => cancelBuyOrderMutation.mutate(buyOrderId),
    [cancelBuyOrderMutation],
  );

  const actionLoadingId = cancelListingMutation.isPending
    ? (cancelListingMutation.variables ?? null)
    : cancelBuyOrderMutation.isPending
      ? (cancelBuyOrderMutation.variables ?? null)
      : null;

  const activeListingsCount = useMemo(
    () =>
      resaleListings.filter((listing) => listing.status === "active").length,
    [resaleListings],
  );
  const activeBuyOrdersCount = useMemo(
    () => resaleBuyOrders.filter((order) => order.status === "active").length,
    [resaleBuyOrders],
  );
  const soldListingsCount = useMemo(
    () => resaleListings.filter((listing) => listing.status === "sold").length,
    [resaleListings],
  );
  const resaleRevenue = useMemo(
    () =>
      resaleListings
        .filter((listing) => listing.status === "sold")
        .reduce((sum, listing) => sum + (listing.seller_receives || 0), 0),
    [resaleListings],
  );
  const matchedBuyOrdersCount = useMemo(
    () => resaleBuyOrders.filter((order) => order.status === "matched").length,
    [resaleBuyOrders],
  );
  const completedTransactions = soldListingsCount + matchedBuyOrdersCount;
  const hasNoResaleActivity =
    resaleListings.length === 0 && resaleBuyOrders.length === 0;

  const getListingBadgeStyle = (status: string) => {
    switch (status) {
      case "active":
        return {
          label: t("listing_active"),
          className: "bg-emerald-100 text-emerald-700",
        };
      case "sold":
        return {
          label: t("listing_sold"),
          className: "bg-blue-100 text-blue-700",
        };
      case "cancelled":
        return {
          label: t("listing_cancelled"),
          className: "bg-muted text-muted-foreground",
        };
      case "expired":
        return {
          label: t("listing_expired"),
          className: "bg-orange-100 text-orange-700",
        };
      default:
        return {
          label: status,
          className: "bg-muted text-muted-foreground",
        };
    }
  };

  const getBuyOrderBadgeStyle = (status: string) => {
    switch (status) {
      case "active":
        return {
          label: t("buy_order_active"),
          className: "bg-blue-100 text-blue-700",
        };
      case "matched":
        return {
          label: t("buy_order_matched"),
          className: "bg-emerald-100 text-emerald-700",
        };
      case "cancelled":
        return {
          label: t("buy_order_cancelled"),
          className: "bg-muted text-muted-foreground",
        };
      case "expired":
        return {
          label: t("buy_order_expired"),
          className: "bg-orange-100 text-orange-700",
        };
      default:
        return {
          label: status,
          className: "bg-muted text-muted-foreground",
        };
    }
  };

  return (
    <div className="space-y-6">
      {/* Marketplace Link */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.02 }}
      >
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <TrendingUp className="h-5 w-5 text-primary/70" />
            {t("resale_activity")}
          </h2>
          <Button
            className={`${BTN.primary} gap-1.5`}
            onClick={() => router.push("/sell")}
          >
            <ShoppingCart className="h-4 w-4" />
            {t("view_resale_market")}
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </motion.div>

      {/* Statistics Summary */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05 }}
      >
        <div className={`${CARD.base} space-y-4`}>
          <h3 className="text-base font-semibold">{t("trade_summary")}</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className={CARD.compact}>
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <Tag className="h-3.5 w-3.5" />
                {t("active_sell_listings")}
              </div>
              <p className="text-2xl font-bold font-tabular">
                {activeListingsCount}
              </p>
            </div>
            <div className={CARD.compact}>
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <ShoppingCart className="h-3.5 w-3.5" />
                {t("active_buy_orders")}
              </div>
              <p className="text-2xl font-bold font-tabular">
                {activeBuyOrdersCount}
              </p>
            </div>
            <div className={CARD.compact}>
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <CheckCircle2 className="h-3.5 w-3.5" />
                {t("completed_trades")}
              </div>
              <p className="text-2xl font-bold text-primary/70 font-tabular">
                {completedTransactions}
              </p>
            </div>
            <div className={CARD.compact}>
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <Wallet className="h-3.5 w-3.5" />
                {t("total_revenue")}
              </div>
              <p className="text-2xl font-bold text-cyan font-tabular">
                {formatKRW(resaleRevenue)}
              </p>
            </div>
          </div>
        </div>
      </motion.div>

      {/* Empty State */}
      {!resaleLoading && hasNoResaleActivity && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
        >
          <div className={`${CARD.base} p-8 text-center`}>
            <div className="mx-auto mb-4 h-16 w-16 rounded-full bg-card flex items-center justify-center">
              <TrendingUp className="h-8 w-8 text-muted-foreground opacity-40" />
            </div>
            <p className="text-lg font-semibold text-foreground">
              {t("no_resale_activity")}
            </p>
            <p className="text-sm text-muted-foreground mt-1.5">
              {t("no_resale_sub")}
            </p>
            <Button
              className={`mt-5 ${BTN.primary} gap-1.5`}
              onClick={() => router.push("/sell")}
            >
              <ShoppingCart className="h-4 w-4" />
              {t("browse_market")}
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </motion.div>
      )}

      {/* Listings Section */}
      {(resaleLoading || !hasNoResaleActivity) && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
        >
          <div className="rounded-2xl shadow-sm p-5 lg:p-6 bg-background border border-border/50">
            <h3 className="text-base font-semibold mb-4">
              {t("sell_listings")}
            </h3>
            {resaleLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 2 }).map((_, i) => (
                  <div
                    key={i}
                    className="h-24 bg-card rounded-2xl animate-pulse"
                  />
                ))}
              </div>
            ) : resaleListings.length === 0 ? (
              <div className="rounded-2xl bg-card p-6 text-center text-sm text-muted-foreground">
                {t("no_sell_listings")}
              </div>
            ) : (
              <div className="space-y-3">
                {resaleListings.map((listing, index) => {
                  const badge = getListingBadgeStyle(listing.status);
                  const canCancel = listing.status === "active";
                  return (
                    <motion.div
                      key={listing.id}
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: index * 0.03 }}
                      className="flex items-start justify-between rounded-2xl shadow-none hover:shadow-md hover:-translate-y-0.5 transition-all duration-200 p-4 bg-card"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">
                          {listing.event_title || t("event_info")}
                        </p>
                        <div className="mt-1 text-xs text-muted-foreground flex items-center gap-2">
                          <span>{listing.tier_name || t("tier_info")}</span>
                          <span>
                            {t("registered_date")}{" "}
                            {formatDateShort(listing.created_at)}
                          </span>
                        </div>
                        <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                          <div>
                            <p className="text-muted-foreground">
                              {t("asking_price")}
                            </p>
                            <p className="font-semibold font-tabular">
                              {formatKRW(listing.asking_price)}
                            </p>
                          </div>
                          <div>
                            <p className="text-muted-foreground">{t("fee")}</p>
                            <p className="font-semibold font-tabular">
                              {formatKRW(listing.platform_fee || 0)}
                            </p>
                          </div>
                          <div>
                            <p className="text-muted-foreground">
                              {t("net_amount")}
                            </p>
                            <p className="font-semibold text-cyan font-tabular">
                              {formatKRW(listing.seller_receives || 0)}
                            </p>
                          </div>
                        </div>
                      </div>
                      <div className="ml-3 flex items-center gap-2 shrink-0">
                        <Badge
                          className={`text-xs rounded-full px-2.5 py-0.5 ${badge.className}`}
                        >
                          {badge.label}
                        </Badge>
                        <Button
                          variant="outline"
                          size="sm"
                          className="rounded-full text-xs h-8 px-3"
                          disabled={
                            !canCancel || actionLoadingId === listing.id
                          }
                          onClick={() => void handleCancelListing(listing.id)}
                        >
                          {t("cancel")}
                        </Button>
                      </div>
                    </motion.div>
                  );
                })}
              </div>
            )}
          </div>
        </motion.div>
      )}

      {/* Buy Orders Section */}
      {(resaleLoading || !hasNoResaleActivity) && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
        >
          <div className="rounded-2xl shadow-sm p-5 lg:p-6 bg-background border border-border/50">
            <h3 className="text-base font-semibold mb-4">{t("buy_orders")}</h3>
            {resaleLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 2 }).map((_, i) => (
                  <div
                    key={i}
                    className="h-20 bg-card rounded-2xl animate-pulse"
                  />
                ))}
              </div>
            ) : resaleBuyOrders.length === 0 ? (
              <div className="rounded-2xl bg-card p-6 text-center text-sm text-muted-foreground">
                {t("no_buy_orders")}
              </div>
            ) : (
              <div className="space-y-3">
                {resaleBuyOrders.map((order, index) => {
                  const badge = getBuyOrderBadgeStyle(order.status);
                  const canCancel = order.status === "active";
                  return (
                    <motion.div
                      key={order.id}
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: index * 0.03 }}
                      className="flex items-center justify-between rounded-2xl shadow-none hover:shadow-md hover:-translate-y-0.5 transition-all duration-200 p-4 bg-card"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">
                          {order.event_title || t("event_info")}
                        </p>
                        <div className="mt-1 text-xs text-muted-foreground flex items-center gap-2">
                          <span>{order.tier_name || t("tier_info")}</span>
                          <span>
                            {t("registered_date")}{" "}
                            {formatDateShort(order.created_at)}
                          </span>
                        </div>
                        <p className="mt-2 text-xs">
                          {t("max_price")}{" "}
                          <span className="font-semibold font-tabular">
                            {formatKRW(order.max_price)}
                          </span>
                        </p>
                      </div>
                      <div className="ml-3 flex items-center gap-2 shrink-0">
                        <Badge
                          className={`text-xs rounded-full px-2.5 py-0.5 ${badge.className}`}
                        >
                          {badge.label}
                        </Badge>
                        <Button
                          variant="outline"
                          size="sm"
                          className="rounded-full text-xs h-8 px-3"
                          disabled={!canCancel || actionLoadingId === order.id}
                          onClick={() => void handleCancelBuyOrder(order.id)}
                        >
                          {t("cancel")}
                        </Button>
                      </div>
                    </motion.div>
                  );
                })}
              </div>
            )}
          </div>
        </motion.div>
      )}
    </div>
  );
}
