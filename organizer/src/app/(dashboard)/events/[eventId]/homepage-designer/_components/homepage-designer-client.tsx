"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Palette } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchWithAuth, fetchWithRefresh } from "@/lib/fetchWithAuth";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useUnsavedChanges } from "@/lib/hooks/useUnsavedChanges";

interface DesignState {
  coverImageUrl: string;
  backgroundColor: string;
  textColor: string;
  accentColor: string;
  showCountdown: boolean;
  showVenueMap: boolean;
  showOrganizer: boolean;
  sections: string[];
  templateId?: string;
  heroHeadline?: string;
  heroSubtext?: string;
  ctaText?: string;
  sectionDescriptions?: Record<string, string>;
}

/**
 * 🔴 이 화면이 **편집하는 키만** 보낸다 (2026-07-31 적대검수 H2).
 *
 * PUT→PATCH 로 바꾼 것만으로는 부족했다. GET 은 `homepage_design` **전체**를 주고
 * `setDesign({ ...defaultState, ...payload.data })` 가 그걸 그대로 안는다. 그래서
 * `JSON.stringify(design)` 이 **이 화면이 모르는 키까지 되돌려 보낸다**:
 *
 *     탭 A 마운트(문구 = "옛 문구") → 탭 B 가 "새 문구" 저장 → 탭 A 에서 색만 바꿔 저장
 *       PATCH 본문에 refundNotice("옛 문구")·detailImages 가 실려 나간다
 *       ⟹ 새 문구가 **옛 문구로 되돌아간다.** 에러도 로그도 없다.
 *
 * `buildHomepageDesignPatch` 는 "요청에 있는 키" 만 거르므로 이걸 못 막는다 —
 * 보내지 않는 것이 유일한 방어다. **문구가 이미 있는 경우가 더 흔하다**(KLPGA 가 그렇다).
 *
 * ⚠️ 새 항목을 이 화면에 추가하면 **여기에도 키를 넣어야** 저장된다.
 */
const DESIGNER_KEYS = [
  "coverImageUrl",
  "backgroundColor",
  "textColor",
  "accentColor",
  "showCountdown",
  "showVenueMap",
  "showOrganizer",
  "sections",
  "templateId",
  "heroHeadline",
  "heroSubtext",
  "ctaText",
  "sectionDescriptions",
] as const satisfies ReadonlyArray<keyof DesignState>;

function pickDesignerKeys(design: DesignState): Partial<DesignState> {
  const out: Record<string, unknown> = {};
  for (const key of DESIGNER_KEYS) {
    if (design[key] !== undefined) out[key] = design[key];
  }
  return out as Partial<DesignState>;
}

interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  cssVars: {
    backgroundColor: string;
    textColor: string;
    accentColor: string;
    heroGradient: string;
    cardBorder: string;
    cardBackground: string;
  };
}

const TEMPLATE_LIST: TemplateInfo[] = [
  { id: "minimal", name: "미니멀", description: "깔끔하고 여백이 넉넉한", cssVars: { backgroundColor: "#FAFBFF", textColor: "#1A1D2E", accentColor: "#6C5CE7", heroGradient: "linear-gradient(135deg, #F5F3FF 0%, #EDE9FE 100%)", cardBorder: "rgba(0,0,0,0.06)", cardBackground: "rgba(255,255,255,0.95)" } },
  { id: "bold", name: "볼드", description: "강렬하고 에너지 넘치는", cssVars: { backgroundColor: "#FFF5F7", textColor: "#1A1D2E", accentColor: "#FF3366", heroGradient: "linear-gradient(135deg, #FF3366 0%, #6C5CE7 50%, #FFF5F7 100%)", cardBorder: "rgba(255,51,102,0.15)", cardBackground: "rgba(255,255,255,0.95)" } },
  { id: "elegant", name: "엘레강스", description: "고급스럽고 세련된", cssVars: { backgroundColor: "#FEFCF8", textColor: "#2C2418", accentColor: "#C9A96E", heroGradient: "linear-gradient(135deg, #FAF5EB 0%, #F5ECD8 50%, #FEFCF8 100%)", cardBorder: "rgba(201,169,110,0.20)", cardBackground: "rgba(255,255,255,0.95)" } },
  { id: "festival", name: "페스티벌", description: "밝고 축제 분위기", cssVars: { backgroundColor: "#F0FDF9", textColor: "#1A1D2E", accentColor: "#059669", heroGradient: "linear-gradient(135deg, #059669 0%, #6C5CE7 50%, #F59E0B 100%)", cardBorder: "rgba(5,150,105,0.12)", cardBackground: "rgba(255,255,255,0.95)" } },
  { id: "corporate", name: "코퍼레이트", description: "전문적이고 신뢰감 있는", cssVars: { backgroundColor: "#F8FAFC", textColor: "#1E293B", accentColor: "#3B82F6", heroGradient: "linear-gradient(135deg, #EFF6FF 0%, #F8FAFC 100%)", cardBorder: "rgba(59,130,246,0.12)", cardBackground: "rgba(255,255,255,0.95)" } },
  { id: "kpop", name: "K-POP", description: "팬덤 감성, 글로우 효과", cssVars: { backgroundColor: "#FAF5FF", textColor: "#1A1D2E", accentColor: "#A29BFE", heroGradient: "linear-gradient(135deg, #A29BFE 0%, #FF6B9D 50%, #FAF5FF 100%)", cardBorder: "rgba(162,155,254,0.18)", cardBackground: "rgba(255,255,255,0.95)" } },
  { id: "community", name: "커뮤니티", description: "따뜻하고 친근한", cssVars: { backgroundColor: "#F0F9FF", textColor: "#1A1D2E", accentColor: "#0EA5E9", heroGradient: "linear-gradient(135deg, #0EA5E9 0%, #F0F9FF 70%)", cardBorder: "rgba(14,165,233,0.12)", cardBackground: "rgba(255,255,255,0.95)" } },
  { id: "tech", name: "테크", description: "미래지향적 사이버 느낌", cssVars: { backgroundColor: "#F0FDF4", textColor: "#1A1D2E", accentColor: "#10B981", heroGradient: "linear-gradient(135deg, #10B981 0%, #3B82F6 50%, #F0FDF4 100%)", cardBorder: "rgba(16,185,129,0.12)", cardBackground: "rgba(255,255,255,0.95)" } },
];

const defaultState: DesignState = {
  coverImageUrl: "",
  backgroundColor: "#FAFBFF",
  textColor: "#1A1D2E",
  accentColor: "#6C5CE7",
  showCountdown: true,
  showVenueMap: true,
  showOrganizer: true,
  sections: ["event", "products", "venue", "organizer"],
};

export function HomepageDesignerClient({ eventId }: { eventId: string }) {
  const [design, setDesign] = useState<DesignState>(defaultState);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [showTemplates, setShowTemplates] = useState(true);
  const [dirty, setDirty] = useState(false);
  // 🔴 로드 실패를 표시하고 저장을 잠근다 (2026-07-29 감사). PUT 은 전체 교체라
  //    기본값 상태로 저장하면 커버이미지·색·템플릿·상세이미지가 통째로 덮인다.
  const [loadFailed, setLoadFailed] = useState(false);

  const [error, setError] = useState<string | null>(null);

  useUnsavedChanges(dirty);

  useEffect(() => {
    let isMounted = true;
    async function load() {
      try {
        const response = await fetchWithRefresh(`/api/events/${eventId}/homepage-design`, { credentials: "include" });
        if (!response.ok) throw new Error(String(response.status));
        const payload = (await response.json()) as { data?: Partial<DesignState> };
        if (isMounted && payload.data) {
          setDesign({ ...defaultState, ...payload.data });
          if (payload.data.templateId) {
            setSelectedTemplateId(payload.data.templateId);
          }
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

  const [saved, setSaved] = useState(false);

  /** setDesign + 미저장 표시. 초기 로드 외 모든 편집에 사용한다. */
  function editDesign(updater: Parameters<typeof setDesign>[0]) {
    setDesign(updater);
    setDirty(true);
  }

  /** 템플릿 선택 시 색상 팔레트를 디자인에 즉시 반영(수동 편집 기반). */
  function applyTemplate(template: TemplateInfo) {
    setSelectedTemplateId((prev) => (prev === template.id ? null : template.id));
    editDesign((prev) => ({
      ...prev,
      templateId: template.id,
      backgroundColor: template.cssVars.backgroundColor,
      textColor: template.cssVars.textColor,
      accentColor: template.cssVars.accentColor,
    }));
  }

  async function save() {
    setError(null);
    setSaved(false);
    try {
      // 🔴 PUT → PATCH (2026-07-31, 코덱스 감사).
      //
      // PUT 은 `homepage_design` 을 **통째로 교체**한다. 이 화면은 마운트 시점에 읽은
      // 스냅샷(`design`)을 그대로 보내므로, 그사이 **다른 화면이 저장한 키가 사라진다**:
      //
      //   1) 탭 A 에서 디자이너를 연다(그때 환불 안내 문구 없음)
      //   2) 탭 B 에서 환불 정책 화면이 안내 문구를 저장
      //   3) 탭 A 에서 색만 바꿔 저장 → 옛 스냅샷에 문구가 없어 **삭제된다**
      //
      // 스키마에 필드를 넣은 것은 "같은 스냅샷을 왕복" 할 때만 안전하고, 다중 화면의
      // stale PUT 은 못 막는다. PATCH 는 **보낸 키만** 병합하므로(`buildHomepageDesignPatch`)
      // 이 화면이 모르는 키를 건드리지 않는다. 파생 write(event_pages)도 PATCH 에 있다.
      await fetchWithAuth(`/api/events/${eventId}/homepage-design`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pickDesignerKeys(design)),
      });
      setSaved(true);
      setDirty(false);
      setTimeout(() => setSaved(false), 3000);
    } catch {
      setError("디자인 저장에 실패했습니다. 다시 시도해주세요.");
    }
  }

  const activeTemplate = TEMPLATE_LIST.find(
    (template) => template.id === (design.templateId ?? selectedTemplateId),
  );

  return (
    <div className="grid gap-6 xl:grid-cols-[380px_1fr]">
      <div className="space-y-4">
        {error ? (
          <div className="rounded-lg border border-error/40 bg-error/5 p-4 text-sm text-error">
            {error}
          </div>
        ) : null}
        <Card>
          <CardHeader>
            <button
              type="button"
              onClick={() => setShowTemplates((prev) => !prev)}
              className="flex w-full items-center justify-between"
            >
              <CardTitle className="flex items-center gap-2 text-foreground">
                <Palette className="size-4 text-primary" />
                디자인 템플릿
              </CardTitle>
              {showTemplates ? (
                <ChevronUp className="size-4 text-muted-foreground" />
              ) : (
                <ChevronDown className="size-4 text-muted-foreground" />
              )}
            </button>
          </CardHeader>
          {showTemplates ? (
            <CardContent>
              <div className="grid grid-cols-2 gap-2">
                {TEMPLATE_LIST.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    onClick={() => applyTemplate(template)}
                    className={cn(
                      "rounded-lg border p-3 text-left transition",
                      selectedTemplateId === template.id
                        ? "border-primary bg-primary/10"
                        : "border-border bg-muted hover:border-border-emphasis",
                    )}
                  >
                    <div
                      className="mb-2 h-8 rounded-xl"
                      style={{ background: template.cssVars.heroGradient }}
                    />
                    <p className="text-xs font-bold text-foreground">{template.name}</p>
                    <p className="text-[10px] text-muted-foreground">{template.description}</p>
                  </button>
                ))}
              </div>
            </CardContent>
          ) : null}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-foreground">
              <Palette className="size-4" />
              세부 설정
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="cover-image">커버 이미지 URL</Label>
              <Input id="cover-image" value={design.coverImageUrl} onChange={(event) => editDesign((prev) => ({ ...prev, coverImageUrl: event.target.value }))} />
            </div>
            <div className="grid gap-4 lg:grid-cols-3">
              <div className="space-y-2"><Label>배경</Label><Input type="color" value={design.backgroundColor} onChange={(event) => editDesign((prev) => ({ ...prev, backgroundColor: event.target.value }))} /></div>
              <div className="space-y-2"><Label>텍스트</Label><Input type="color" value={design.textColor} onChange={(event) => editDesign((prev) => ({ ...prev, textColor: event.target.value }))} /></div>
              <div className="space-y-2"><Label>강조색</Label><Input type="color" value={design.accentColor} onChange={(event) => editDesign((prev) => ({ ...prev, accentColor: event.target.value }))} /></div>
            </div>
            <ToggleRow label="카운트다운 표시" checked={design.showCountdown} onCheckedChange={(checked) => editDesign((prev) => ({ ...prev, showCountdown: checked }))} />
            <ToggleRow label="장소 표시" checked={design.showVenueMap} onCheckedChange={(checked) => editDesign((prev) => ({ ...prev, showVenueMap: checked }))} />
            <ToggleRow label="주최자 표시" checked={design.showOrganizer} onCheckedChange={(checked) => editDesign((prev) => ({ ...prev, showOrganizer: checked }))} />
          </CardContent>
        </Card>

        <Button onClick={() => void save()} disabled={loadFailed || !dirty} className="w-full">
          {saved ? "✓ 저장됨" : "저장"}
        </Button>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-foreground">미리보기</CardTitle></CardHeader>
        <CardContent>
          <div
            className="overflow-hidden rounded-lg border border-border"
            style={{ backgroundColor: design.backgroundColor, color: design.textColor }}
          >
            <div
              className="relative flex h-56 flex-col items-center justify-center p-8 text-center"
              style={{
                background: design.coverImageUrl
                  ? `url(${design.coverImageUrl}) center/cover no-repeat`
                  : activeTemplate?.cssVars.heroGradient ?? `linear-gradient(135deg, ${design.accentColor}, #00C9A7)`,
              }}
            >
              {design.heroHeadline ? (
                <h2 className="text-3xl font-black tracking-[-0.04em] text-foreground drop-shadow-lg">
                  {design.heroHeadline}
                </h2>
              ) : null}
              {design.heroSubtext ? (
                <p className="mt-2 text-sm text-foreground/80 drop-shadow">
                  {design.heroSubtext}
                </p>
              ) : null}
            </div>

            <div className="space-y-6 p-8">
              {!design.heroHeadline ? (
                <>
                  <h2 className="text-3xl font-black tracking-[-0.04em]">이벤트 미리보기</h2>
                  <p className="text-sm opacity-80">템플릿과 색상을 선택하면 실시간으로 반영됩니다.</p>
                </>
              ) : null}

              {design.sectionDescriptions ? (
                <div className="space-y-3">
                  {Object.entries(design.sectionDescriptions).map(([key, description]) => (
                    <div
                      key={key}
                      className="rounded-lg border px-4 py-3"
                      style={{
                        borderColor: activeTemplate?.cssVars.cardBorder ?? "rgba(255,255,255,0.06)",
                        backgroundColor: activeTemplate?.cssVars.cardBackground ?? "rgba(22,26,48,0.95)",
                      }}
                    >
                      <p className="text-xs font-semibold uppercase tracking-[0.2em]" style={{ color: design.accentColor }}>
                        {key}
                      </p>
                      <p className="mt-1 text-sm opacity-80">{description}</p>
                    </div>
                  ))}
                </div>
              ) : null}

              {design.ctaText ? (
                <div className="flex justify-center pt-4">
                  <div
                    className="rounded-full px-8 py-3 text-sm font-bold text-foreground"
                    style={{ backgroundColor: design.accentColor }}
                  >
                    {design.ctaText}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-border bg-muted px-4 py-3">
      <Label>{label}</Label>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}
