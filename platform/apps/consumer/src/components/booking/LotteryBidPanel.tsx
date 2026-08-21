"use client";

/**
 * 공정 추첨 응모 패널.
 *
 * 사용처: 이벤트 상세 페이지에서 current phase 가 lottery/membership_presale 일 때 노출.
 * 팬이 구역 + 수량 선택 → pickket.go 공개 API 에 bid POST.
 *
 * 당첨/낙첨 결과는 phase 가 closed → allocated 된 후 my-bid 조회로 확인.
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "@pickket/store";
import { GO_URL } from "@pickket/lib";
import { Button } from "@pickket/ui";
import { toast } from "sonner";
import type { SalePhaseDTO, SalePhaseMode } from "@/hooks/useCurrentPhase";
import { useTranslations } from "next-intl";

interface VenueTier {
  id: string;
  name: string;
  base_price: number;
  color_hex?: string | null;
}

interface BidDTO {
  id: string;
  status: "pending" | "won" | "lost" | "expired";
  quantity: number;
  tierId: string | null;
  wonSeatIds: string[] | null;
  expiresAt: string | null;
  orderId: string | null;
  phaseMode: SalePhaseMode;
  phaseStatus: string;
}

interface Props {
  slug: string;
  phase: SalePhaseDTO;
  tiers: VenueTier[];
}

const MODE_EMOJIS: Record<SalePhaseMode, string> = {
  membership_presale: "🎁",
  lottery: "🎲",
  // 레벨2 컷오버 T2-PHASE: v2 phase_configs 는 대기자 자동 승격 단계도 노출한다.
  waitlist_promotion: "🔁",
  queue_sale: "🚶",
  fcfs_residual: "⏱",
};

function formatCountdown(target: Date): string {
  const diff = target.getTime() - Date.now();
  if (diff <= 0) return "마감";
  const hours = Math.floor(diff / 3_600_000);
  const minutes = Math.floor((diff % 3_600_000) / 60_000);
  if (hours >= 24) return `D-${Math.floor(hours / 24)} ${hours % 24}시간`;
  return `${hours}시간 ${minutes}분`;
}

export default function LotteryBidPanel({ slug, phase, tiers }: Props) {
  const user = useAuthStore((s) => s.user);
  const [tierId, setTierId] = useState<string>(tiers[0]?.id ?? "");
  const [quantity, setQuantity] = useState<1 | 2>(1);
  const queryClient = useQueryClient();
  const t = useTranslations("lottery");

  const modeEmoji = MODE_EMOJIS[phase.mode];
  const modeLabel = t(`mode_${phase.mode}` as Parameters<typeof t>[0]);

  // 내 응모 내역 (당첨 결과 확인용)
  const { data: myBids } = useQuery<BidDTO[]>({
    queryKey: ["pickket-go-my-bid", slug, user?.id],
    enabled: Boolean(slug && user?.id),
    staleTime: 15_000,
    queryFn: async () => {
      if (!user?.id) return [];
      // go bids API 는 쿠키 인증 — credentials:"include" 로 세션 쿠키 전송(go 가
      // x-user-id 헤더는 무시). x-user-id 제거로 GET 은 simple request(프리플라이트 X).
      const res = await fetch(
        `${GO_URL}/api/public/events/${encodeURIComponent(slug)}/bids`,
        { credentials: "include" },
      );
      if (!res.ok) return [];
      const payload = (await res.json()) as { data: BidDTO[] };
      return payload.data ?? [];
    },
  });

  const myActiveBid = useMemo(
    () =>
      (myBids ?? []).find(
        (b) =>
          b.status === "pending" ||
          b.status === "won" ||
          b.phaseStatus === "open",
      ),
    [myBids],
  );

  const submitBid = useMutation({
    mutationFn: async () => {
      if (!user?.id) throw new Error("로그인이 필요합니다");
      const res = await fetch(
        `${GO_URL}/api/public/events/${encodeURIComponent(slug)}/bids`,
        {
          method: "POST",
          credentials: "include", // 쿠키 인증(go) — x-user-id 무시됨
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ tierId, quantity }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? "응모에 실패했습니다",
        );
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success(t("apply_success_toast"));
      void queryClient.invalidateQueries({
        queryKey: ["pickket-go-my-bid", slug],
      });
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  const closesAtDate = phase.closesAt ? new Date(phase.closesAt) : null;
  const canSubmit = phase.status === "open" && !submitBid.isPending;

  // 이미 당첨된 경우 결과 표시
  if (myActiveBid?.status === "won") {
    return (
      <div className="rounded-lg border border-primary bg-primary/5 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-2xl">🎉</span>
          <h3 className="text-lg font-bold">{t("won_title")}</h3>
        </div>
        <p className="text-sm text-muted-foreground">
          {myActiveBid.quantity}
          {t("unit_tickets")}{" "}
          {myActiveBid.wonSeatIds?.length ?? 0}
        </p>
        {myActiveBid.expiresAt && (
          <p className="text-sm">
            <span className="font-semibold text-warning">
              {t("payment_deadline").replace(
                "{time}",
                formatCountdown(new Date(myActiveBid.expiresAt)),
              )}
            </span>
          </p>
        )}
        <Button className="w-full">{t("pay_cta")}</Button>
      </div>
    );
  }

  // 낙첨
  if (myActiveBid?.status === "lost") {
    return (
      <div className="rounded-lg border bg-card p-4 space-y-2">
        <p className="font-semibold">{t("lost_title")}</p>
        <p className="text-xs text-muted-foreground">{t("lost_body")}</p>
      </div>
    );
  }

  // 이미 응모함 (pending)
  if (myActiveBid?.status === "pending") {
    return (
      <div className="rounded-lg border bg-card p-4 space-y-2">
        <p className="font-semibold">{t("pending_applied_label")}</p>
        <p className="text-xs text-muted-foreground">
          {myActiveBid.quantity}
          {t("unit_tickets")} ·{" "}
          {t("pending_applied_wait").replace(
            "{deadline}",
            closesAtDate?.toLocaleString() ?? "",
          )}
        </p>
      </div>
    );
  }

  // 응모 폼
  return (
    <div className="rounded-lg border bg-card p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-2xl">{modeEmoji}</span>
          <div>
            <h3 className="font-bold">
              {t("mode_active").replace("{mode}", modeLabel)}
            </h3>
            {closesAtDate && (
              <p className="text-xs text-muted-foreground">
                {t("closing_in").replace(
                  "{time}",
                  formatCountdown(closesAtDate),
                )}
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <label className="mb-1.5 block text-xs font-semibold">
            {t("section_select")}
          </label>
          <div className="space-y-1.5">
            {tiers.map((tier) => (
              <label
                key={tier.id}
                className={`flex cursor-pointer items-center gap-2 rounded-md border p-2.5 transition ${
                  tierId === tier.id
                    ? "border-primary bg-primary/5"
                    : "border-border hover:bg-muted/30"
                }`}
              >
                <input
                  type="radio"
                  name="tier"
                  checked={tierId === tier.id}
                  onChange={() => setTierId(tier.id)}
                />
                <span
                  className="inline-block size-3 rounded-full border"
                  style={{ backgroundColor: tier.color_hex ?? "#9ca3af" }}
                />
                <span className="flex-1 text-sm font-semibold">{tier.name}</span>
                <span className="text-sm">
                  {Number(tier.base_price).toLocaleString()}원
                </span>
              </label>
            ))}
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-xs font-semibold">
            {t("quantity")}
          </label>
          <div className="flex gap-2">
            {[1, 2].map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => setQuantity(q as 1 | 2)}
                className={`flex-1 rounded-md border p-2 text-sm font-semibold transition ${
                  quantity === q
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border hover:bg-muted"
                }`}
              >
                {q}{t("unit_tickets")}
              </button>
            ))}
          </div>
          {quantity === 2 && (
            <p className="mt-1 text-xs text-muted-foreground">
              {t("two_seats_hint")}
            </p>
          )}
        </div>

        <div className="rounded-md bg-muted/30 p-3 text-xs space-y-1 text-muted-foreground">
          <p>{t("fair_random")}</p>
          <p>{t("fair_no_bot")}</p>
          <p>{t("fair_72h")}</p>
          <p>{t("fair_residual")}</p>
        </div>

        <Button
          className="w-full"
          disabled={!canSubmit || !tierId || !user}
          onClick={() => submitBid.mutate()}
        >
          {!user
            ? t("login_first")
            : submitBid.isPending
              ? t("submitting")
              : t("apply_cta")}
        </Button>
      </div>
    </div>
  );
}
