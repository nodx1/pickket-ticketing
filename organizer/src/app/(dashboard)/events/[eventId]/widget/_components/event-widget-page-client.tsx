"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { showError, showSuccess } from "@/lib/hooks/useToast";
import { fetchWithRefresh } from "@/lib/fetchWithAuth";

interface WidgetConfig {
  mode: string;
  theme: {
    primaryColor: string;
    buttonText: string;
    borderRadius: number;
    fontFamily: string;
  };
  allowedDomains: string[];
  isActive: boolean;
}

const DEFAULT_CONFIG: WidgetConfig = {
  mode: "button",
  theme: {
    primaryColor: "#6C5CE7",
    buttonText: "티켓 구매",
    borderRadius: 100,
    fontFamily: "",
  },
  allowedDomains: [],
  isActive: true,
};

export function EventWidgetPageClient({ eventId }: { eventId: string }) {
  const [config, setConfig] = useState<WidgetConfig>(DEFAULT_CONFIG);
  const [slug, setSlug] = useState("");
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [domainsText, setDomainsText] = useState("");
  const previewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let isMounted = true;
    async function load() {
      try {
        const [configRes, eventRes] = await Promise.all([
          fetchWithRefresh(`/api/events/${eventId}/widget-config`, { credentials: "include" }),
          fetchWithRefresh(`/api/events/${eventId}`, { credentials: "include" }),
        ]);
        const configPayload = (await configRes.json()) as { data?: WidgetConfig };
        const eventPayload = (await eventRes.json()) as { data?: { slug: string } };
        if (isMounted) {
          if (configPayload.data) {
            setConfig({
              ...DEFAULT_CONFIG,
              ...configPayload.data,
              theme: { ...DEFAULT_CONFIG.theme, ...configPayload.data.theme },
            });
            setDomainsText((configPayload.data.allowedDomains ?? []).join("\n"));
          }
          if (eventPayload.data?.slug) {
            setSlug(eventPayload.data.slug);
          }
        }
      } catch (err: unknown) {
        if (isMounted) {
          showError(err instanceof Error ? err.message : "위젯 설정을 불러오지 못했습니다");
        }
      }
    }
    void load();
    return () => { isMounted = false; };
  }, [eventId]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const domains = domainsText
        .split("\n")
        .map((d) => d.trim())
        .filter(Boolean);
      const payload = {
        ...config,
        allowedDomains: domains,
        theme: config.theme,
      };
      const res = await fetchWithRefresh(`/api/events/${eventId}/widget-config`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        let message = "위젯 설정 저장에 실패했습니다";
        try {
          const errPayload = (await res.json()) as { error?: string };
          if (errPayload.error) message = errPayload.error;
        } catch {
          // 응답 파싱 실패는 기본 메시지 유지.
        }
        showError(message);
        return;
      }
      showSuccess("위젯 설정을 저장했습니다");
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "저장 중 오류가 발생했습니다");
    } finally {
      setSaving(false);
    }
  }, [eventId, config, domainsText]);

  const origin = typeof window !== "undefined" ? window.location.origin : "https://go.pickket.kr";
  const embedCode = `<!-- PICKKET 티켓 위젯 -->
<script src="${origin}/widget/pickket.js"></script>
<pickket-ticket
  event-slug="${slug}"
  theme-color="${config.theme.primaryColor}"
  button-text="${config.theme.buttonText}"
></pickket-ticket>`;

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(embedCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [embedCode]);

  // 라이브 미리보기 업데이트
  useEffect(() => {
    if (!previewRef.current) return;
    const el = previewRef.current;
    el.innerHTML = "";
    const btn = document.createElement("button");
    Object.assign(btn.style, {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      gap: "8px",
      padding: "12px 28px",
      border: "none",
      borderRadius: `${config.theme.borderRadius}px`,
      background: `linear-gradient(135deg, ${config.theme.primaryColor}, ${config.theme.primaryColor}dd)`,
      color: "#fff",
      fontFamily: config.theme.fontFamily || "system-ui, -apple-system, sans-serif",
      fontSize: "15px",
      fontWeight: "600",
      cursor: "pointer",
      boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
      whiteSpace: "nowrap",
    });
    // XSS 방지: buttonText 는 사용자 입력값이므로 HTML 이스케이프 후 textNode 로 추가 (#27 수정).
    const svgEl = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svgEl.setAttribute("width", "18");
    svgEl.setAttribute("height", "18");
    svgEl.setAttribute("viewBox", "0 0 24 24");
    svgEl.setAttribute("fill", "currentColor");
    svgEl.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const pathEl = document.createElementNS("http://www.w3.org/2000/svg", "path");
    pathEl.setAttribute("d", "M22 10V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v4a2 2 0 0 1 0 4v4a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-4a2 2 0 0 1 0-4ZM13 17h-2v-2h2v2Zm0-4h-2v-2h2v2Zm0-4h-2V7h2v2Z");
    svgEl.appendChild(pathEl);
    btn.appendChild(svgEl);
    btn.appendChild(document.createTextNode(` ${config.theme.buttonText}`));
    el.appendChild(btn);
  }, [config.theme]);

  return (
    <div className="space-y-6">
      <h2 className="text-3xl font-black tracking-[-0.04em] text-foreground">위젯 설정</h2>
      <p className="text-muted-foreground">외부 웹사이트에 티켓 구매 버튼을 삽입할 수 있습니다.</p>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* 설정 패널 */}
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-foreground">디자인 설정</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="theme-color">테마 색상</Label>
                <div className="flex items-center gap-3">
                  <input
                    id="theme-color"
                    type="color"
                    value={config.theme.primaryColor}
                    onChange={(e) =>
                      setConfig((prev) => ({
                        ...prev,
                        theme: { ...prev.theme, primaryColor: e.target.value },
                      }))
                    }
                    className="h-10 w-14 cursor-pointer rounded-lg border border-border"
                  />
                  <Input
                    value={config.theme.primaryColor}
                    onChange={(e) =>
                      setConfig((prev) => ({
                        ...prev,
                        theme: { ...prev.theme, primaryColor: e.target.value },
                      }))
                    }
                    className="w-32 font-mono"
                    placeholder="#6C5CE7"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="button-text">버튼 텍스트</Label>
                <Input
                  id="button-text"
                  value={config.theme.buttonText}
                  onChange={(e) =>
                    setConfig((prev) => ({
                      ...prev,
                      theme: { ...prev.theme, buttonText: e.target.value },
                    }))
                  }
                  placeholder="티켓 구매"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="allowed-domains">허용 도메인 (줄바꿈 구분)</Label>
                <textarea
                  id="allowed-domains"
                  value={domainsText}
                  onChange={(e) => setDomainsText(e.target.value)}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground"
                  rows={3}
                  placeholder={"example.com\nmysite.kr"}
                />
                <p className="text-xs text-muted-foreground">비워두면 모든 도메인에서 사용 가능합니다.</p>
              </div>

              <Button onClick={handleSave} disabled={saving} className="w-full">
                {saving ? "저장 중..." : "설정 저장"}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-foreground">임베드 코드</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <pre className="overflow-x-auto rounded-lg border border-border bg-muted p-4 text-xs text-muted-foreground leading-relaxed">{embedCode}</pre>
              <Button onClick={handleCopy} variant={copied ? "outline" : "default"} className="w-full">
                {copied ? "복사됨!" : "코드 복사"}
              </Button>
            </CardContent>
          </Card>
        </div>

        {/* 미리보기 패널 */}
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-foreground">실시간 미리보기</CardTitle></CardHeader>
            <CardContent>
              <div className="flex items-center justify-center rounded-lg border border-dashed border-border bg-muted/50 p-12">
                <div ref={previewRef} />
              </div>
              <p className="mt-3 text-center text-xs text-muted-foreground">
                실제 외부 사이트에서 보이는 버튼 미리보기입니다.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-foreground">사용 방법</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>1. 위의 임베드 코드를 복사합니다.</p>
              <p>2. 외부 웹사이트의 HTML에 붙여넣습니다.</p>
              <p>3. 버튼 클릭 시 티켓 구매 창이 오버레이로 열립니다.</p>
              <p className="rounded-lg border border-border bg-muted p-3 text-xs font-mono">
                {`// 주문 완료 이벤트 수신\ndocument.querySelector('pickket-ticket')\n  .addEventListener('pickket:order-complete', (e) => {\n    console.log('주문 완료:', e.detail);\n  });`}
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
