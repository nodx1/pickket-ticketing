"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Shield } from "lucide-react";
import { fetchWithAuth } from "@/lib/fetchWithAuth";

interface BotStats {
  totalOrders: number;
  flaggedOrders: number;
  highRiskOrders: number;
  avgFraudScore: number;
  flaggedList: { id: string; orderNumber: string; buyerName: string; buyerEmail: string; fraudScore: number; fraudFlags: string[]; orderedAt: string }[];
}

export default function BotDetectionPage() {
  const { eventId } = useParams<{ eventId: string }>();
  const [data, setData] = useState<BotStats | null>(null);
  const [loading, setLoading] = useState(true);

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetchWithAuth<{ success: boolean; data: BotStats }>(`/api/events/${eventId}/bot-detection`);
      if (res.success) setData(res.data);
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [eventId]);

  useEffect(() => { fetch_(); }, [fetch_]);

  if (loading) return <div className="animate-pulse rounded-lg border border-border bg-card p-8"><div className="h-6 w-48 rounded bg-bg-muted" /></div>;

  const stats = data ?? { totalOrders: 0, flaggedOrders: 0, highRiskOrders: 0, avgFraudScore: 0, flaggedList: [] };

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-content-subtle">봇탐지</p>
        <h2 className="mt-2 text-3xl font-black tracking-[-0.04em] text-foreground">봇탐지 현황</h2>
      </div>
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: "전체 주문", value: stats.totalOrders },
          { label: "의심 주문", value: stats.flaggedOrders, color: "text-warning" },
          { label: "고위험", value: stats.highRiskOrders, color: "text-error" },
          { label: "평균 위험도", value: `${stats.avgFraudScore ?? 0}점` },
        ].map((s) => (
          <div key={s.label} className="rounded-lg border border-border bg-card p-4">
            <p className="text-xs text-content-muted">{s.label}</p>
            <p className={`mt-1 text-2xl font-bold ${s.color ?? "text-foreground"}`}>{s.value}</p>
          </div>
        ))}
      </div>
      {stats.flaggedList?.length > 0 ? (
        <div className="rounded-lg border border-border bg-card">
          <table className="w-full">
            <thead><tr className="border-b border-border text-left text-xs text-content-muted">
              <th className="px-4 py-3">주문번호</th><th className="px-4 py-3">구매자</th>
              <th className="px-4 py-3">위험도</th><th className="px-4 py-3">플래그</th>
            </tr></thead>
            <tbody>
              {stats.flaggedList.map((o) => (
                <tr key={o.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-3 text-sm">{o.orderNumber}</td>
                  <td className="px-4 py-3 text-sm">{o.buyerName}</td>
                  <td className="px-4 py-3"><span className={`text-sm font-medium ${o.fraudScore > 80 ? "text-error" : "text-warning"}`}>{o.fraudScore}점</span></td>
                  <td className="px-4 py-3"><div className="flex flex-wrap gap-1">{(o.fraudFlags ?? []).map((f, i) => <span key={i} className="rounded bg-warning/10 px-1.5 py-0.5 text-xs text-warning">{String(f)}</span>)}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card p-12 text-center">
          <Shield className="mx-auto size-12 text-success" />
          <h3 className="mt-4 text-lg font-bold">위험 주문이 없습니다</h3>
          <p className="mt-2 text-sm text-content-subtle">모든 주문이 정상 범위입니다.</p>
        </div>
      )}
    </div>
  );
}
