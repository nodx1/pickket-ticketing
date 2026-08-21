"use client";

import { useCallback, useEffect, useState } from "react";
import { canSaveEditor } from "@/lib/forms/save-guard";
import { Globe, ShoppingBag, Save } from "lucide-react";
import { fetchWithAuth } from "@/lib/fetchWithAuth";
import { useToast } from "@/lib/hooks/useToast";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

const CHANNELS = [
  { key: "self", label: "자체 페이지", description: "/e/[slug] — pickket.go 내장 이벤트 페이지에서 직접 판매", icon: Globe },
  { key: "marketplace", label: "피켓 마켓", description: "피켓 마켓플레이스에 노출하여 더 많은 구매자에게 도달", icon: ShoppingBag },
] as const;

export function SaleChannels({ eventId }: { eventId: string }) {
  const [channels, setChannels] = useState<string[]>(["self"]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // 🔴 로드 실패 시 저장 잠금 (2026-07-29 감사) — 화면의 기본값이 서버의 실제 값을 덮어쓴다.
  const [loadFailed, setLoadFailed] = useState(false);
  const [dirty, setDirty] = useState(false);
  const { addToast } = useToast();

  const fetchChannels = useCallback(async () => {
    try {
      const res = await fetchWithAuth<{ success: boolean; data: { saleChannels: string[] } }>(`/api/events/${eventId}/sale-channels`);
      if (!res.success) throw new Error("판매 채널을 불러오지 못했습니다");
      setChannels(res.data.saleChannels);
      setDirty(false);
    } catch { setLoadFailed(true); } finally { setLoading(false); }
  }, [eventId]);

  useEffect(() => { fetchChannels(); }, [fetchChannels]);

  const toggle = (key: string) => {
    if (loadFailed) return;
    setDirty(true);
    setChannels((prev) => {
      if (prev.includes(key)) {
        if (prev.length === 1) return prev; // 최소 1개
        return prev.filter((c) => c !== key);
      }
      return [...prev, key];
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetchWithAuth<{ success: boolean }>(`/api/events/${eventId}/sale-channels`, {
        method: "PUT", body: JSON.stringify({ saleChannels: channels }),
      });
      if (!res.success) throw new Error("저장 실패");
      setDirty(false);
      addToast({ message: "판매 채널이 저장되었습니다.", variant: "success" });
    } catch { addToast({ message: "저장에 실패했습니다.", variant: "error" }); }
    finally { setSaving(false); }
  };

  if (loading) return <div className="animate-pulse rounded-lg border border-border bg-card p-6"><div className="h-6 w-48 rounded bg-bg-muted" /></div>;

  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-xl font-bold text-foreground">판매 채널</h3>
          <p className="mt-1 text-sm text-content-subtle">티켓을 어디서 판매할지 선택하세요.</p>
        </div>
        <Button type="button" onClick={save} disabled={!canSaveEditor({ loading, loadFailed, dirty, saving })}>
          <Save className="size-4" />{saving ? "저장 중..." : "저장"}
        </Button>
      </div>
      <div className="space-y-3">
        {CHANNELS.map((ch) => {
          const Icon = ch.icon;
          const active = channels.includes(ch.key);
          return (
            <label key={ch.key} className={`flex w-full cursor-pointer items-center gap-4 rounded-lg border px-5 py-4 text-left transition ${active ? "border-primary/30 bg-primary/5" : "border-border hover:border-border-emphasis"}`}>
              <div className={`flex size-10 items-center justify-center rounded-lg ${active ? "bg-primary/10 text-primary" : "bg-bg-muted text-content-muted"}`}>
                <Icon className="size-5" />
              </div>
              <div className="flex-1">
                <p className={`text-sm font-medium ${active ? "text-foreground" : "text-content-subtle"}`}>{ch.label}</p>
                <p className="text-xs text-content-muted">{ch.description}</p>
              </div>
              <Switch checked={active} onCheckedChange={() => toggle(ch.key)} aria-label={`${ch.label} ${active ? "끄기" : "켜기"}`} />
            </label>
          );
        })}
      </div>
    </div>
  );
}
