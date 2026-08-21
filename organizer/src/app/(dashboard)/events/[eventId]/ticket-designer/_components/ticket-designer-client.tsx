"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useUnsavedChanges } from "@/lib/hooks/useUnsavedChanges";
import { showError, showSuccess } from "@/lib/hooks/useToast";
import { cn } from "@/lib/utils";
import { resolveTicketLogoUrl } from "@/lib/ticket/logo";
import { fetchWithRefresh } from "@/lib/fetchWithAuth";
import { toKstParts } from "@/lib/datetime/kst-local";

interface DesignState {
  /**
   * 정본 키. 종전엔 `logoImageUrl` 로 저장했는데 공개 초대권 화면은 `logoUrl` 을 읽어서,
   * 주최자가 로고를 넣어도 실물 티켓에는 영영 안 나왔다(저장·미리보기는 되니 안 보인다).
   * 읽을 때는 레거시 키를 폴백한다 — `lib/ticket/logo.ts`.
   */
  logoUrl: string;
  backgroundColor: string;
  textColor: string;
  showEventName: boolean;
  showDate: boolean;
  showVenue: boolean;
  showAttendeeName: boolean;
  showProductName: boolean;
  fontScale: number;
}

const defaults: DesignState = {
  logoUrl: "",
  backgroundColor: "#FFFFFF",
  textColor: "#1A1D2E",
  showEventName: true,
  showDate: true,
  showVenue: true,
  showAttendeeName: true,
  showProductName: true,
  fontScale: 1,
};

/** 미리보기에 주입할 실이벤트 데이터. 로드 실패 시 폴백 샘플로 대체한다. */
interface PreviewData {
  eventName: string;
  dateLabel: string;
  venue: string;
  productName: string;
}

const previewFallback: PreviewData = {
  eventName: "PICKKET.GO EVENT",
  dateLabel: "2026.08.15 (금) 19:00",
  venue: "올림픽공원 체조경기장",
  productName: "VIP 티켓",
};

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

/** ISO 문자열 → "2026.08.15 (금) 19:00" 형식. 파싱 실패 시 폴백 라벨 반환. */
function formatPreviewDate(iso: unknown): string {
  if (typeof iso !== "string" || !iso) return previewFallback.dateLabel;
  // 🔴 `d.getFullYear()` 류를 쓰면 **서버 시간대(UTC)** 가 나온다 — organizer 컨테이너는 TZ 미설정이다.
  //    티켓에 찍히는 날짜라 9시간이 밀리면 구매자가 **하루 전날**을 보고 오는 사고가 된다.
  const k = toKstParts(iso);
  if (!k) return previewFallback.dateLabel;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${k.year}.${p(k.month)}.${p(k.day)} (${WEEKDAYS[k.weekday]}) ${p(k.hour)}:${p(k.minute)}`;
}

export function TicketDesignerClient({ eventId }: { eventId: string }) {
  const [design, setDesign] = useState<DesignState>(defaults);
  const [preview, setPreview] = useState<PreviewData>(previewFallback);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  // 🔴 로드 실패 시 저장 잠금 (2026-07-29 감사) — 기본값이 기존 디자인을 덮어쓴다.
  const [loadFailed, setLoadFailed] = useState(false);
  // 로고 URL 이 404 일 때 깨진 이미지 대신 감춘다(폴백 ②). URL 이 바뀌면 다시 시도한다.
  const [logoBroken, setLogoBroken] = useState(false);

  useUnsavedChanges(dirty);

  useEffect(() => {
    let isMounted = true;
    async function load() {
      // 종전에는 try/catch 자체가 없어 네트워크 오류가 미처리 예외가 됐고,
      // 화면은 기본 디자인을 보여준 채 저장이 가능했다.
      try {
        const response = await fetchWithRefresh(`/api/events/${eventId}/ticket-design`, { credentials: "include" });
        if (!response.ok) throw new Error(String(response.status));
        const payload = (await response.json()) as { data?: Partial<DesignState> };
        if (!payload.data) throw new Error("디자인을 불러오지 못했습니다");
        if (isMounted) {
          // 레거시 `logoImageUrl` 로 저장된 기존 데이터를 정본 키로 끌어올린다.
          // 이 폴백이 없으면 키를 통일하는 순간 기존 로고가 전부 사라진다.
          const raw = payload.data as Partial<DesignState> & { logoImageUrl?: string };
          setDesign({
            ...defaults,
            ...raw,
            logoUrl: resolveTicketLogoUrl(raw) ?? "",
          });
          setDirty(false);
        }
      } catch {
        if (isMounted) setLoadFailed(true);
      }
    }
    void load();
    return () => {
      isMounted = false;
    };
  }, [eventId]);

  // 미리보기용 실이벤트 데이터 로드. 이벤트명/날짜/장소는 실값, 참석자명은 PII 노출 방지로 샘플 유지.
  // 로드 실패 시 폴백 샘플을 그대로 사용해 화면이 깨지지 않게 한다.
  useEffect(() => {
    let isMounted = true;
    async function loadPreview() {
      try {
        const [eventRes, productsRes] = await Promise.all([
          fetchWithRefresh(`/api/events/${eventId}`, { credentials: "include" }),
          fetchWithRefresh(`/api/events/${eventId}/products`, { credentials: "include" }),
        ]);
        if (!eventRes.ok) return;
        const eventPayload = (await eventRes.json()) as {
          data?: { title?: string; startsAt?: string; venueName?: string; isOnline?: boolean };
        };
        const ev = eventPayload.data;
        if (!ev) return;
        let productName = previewFallback.productName;
        if (productsRes.ok) {
          const productsPayload = (await productsRes.json()) as { data?: Array<{ name?: string }> };
          const firstName = productsPayload.data?.[0]?.name;
          if (firstName) productName = firstName;
        }
        if (isMounted) {
          setPreview({
            eventName: ev.title || previewFallback.eventName,
            dateLabel: formatPreviewDate(ev.startsAt),
            venue: ev.isOnline ? "온라인" : ev.venueName || previewFallback.venue,
            productName,
          });
        }
      } catch (err: unknown) {
        // 미리보기 데이터 로드 실패는 치명적이지 않다 — 폴백 샘플 유지.
        showError(err instanceof Error ? err.message : "미리보기 데이터를 불러오지 못했습니다");
      }
    }
    void loadPreview();
    return () => {
      isMounted = false;
    };
  }, [eventId]);

  /** setDesign + 미저장 표시. 초기 로드 외 모든 편집에 사용한다. */
  function editDesign(updater: Parameters<typeof setDesign>[0]) {
    setDesign(updater);
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    try {
      const res = await fetchWithRefresh(`/api/events/${eventId}/ticket-design`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(design),
      });
      if (!res.ok) {
        showError("티켓 디자인 저장에 실패했습니다");
        return;
      }
      setDirty(false);
      showSuccess("티켓 디자인을 저장했습니다");
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "저장 중 오류가 발생했습니다");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[320px_1fr]">
      <Card>
        <CardHeader><CardTitle className="text-foreground">티켓 설정</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>로고 이미지 URL</Label>
            <Input value={design.logoUrl} aria-label="로고 이미지 URL" onChange={(event) => {
              // URL 을 고치면 404 표시를 풀고 다시 시도한다 — 안 풀면 오타 한 번에 영영 안 뜬다.
              setLogoBroken(false);
              editDesign((prev) => ({ ...prev, logoUrl: event.target.value }));
            }} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-2"><Label>배경색</Label><Input type="color" value={design.backgroundColor} aria-label="배경색" onChange={(event) => editDesign((prev) => ({ ...prev, backgroundColor: event.target.value }))} /></div>
            <div className="space-y-2"><Label>텍스트색</Label><Input type="color" value={design.textColor} aria-label="텍스트색" onChange={(event) => editDesign((prev) => ({ ...prev, textColor: event.target.value }))} /></div>
          </div>
          {/*
            QR 위치·크기 입력을 제거했다 (2026-07-30, S2).
            저장은 됐지만 **읽는 곳이 디자이너 자기 미리보기뿐**이었다 — 공개 티켓 화면도
            PDF 도 이 값을 보지 않는다(전수 grep). 주최자는 바꿔놓고 실물이 안 바뀌는 걸
            겪게 된다. 🔴 저장 API(`ticket-design/route.ts`)의 `qrPosition`/`qrSize` 는
            그대로 뒀다 — 기존 저장값이 있는 이벤트의 PUT 이 400 으로 깨지면 안 된다.
          */}
          <Toggle label="이벤트명 표시" checked={design.showEventName} onCheckedChange={(checked) => editDesign((prev) => ({ ...prev, showEventName: checked }))} />
          <Toggle label="날짜 표시" checked={design.showDate} onCheckedChange={(checked) => editDesign((prev) => ({ ...prev, showDate: checked }))} />
          <Toggle label="장소 표시" checked={design.showVenue} onCheckedChange={(checked) => editDesign((prev) => ({ ...prev, showVenue: checked }))} />
          <Toggle label="참석자명 표시" checked={design.showAttendeeName} onCheckedChange={(checked) => editDesign((prev) => ({ ...prev, showAttendeeName: checked }))} />
          <Toggle label="상품명 표시" checked={design.showProductName} onCheckedChange={(checked) => editDesign((prev) => ({ ...prev, showProductName: checked }))} />
          <div className="space-y-2">
            <Label>글자 크기</Label>
            <Select value={String(design.fontScale)} onValueChange={(value) => editDesign((prev) => ({ ...prev, fontScale: Number(value) }))}>
              <SelectTrigger aria-label="글자 크기"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="0.9">작게</SelectItem>
                <SelectItem value="1">보통</SelectItem>
                <SelectItem value="1.1">크게</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button onClick={() => void save()} disabled={saving || loadFailed || !dirty}>{saving ? "저장 중..." : "저장"}</Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-foreground">미리보기</CardTitle></CardHeader>
        <CardContent>
          <div
            className="mx-auto max-w-[375px] rounded-xl p-6"
            style={{ backgroundColor: design.backgroundColor, color: design.textColor, fontSize: `${design.fontScale}rem` }}
          >
            {design.logoUrl.trim() && !logoBroken ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={design.logoUrl.trim()}
                alt="티켓 로고"
                className="mx-auto mb-4 h-10 object-contain"
                // 폴백 ② — URL 은 있는데 파일이 404 인 경우. 문자열만 보고는 알 수 없어
                //          렌더 시점에만 잡힌다. 안 감추면 깨진 이미지 아이콘이 박힌다.
                onError={() => setLogoBroken(true)}
              />
            ) : null}
            {design.showEventName ? <p className="font-black tracking-[-0.04em]" style={{ fontSize: "1.6em" }}>{preview.eventName}</p> : null}
            {design.showDate ? <p className="mt-1 opacity-80" style={{ fontSize: "0.85em" }}>{preview.dateLabel}</p> : null}
            {design.showVenue ? <p className="opacity-80" style={{ fontSize: "0.85em" }}>{preview.venue}</p> : null}
            <QrPreview size="md" />
            {design.showAttendeeName ? <p className="mt-6 font-semibold" style={{ fontSize: "1.1em" }}>홍길동</p> : null}
            {design.showProductName ? <p className="mt-2 opacity-80" style={{ fontSize: "0.85em" }}>{preview.productName}</p> : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function QrPreview({ size }: { size: "sm" | "md" | "lg" }) {
  return (
    <div
      className={cn(
        "mx-auto my-6 flex items-center justify-center rounded-[24px] bg-card font-mono text-black",
        size === "sm" ? "size-20 text-xs" : size === "lg" ? "size-40 text-lg" : "size-28 text-sm",
      )}
    >
      QR
    </div>
  );
}

function Toggle({ label, checked, onCheckedChange }: { label: string; checked: boolean; onCheckedChange: (checked: boolean) => void }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-border bg-muted px-4 py-3">
      <Label>{label}</Label>
      <Switch aria-label={label} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}
