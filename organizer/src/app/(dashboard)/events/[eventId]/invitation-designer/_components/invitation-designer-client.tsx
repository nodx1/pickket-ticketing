"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ExternalLink, Gift } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { fetchWithAuth } from "@/lib/fetchWithAuth";
import { useToast } from "@/lib/hooks/useToast";
import { useUnsavedChanges } from "@/lib/hooks/useUnsavedChanges";

/** F5 초대권 편집 상태 — canvas_json 에 병합 저장되는 초대권 전용 필드. */
interface InvitationDesign {
  accentColor: string;
  logoUrl: string;
  invitationHeaderText: string;
  showEventName: boolean;
  showDate: boolean;
  showVenue: boolean;
  showAttendeeName: boolean;
  showRaffleNumber: boolean;
  showGallery: boolean;
}

const defaults: InvitationDesign = {
  accentColor: "#6C5CE7",
  logoUrl: "",
  invitationHeaderText: "초대권",
  showEventName: true,
  showDate: true,
  showVenue: true,
  showAttendeeName: true,
  showRaffleNumber: true,
  showGallery: true,
};

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function InvitationDesignerClient({ eventId }: { eventId: string }) {
  const { addToast } = useToast();
  const [design, setDesign] = useState<InvitationDesign>(defaults);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  // 🔴 로드 실패 시 저장 잠금 (2026-07-29 감사) — 기본값이 기존 디자인을 덮어쓴다.
  const [loadFailed, setLoadFailed] = useState(false);
  const [previewTicket, setPreviewTicket] = useState<string | null>(null);

  useUnsavedChanges(dirty);

  useEffect(() => {
    let mounted = true;
    async function load() {
      try {
        const res = await fetchWithAuth<{ success: boolean; data: Partial<InvitationDesign> }>(
          `/api/events/${eventId}/ticket-design`,
        );
        if (!res.success || !res.data) throw new Error("디자인을 불러오지 못했습니다");
        if (mounted) {
          setDesign({ ...defaults, ...res.data });
          setDirty(false);
        }
      } catch {
        if (mounted) setLoadFailed(true);
      }
    }
    void load();
    return () => { mounted = false; };
  }, [eventId]);

  // 미리보기 링크용 — 실제 발권된 초대권 1건의 티켓번호를 확보(있으면).
  useEffect(() => {
    async function loadSample() {
      try {
        const res = await fetchWithAuth<{ success: boolean; data: { invitations: Array<{ ticketNumber: string | null }> } }>(
          `/api/events/${eventId}/invitations?limit=1`,
        );
        if (res.success) setPreviewTicket(res.data.invitations.find((i) => i.ticketNumber)?.ticketNumber ?? null);
      } catch { /* ignore */ }
    }
    void loadSample();
  }, [eventId]);

  function edit(patch: Partial<InvitationDesign>) {
    setDesign((prev) => ({ ...prev, ...patch }));
    setDirty(true);
  }

  const accentValid = HEX.test(design.accentColor);

  async function save() {
    if (!accentValid) {
      addToast({ message: "강조 색상 형식(#RRGGBB)을 확인해주세요.", variant: "error" });
      return;
    }
    setSaving(true);
    try {
      const res = await fetchWithAuth<{ success: boolean; error?: string }>(`/api/events/${eventId}/ticket-design`, {
        method: "PUT",
        body: JSON.stringify(design),
      });
      if (res.success) {
        addToast({ message: "초대권 디자인을 저장했습니다.", variant: "success" });
        setDirty(false);
      } else {
        addToast({ message: res.error ?? "저장에 실패했습니다.", variant: "error" });
      }
    } catch {
      addToast({ message: "저장에 실패했습니다.", variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted-foreground">초대권 편집</p>
        <h2 className="mt-2 text-3xl font-black tracking-[-0.04em] text-foreground">초대권 편집</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          수신자가 받는 초대권 화면의 브랜딩과 표시 항목을 설정합니다. 유료 티켓 디자인과는 별도로 적용됩니다.
        </p>
      </div>

      <div className="grid gap-6 xl:grid-cols-[360px_1fr]">
        <Card>
          <CardHeader><CardTitle className="text-foreground">디자인 설정</CardTitle></CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="inv-header">헤더 문구</Label>
              <Input
                id="inv-header"
                maxLength={120}
                placeholder="초대권"
                value={design.invitationHeaderText}
                onChange={(e) => edit({ invitationHeaderText: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">초대권 상단에 표시되는 등급/안내 문구입니다.</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="inv-accent">강조 색상</Label>
              <div className="flex items-center gap-3">
                <input
                  id="inv-accent-picker"
                  type="color"
                  aria-label="강조 색상 선택"
                  className="size-10 shrink-0 cursor-pointer rounded-md border border-border bg-card"
                  value={accentValid ? design.accentColor : "#6C5CE7"}
                  onChange={(e) => edit({ accentColor: e.target.value })}
                />
                <Input
                  id="inv-accent"
                  value={design.accentColor}
                  onChange={(e) => edit({ accentColor: e.target.value })}
                  className={accentValid ? "" : "border-destructive"}
                />
              </div>
              {!accentValid ? <p className="text-xs text-destructive">#RRGGBB 형식으로 입력해주세요.</p> : null}
            </div>

            <div className="space-y-2">
              <Label htmlFor="inv-logo">로고 이미지 URL</Label>
              <Input
                id="inv-logo"
                placeholder="https://..."
                maxLength={2000}
                value={design.logoUrl}
                onChange={(e) => edit({ logoUrl: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">주최자 로고 이미지 주소(선택). 초대권 상단에 표시됩니다.</p>
            </div>

            <div className="space-y-3">
              <p className="text-sm font-semibold text-foreground">표시 항목</p>
              <Toggle label="이벤트명" checked={design.showEventName} onChange={(v) => edit({ showEventName: v })} />
              <Toggle label="일정" checked={design.showDate} onChange={(v) => edit({ showDate: v })} />
              <Toggle label="장소" checked={design.showVenue} onChange={(v) => edit({ showVenue: v })} />
              <Toggle label="수신자명" checked={design.showAttendeeName} onChange={(v) => edit({ showAttendeeName: v })} />
              <Toggle label="경품 번호" checked={design.showRaffleNumber} onChange={(v) => edit({ showRaffleNumber: v })} />
              <Toggle label="갤러리 이미지" checked={design.showGallery} onChange={(v) => edit({ showGallery: v })} />
            </div>

            <Button onClick={() => void save()} disabled={saving || !accentValid || loadFailed || !dirty} className="w-full">
              {saving ? "저장 중..." : "저장하기"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="text-foreground">미리보기</CardTitle>
            {previewTicket ? (
              <Button variant="outline" size="sm" asChild>
                <Link href={`/tickets/${previewTicket}`} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="mr-1.5 size-3.5" />실제 초대권 열기
                </Link>
              </Button>
            ) : null}
          </CardHeader>
          <CardContent>
            <div className="mx-auto max-w-[360px] overflow-hidden rounded-2xl border border-border bg-white">
              <div className="flex items-center justify-center px-6 pt-6">
                {design.logoUrl.trim() ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={design.logoUrl} alt="주최자 로고" className="h-7 w-auto object-contain" />
                ) : (
                  <span className="text-xs uppercase tracking-[0.2em] text-muted-foreground">주최자 로고</span>
                )}
              </div>
              <div className="space-y-3 p-6 text-center">
                <span
                  className="inline-block rounded-full px-3 py-1 text-xs font-bold text-white"
                  style={{ backgroundColor: accentValid ? design.accentColor : "#6C5CE7" }}
                >
                  {design.invitationHeaderText.trim() || "초대권"}
                </span>
                {design.showEventName ? <p className="text-xl font-black tracking-[-0.03em] text-foreground">이벤트 제목</p> : null}
                {design.showAttendeeName ? <p className="text-sm font-semibold text-foreground">홍길동 님</p> : null}
                <div className="mx-auto flex size-32 items-center justify-center rounded-xl bg-muted text-xs text-muted-foreground">QR</div>
                {design.showDate ? <p className="text-sm text-muted-foreground">2026년 10월 3일 ~ 5일</p> : null}
                {design.showVenue ? <p className="text-sm text-muted-foreground">서울 코엑스 · 강남구 영동대로 513</p> : null}
                {design.showRaffleNumber ? (
                  <div className="rounded-lg border border-dashed p-2 text-sm" style={{ borderColor: accentValid ? design.accentColor : "#6C5CE7" }}>
                    <span className="inline-flex items-center gap-1 font-bold" style={{ color: accentValid ? design.accentColor : "#6C5CE7" }}>
                      <Gift className="size-4" />경품 번호 A-0042
                    </span>
                  </div>
                ) : null}
                {design.showGallery ? <div className="h-20 rounded-lg bg-muted" /> : null}
              </div>
            </div>
            {!previewTicket ? (
              <p className="mt-4 text-center text-xs text-muted-foreground">
                초대권을 발권하면 &ldquo;실제 초대권 열기&rdquo; 링크로 결과를 확인할 수 있습니다.
              </p>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 px-4 py-3">
      <Label className="cursor-default">{label}</Label>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
