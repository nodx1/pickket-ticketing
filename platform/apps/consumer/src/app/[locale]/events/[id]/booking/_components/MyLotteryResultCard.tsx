"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  Trophy,
  Clock,
  Hourglass,
  CreditCard,
  ArrowRight,
} from "lucide-react";
import { getMyLotteryEntries, type MyLotteryEntry } from "@pickket/lib/api";
import { api, formatKRW } from "@pickket/lib";
import { useTranslations } from "next-intl";

interface Props {
  eventId: string;
  locale: string;
  /** 응모 직후 강제 리프레시 신호 (숫자 증가 시 재조회) */
  refreshKey?: number;
}

function PaymentCountdown({
  deadline,
  label,
}: {
  deadline: string;
  label: string;
}) {
  const [remain, setRemain] = useState<number>(() =>
    Math.max(0, new Date(deadline).getTime() - Date.now()),
  );
  useEffect(() => {
    const iv = setInterval(() => {
      setRemain(Math.max(0, new Date(deadline).getTime() - Date.now()));
    }, 1000);
    return () => clearInterval(iv);
  }, [deadline]);
  const h = Math.floor(remain / 3600000);
  const m = Math.floor((remain % 3600000) / 60000);
  const s = Math.floor((remain % 60000) / 1000);
  return (
    <span className="font-tabular font-bold" aria-label={label}>
      {h}:{m.toString().padStart(2, "0")}:{s.toString().padStart(2, "0")}
    </span>
  );
}

export default function MyLotteryResultCard({
  eventId,
  locale,
  refreshKey,
}: Props) {
  const t = useTranslations("lottery");

  // 예매 화면에는 응모 패널이 PC·모바일 두 벌 있다. 각자 같은 주소를 동시에 부르면 공통 API 의
  // 중복 GET 취소가 먼저 보낸 쪽을 끊어 PC 화면에 결과 카드가 영영 안 뜬다(당첨자에게 결제 버튼이
  // 안 보이던 결함). 한 쿼리를 함께 쓰게 해 요청이 한 번만 나가게 한다.
  const { data: entries = [], isLoading: loading, refetch } = useQuery<MyLotteryEntry[]>({
    queryKey: ["events", eventId, "lottery", "my-entries"],
    queryFn: async () => (await getMyLotteryEntries(eventId)).data.entries ?? [],
    refetchInterval: 10_000,
    staleTime: 5_000,
    retry: false,
  });
  useEffect(() => {
    if (refreshKey) void refetch();
  }, [refreshKey, refetch]);

  if (loading || entries.length === 0) return null;

  return (
    <div className="mx-6 mt-4 space-y-3">
      {entries.map((e) => {
        const result = e.result.toLowerCase();
        if (result === "won") {
          return (
            <div
              key={e.pool_id}
              className="p-4 rounded-lg bg-emerald-500/10 border border-emerald-500/40"
            >
              <div className="flex items-center gap-2 mb-2">
                <Trophy className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                <span className="text-sm font-bold text-emerald-700">
                  🎉 {e.tier_name} {t("won_tier_label")}
                </span>
              </div>
              {e.seats.length > 0 && (
                <div className="text-xs text-foreground mb-2">
                  {t("assigned_seat")}{" "}
                  {e.seats
                    .map((s) => `${s.section} ${s.row}-${s.seat_number}`)
                    .join(", ")}
                </div>
              )}
              {e.payment_deadline && e.order_status === "payment_required" && (
                <div className="flex items-center gap-1.5 text-xs text-amber-700 mb-3">
                  <Clock className="h-3.5 w-3.5" />
                  <span>{t("payment_deadline_label")}</span>
                  <PaymentCountdown
                    deadline={e.payment_deadline}
                    label={t("payment_deadline_label")}
                  />
                </div>
              )}
              {e.total_amount != null && (
                <div className="text-sm mb-3">
                  {t("payment_amount_label")}{" "}
                  <strong className="font-tabular">
                    {formatKRW(e.total_amount)}
                  </strong>
                </div>
              )}
              {e.order_id && e.order_status === "payment_required" && (
                <Link
                  href={`/${locale}/orders/${e.order_id}`}
                  className="inline-flex items-center gap-1.5 px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-bold hover:bg-emerald-700"
                >
                  <CreditCard className="h-3.5 w-3.5" />
                  {t("go_to_payment")}
                  <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              )}
              {(e.order_status === "paid" ||
                e.order_status === "confirmed") && (
                <div className="text-xs text-emerald-700 font-medium">
                  {t("payment_done")}
                </div>
              )}
            </div>
          );
        }
        if (result === "waitlisted") {
          // 🔴 대기는 낙첨이 아니다 — 당첨자가 결제하지 않으면 순서대로 기회가 넘어간다.
          //    예전엔 「낙첨 · 다음 기회에 도전하세요」로 보여 대기자가 포기하게 만들었다(실측 2026-11-18).
          return (
            <div
              key={e.pool_id}
              className="p-4 rounded-lg bg-amber-500/10 border border-amber-500/40"
            >
              <div className="flex items-center gap-2 mb-1">
                <Hourglass className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                <span className="text-sm font-semibold text-amber-700 dark:text-amber-300">
                  {e.tier_name} · {t("waitlisted_label")}
                </span>
              </div>
              <p className="text-2xs text-foreground">{t("waitlisted_message")}</p>
            </div>
          );
        }
        // pending
        return (
          <div
            key={e.pool_id}
            className="p-4 rounded-lg bg-primary/8 border border-primary/20"
          >
            <div className="flex items-center gap-2 mb-1">
              <Hourglass className="h-4 w-4 text-primary" />
              <span className="text-sm font-semibold text-primary">
                {e.tier_name} · {t("pending_label")}
              </span>
            </div>
            <p className="text-xs text-foreground">
              {e.group_size}
              {t("unit_tickets")}
              {e.invested_ap > 0 &&
                ` · AP ${e.invested_ap.toLocaleString()} ${t("ap_invested")}`}
            </p>
            <p className="text-2xs text-muted-foreground mt-1">
              {t("pending_wait_message")}
            </p>
          </div>
        );
      })}
      <FairnessCertificateLinks eventId={eventId} poolIds={entries.map((e) => e.pool_id)} />
    </div>
  );
}

/**
 * 과업 WP9: 추첨이 끝나 공정성 증명서가 발급된 등급이면 공개 검증 페이지로 바로 가는 링크를 단다.
 * 증명서 페이지에서 '내 응모 확인'으로 내 응모가 명단·결과에 그대로 들어 있는지 직접 확인할 수 있다.
 */
function FairnessCertificateLinks({ eventId, poolIds }: { eventId: string; poolIds: string[] }) {
  // 결과 카드와 같은 이유로(PC·모바일 두 벌이 같은 주소를 동시 호출 → 중복 GET 취소) 한 쿼리를 함께 쓴다.
  // 추첨 직후엔 아직 발급 전일 수 있어 주기적으로 다시 본다.
  const { data: all = [] } = useQuery<Array<{ cert_no: string; pool_id: string; tier_name: string }>>({
    queryKey: ["fairness", "events", eventId, "certificates"],
    queryFn: async () => (await api.get(`/fairness/events/${eventId}/certificates`)).data.certificates ?? [],
    enabled: poolIds.length > 0,
    refetchInterval: 30_000,
    staleTime: 10_000,
    retry: false,
  });
  const wanted = new Set(poolIds);
  const certs = all.filter((c) => wanted.has(c.pool_id));
  if (certs.length === 0) return null;
  return (
    <div className="space-y-1.5">
      {certs.map((c) => (
        <Link
          key={c.cert_no}
          href={`/fairness/certificates/${c.cert_no}`}
          className="flex items-center justify-between rounded-lg border border-border px-4 py-3 text-sm font-semibold hover:bg-muted"
        >
          <span>
            {c.tier_name} 추첨 공정성 증명서 <span className="font-mono text-xs text-muted-foreground">{c.cert_no}</span>
          </span>
          <ArrowRight className="h-4 w-4" />
        </Link>
      ))}
    </div>
  );
}
