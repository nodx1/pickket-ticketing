"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Trophy,
  Clock,
  XCircle,
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
  const [entries, setEntries] = useState<MyLotteryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const t = useTranslations("lottery");

  useEffect(() => {
    let cancelled = false;
    const fetch = async () => {
      try {
        const res = await getMyLotteryEntries(eventId);
        if (!cancelled) setEntries(res.data.entries ?? []);
      } catch {
        if (!cancelled) setEntries([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetch();
    const iv = setInterval(fetch, 10_000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [eventId, refreshKey]);

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
          return (
            <div
              key={e.pool_id}
              className="p-4 rounded-lg bg-muted/40 border border-border opacity-75"
            >
              <div className="flex items-center gap-2 mb-1">
                <XCircle className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-semibold text-muted-foreground">
                  {e.tier_name} · {t("lost_label")}
                </span>
              </div>
              <p className="text-2xs text-muted-foreground">
                {e.invested_ap > 0
                  ? t("ap_refund_message")
                      .replace("{ap}", e.invested_ap.toLocaleString())
                      .replace(
                        "{bonus}",
                        Math.floor(e.invested_ap * 0.1).toLocaleString(),
                      )
                  : t("next_chance")}
              </p>
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
  const [certs, setCerts] = useState<Array<{ cert_no: string; pool_id: string; tier_name: string }>>([]);
  const key = poolIds.join(",");
  useEffect(() => {
    let cancelled = false;
    api
      .get(`/fairness/events/${eventId}/certificates`)
      .then((res) => {
        if (cancelled) return;
        const wanted = new Set(key.split(","));
        setCerts((res.data.certificates ?? []).filter((c: { pool_id: string }) => wanted.has(c.pool_id)));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [eventId, key]);
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
