"use client";

import { useCallback, useEffect, useState } from "react";
import { canSaveEditor } from "@/lib/forms/save-guard";
import { useParams } from "next/navigation";
import { Globe, Save } from "lucide-react";
import { fetchWithAuth } from "@/lib/fetchWithAuth";
import { useToast } from "@/lib/hooks/useToast";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

interface BridgeConfig { isActive: boolean; title: string; description: string | null; countdownTarget: string | null; backgroundColor: string; logoUrl: string | null; }

export default function BridgePageSettings() {
  const { eventId } = useParams<{ eventId: string }>();
  const [config, setConfig] = useState<BridgeConfig>({ isActive: false, title: "", description: null, countdownTarget: null, backgroundColor: "#6C5CE7", logoUrl: null });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // 🔴 로드 실패 시 저장 잠금 (2026-07-29 감사) — 화면 기본값이 서버의 실제 설정을 덮어쓴다.
  const [loadFailed, setLoadFailed] = useState(false);
  const [dirty, setDirty] = useState(false);
  const { addToast } = useToast();

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetchWithAuth<{ success: boolean; data: Record<string, unknown> }>(`/api/events/${eventId}/bridge-page`);
      if (!res.success || !res.data) throw new Error("설정을 불러오지 못했습니다");
      {
        const d = res.data;
        setConfig({
          isActive: (d.isActive ?? d.is_active ?? false) as boolean,
          title: String(d.title ?? ""),
          description: d.description as string | null,
          countdownTarget: (d.countdownTarget ?? d.countdown_target ?? null) as string | null,
          backgroundColor: String(d.backgroundColor ?? d.background_color ?? "#6C5CE7"),
          logoUrl: (d.logoUrl ?? d.logo_url ?? null) as string | null,
        });
      }
      setDirty(false);
    } catch { setLoadFailed(true); } finally { setLoading(false); }
  }, [eventId]);

  useEffect(() => { fetch_(); }, [fetch_]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetchWithAuth<{ success: boolean }>(`/api/events/${eventId}/bridge-page`, { method: "PUT", body: JSON.stringify(config) });
      if (res.success) addToast({ message: "브릿지페이지가 저장되었습니다.", variant: "success" });
    } catch { addToast({ message: "저장에 실패했습니다.", variant: "error" }); }
    finally { setSaving(false); }
  };

  if (loading) return <div className="animate-pulse rounded-lg border bg-card p-8"><div className="h-6 w-48 rounded bg-bg-muted" /></div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div><p className="text-sm text-content-subtle">브릿지페이지</p><h2 className="mt-2 text-3xl font-black tracking-[-0.04em] text-foreground">브릿지페이지</h2></div>
        <Button type="button" onClick={save} disabled={!canSaveEditor({ loading, loadFailed, dirty, saving })}><Save className="size-4" />{saving ? "저장중..." : "저장"}</Button>
      </div>
      <div className="rounded-lg border border-border bg-card p-6 space-y-5">
        <label className="flex cursor-pointer items-center gap-3">
          <Switch
            checked={config.isActive}
            onCheckedChange={(checked) => setConfig((p) => ({ ...p, isActive: checked }))}
            aria-label="브릿지페이지 활성화"
          />
          <span className="text-sm font-medium">브릿지페이지 활성화</span>
        </label>
        <div><label className="text-sm font-medium text-foreground">제목</label><input value={config.title} onChange={(e) => setConfig(p => ({ ...p, title: e.target.value }))} className="mt-1 w-full rounded-lg border border-border bg-card px-4 py-2.5 text-sm" placeholder="판매 시작까지 조금만 기다려주세요!" /></div>
        <div><label className="text-sm font-medium text-foreground">설명</label><textarea value={config.description ?? ""} onChange={(e) => setConfig(p => ({ ...p, description: e.target.value }))} rows={3} className="mt-1 w-full rounded-lg border border-border bg-card px-4 py-2.5 text-sm" placeholder="판매 시작 전 안내 문구" /></div>
        <div className="grid grid-cols-2 gap-4">
          <div><label className="text-sm font-medium text-foreground">배경색</label><input type="color" value={config.backgroundColor} onChange={(e) => setConfig(p => ({ ...p, backgroundColor: e.target.value }))} className="mt-1 h-10 w-full rounded-lg border border-border" /></div>
          <div><label className="text-sm font-medium text-foreground">카운트다운 대상</label><input type="datetime-local" value={config.countdownTarget ?? ""} onChange={(e) => setConfig(p => ({ ...p, countdownTarget: e.target.value || null }))} className="mt-1 w-full rounded-lg border border-border bg-card px-4 py-2.5 text-sm" /></div>
        </div>
      </div>
      {config.isActive ? (
        <div className="rounded-xl p-8 text-center text-white" style={{ backgroundColor: config.backgroundColor }}>
          <Globe className="mx-auto size-10 opacity-80" />
          <h3 className="mt-4 text-2xl font-bold">{config.title || "브릿지페이지 미리보기"}</h3>
          {config.description ? <p className="mt-2 opacity-80">{config.description}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
