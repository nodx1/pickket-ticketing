"use client";

import { useEffect, useState } from "react";
import { Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fetchWithAuth } from "@/lib/fetchWithAuth";
import { showError, showSuccess } from "@/lib/hooks/useToast";

interface LandingData {
  customDomain: string | null;
  landingConfig: Record<string, unknown>;
}

export function LandingEditor({ eventId }: { eventId: string }) {
  const [data, setData] = useState<LandingData | null>(null);
  const [domain, setDomain] = useState("");
  const [colorScheme, setColorScheme] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetchWithAuth<{ data: LandingData }>(`/api/events/${eventId}/landing`);
        setData(res.data ?? null);
        setDomain(res.data?.customDomain ?? "");
        setColorScheme((res.data?.landingConfig as { colorScheme?: string })?.colorScheme ?? "");
      } catch (err: unknown) {
        if (err instanceof Error) showError(err.message);
      }
    }
    void load();
  }, [eventId]);

  async function handleSave() {
    setSaving(true);
    try {
      await fetchWithAuth(`/api/events/${eventId}/landing`, {
        method: "PATCH",
        body: JSON.stringify({
          customDomain: domain || null,
          landingConfig: { ...(data?.landingConfig ?? {}), colorScheme: colorScheme || undefined },
        }),
      });
      showSuccess("랜딩 페이지 설정이 저장되었습니다");
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "저장 실패");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <Globe className="size-5" />
          랜딩 페이지 설정
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>커스텀 도메인</Label>
          <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="event.mycompany.com" />
          <p className="text-xs text-muted-foreground">CNAME을 설정한 후 도메인을 입력하세요</p>
        </div>
        <div className="space-y-2">
          <Label>컬러 스킴</Label>
          <Input value={colorScheme} onChange={(e) => setColorScheme(e.target.value)} placeholder="#6C5CE7" />
        </div>
        <Button onClick={() => void handleSave()} disabled={saving}>
          {saving ? "저장 중..." : "저장"}
        </Button>
      </CardContent>
    </Card>
  );
}
