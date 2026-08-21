"use client";

import { useCallback, useEffect, useState } from "react";
import { canSaveEditor } from "@/lib/forms/save-guard";
import { useParams } from "next/navigation";
import { Bell, Save } from "lucide-react";
import { fetchWithAuth } from "@/lib/fetchWithAuth";
import { useToast } from "@/lib/hooks/useToast";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

interface FinalCallConfig { isActive: boolean; triggerHoursBefore: number; discountPercent: number; minRemainingPercent: number; maxDiscountTickets: number | null; notifyBuyers: boolean; }

export default function FinalCallPage() {
  const { eventId } = useParams<{ eventId: string }>();
  const [config, setConfig] = useState<FinalCallConfig>({ isActive: false, triggerHoursBefore: 24, discountPercent: 30, minRemainingPercent: 20, maxDiscountTickets: null, notifyBuyers: true });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // 🔴 로드 실패 시 저장 잠금 (2026-07-29 감사) — 화면 기본값이 서버의 실제 설정을 덮어쓴다.
  const [loadFailed, setLoadFailed] = useState(false);
  const [dirty, setDirty] = useState(false);
  const { addToast } = useToast();

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetchWithAuth<{ success: boolean; data: Record<string, unknown> }>(`/api/events/${eventId}/final-call`);
      if (!res.success || !res.data) throw new Error("설정을 불러오지 못했습니다");
      {
        const d = res.data as Record<string, unknown>;
        setConfig({
          isActive: (d.isActive ?? d.is_active ?? false) as boolean,
          triggerHoursBefore: Number(d.triggerHoursBefore ?? d.trigger_hours_before ?? 24),
          discountPercent: Number(d.discountPercent ?? d.discount_percent ?? 30),
          minRemainingPercent: Number(d.minRemainingPercent ?? d.min_remaining_percent ?? 20),
          maxDiscountTickets: (d.maxDiscountTickets ?? d.max_discount_tickets ?? null) as number | null,
          notifyBuyers: (d.notifyBuyers ?? d.notify_buyers ?? true) as boolean,
        });
      }
      setDirty(false);
    } catch { setLoadFailed(true); } finally { setLoading(false); }
  }, [eventId]);

  useEffect(() => { fetch_(); }, [fetch_]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetchWithAuth<{ success: boolean }>(`/api/events/${eventId}/final-call`, { method: "PUT", body: JSON.stringify(config) });
      if (res.success) addToast({ message: "파이널콜 설정이 저장되었습니다.", variant: "success" });
    } catch { addToast({ message: "저장에 실패했습니다.", variant: "error" }); }
    finally { setSaving(false); }
  };

  if (loading) return <div className="animate-pulse rounded-lg border bg-card p-8"><div className="h-6 w-48 rounded bg-bg-muted" /></div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div><p className="text-sm text-content-subtle">파이널콜</p><h2 className="mt-2 text-3xl font-black tracking-[-0.04em] text-foreground">파이널콜</h2></div>
        <Button type="button" onClick={save} disabled={!canSaveEditor({ loading, loadFailed, dirty, saving })}><Save className="size-4" />{saving ? "저장중..." : "저장"}</Button>
      </div>

      {/* 🔴 "자동 적용" 이라고 쓰면 안 된다 — 실행기가 없다 (2026-07-29 감사에서 확정).
          설정은 v2 `final_call_rules` 에 저장되지만, 그 규칙을 읽어 할인을 발동시키는
          코드가 리포 전체에 없다. celery 태스크는 **이미 만들어진** FinalCall 인스턴스를
          ACTIVE 로 바꿀 뿐이고, 인스턴스 생성은 수동 POST 한 곳뿐이다.
          주최자가 "활성화됨" 배지를 믿고 기다리면 대회 당일까지 아무 일도 안 일어난다.
          기능 카탈로그에서는 이미 숨겼고(sidebar 에도 없다), 이 화면은 URL 직접 접근으로만
          도달한다 — 그래도 들어온 사람이 속지 않도록 상태를 정직하게 적는다. */}
      <div className="rounded-lg border border-warning/40 bg-warning/10 px-4 py-3">
        <p className="text-sm font-medium text-warning">준비 중인 기능입니다 — 자동 할인은 아직 동작하지 않습니다.</p>
        <p className="mt-1 text-xs text-content-subtle">
          아래 설정은 저장되지만, 조건이 되어도 <strong>할인이 자동으로 적용되지 않습니다.</strong>
          잔여석 할인이 필요하시면 프로모코드를 사용해 주세요.
        </p>
      </div>
      <div className="rounded-lg border border-border bg-card p-6 space-y-5">
        <label className="flex cursor-pointer items-center gap-3">
          <Switch
            checked={config.isActive}
            onCheckedChange={(checked) => setConfig((p) => ({ ...p, isActive: checked }))}
            aria-label="파이널콜 활성화"
          />
          <span className="text-sm font-medium">파이널콜 활성화</span>
        </label>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div><label className="text-sm font-medium">이벤트 시작 N시간 전 발동</label><input type="number" value={config.triggerHoursBefore} onChange={(e) => setConfig(p => ({ ...p, triggerHoursBefore: Number(e.target.value) }))} className="mt-1 w-full rounded-lg border border-border bg-card px-4 py-2.5 text-sm" /></div>
          <div><label className="text-sm font-medium">할인율 (%)</label><input type="number" min={5} max={80} value={config.discountPercent} onChange={(e) => setConfig(p => ({ ...p, discountPercent: Number(e.target.value) }))} className="mt-1 w-full rounded-lg border border-border bg-card px-4 py-2.5 text-sm" /></div>
          <div><label className="text-sm font-medium">최소 잔여율 (%)</label><input type="number" min={5} max={90} value={config.minRemainingPercent} onChange={(e) => setConfig(p => ({ ...p, minRemainingPercent: Number(e.target.value) }))} className="mt-1 w-full rounded-lg border border-border bg-card px-4 py-2.5 text-sm" /></div>
          <div><label className="text-sm font-medium">최대 할인 티켓 수</label><input type="number" value={config.maxDiscountTickets ?? ""} onChange={(e) => setConfig(p => ({ ...p, maxDiscountTickets: e.target.value ? Number(e.target.value) : null }))} placeholder="무제한" className="mt-1 w-full rounded-lg border border-border bg-card px-4 py-2.5 text-sm" /></div>
        </div>
        <label className="flex items-center gap-3 cursor-pointer">
          <input type="checkbox" checked={config.notifyBuyers} onChange={(e) => setConfig(p => ({ ...p, notifyBuyers: e.target.checked }))} className="size-4 rounded border-border" />
          <span className="text-sm">기존 구매자에게 알림 발송</span>
        </label>
      </div>
      {config.isActive ? (
        <div className="rounded-lg border border-warning/30 bg-warning/5 px-4 py-3">
          <div className="flex items-center gap-2"><Bell className="size-4 text-warning" /><span className="text-sm font-medium text-warning">설정 저장됨 (미발동)</span></div>
          <p className="mt-1 text-xs text-content-subtle">설정 저장됨 — 이벤트 시작 {config.triggerHoursBefore}시간 전 · 잔여율 {config.minRemainingPercent}% 이상 · 할인 {config.discountPercent}%. <strong>실제 발동은 아직 지원되지 않습니다.</strong></p>
        </div>
      ) : null}
    </div>
  );
}
