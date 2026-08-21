"use client";

import { useEffect, useState } from "react";
import { DollarSign, Plus, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fetchWithAuth } from "@/lib/fetchWithAuth";
import { showError, showSuccess } from "@/lib/hooks/useToast";
import { formatKRW } from "@/lib/format";

interface PricingRule {
  id: string;
  ruleType: string;
  config: Record<string, unknown>;
  priority: number;
  isActive: boolean;
  createdAt: string;
}

interface PriceHistoryItem {
  id: string;
  oldPrice: number;
  newPrice: number;
  reason: string | null;
  appliedAt: string;
  ruleType: string | null;
}

const RULE_LABELS: Record<string, string> = {
  demand: "수요 기반",
  time: "시간 기반",
  inventory: "재고 기반",
  surge: "서지 가격",
};

export function PricingRules({ eventId, productId }: { eventId: string; productId: string }) {
  const [rules, setRules] = useState<PricingRule[]>([]);
  const [history, setHistory] = useState<PriceHistoryItem[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [form, setForm] = useState({ ruleType: "demand", thresholdScore: "70", increasePct: "10", maxPrice: "" });

  async function loadRules() {
    try {
      const res = await fetchWithAuth<{ data: PricingRule[] }>(`/api/events/${eventId}/products/${productId}/pricing-rules`);
      setRules(res.data ?? []);
    } catch (err: unknown) {
      if (err instanceof Error) showError(err.message);
    }
  }

  async function loadHistory() {
    try {
      const res = await fetchWithAuth<{ data: PriceHistoryItem[] }>(`/api/events/${eventId}/products/${productId}/price-history`);
      setHistory(res.data ?? []);
    } catch (err: unknown) {
      if (err instanceof Error) showError(err.message);
    }
  }

  useEffect(() => {
    fetchWithAuth<{ data: PricingRule[] }>(`/api/events/${eventId}/products/${productId}/pricing-rules`)
      .then((res) => setRules(res.data ?? []))
      .catch((err: unknown) => { if (err instanceof Error) showError(err.message); });
  }, [eventId, productId]);

  async function handleCreate() {
    try {
      await fetchWithAuth(`/api/events/${eventId}/products/${productId}/pricing-rules`, {
        method: "POST",
        body: JSON.stringify({
          ruleType: form.ruleType,
          config: {
            threshold_score: Number(form.thresholdScore),
            increase_pct: Number(form.increasePct),
            max_price: form.maxPrice ? Number(form.maxPrice) : undefined,
          },
        }),
      });
      showSuccess("가격 규칙이 생성되었습니다");
      setShowCreate(false);
      await loadRules();
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "생성 실패");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="flex items-center gap-2 font-bold text-foreground">
          <DollarSign className="size-4" />
          동적 가격 규칙
        </h4>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => { setShowHistory(!showHistory); if (!showHistory) void loadHistory(); }}>
            <History className="size-4" />
            이력
          </Button>
          <Button size="sm" onClick={() => setShowCreate(!showCreate)}>
            <Plus className="size-4" />
            규칙 추가
          </Button>
        </div>
      </div>

      {showCreate && (
        <Card>
          <CardContent className="space-y-3 pt-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>규칙 유형</Label>
                <Select value={form.ruleType} onValueChange={(v) => setForm((p) => ({ ...p, ruleType: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(RULE_LABELS).map(([k, v]) => (
                      <SelectItem key={k} value={k}>{v}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>수요 점수 임계값</Label>
                <Input type="number" value={form.thresholdScore} onChange={(e) => setForm((p) => ({ ...p, thresholdScore: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>인상률 (%)</Label>
                <Input type="number" value={form.increasePct} onChange={(e) => setForm((p) => ({ ...p, increasePct: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>최대 가격 (원)</Label>
                <Input type="number" value={form.maxPrice} onChange={(e) => setForm((p) => ({ ...p, maxPrice: e.target.value }))} placeholder="제한 없음" />
              </div>
            </div>
            <Button size="sm" onClick={() => void handleCreate()}>저장</Button>
          </CardContent>
        </Card>
      )}

      {rules.length > 0 && (
        <div className="space-y-2">
          {rules.map((rule) => (
            <Card key={rule.id}>
              <CardContent className="flex items-center justify-between p-3">
                <div className="flex items-center gap-2">
                  <Badge variant={rule.isActive ? "default" : "outline"}>
                    {RULE_LABELS[rule.ruleType] ?? rule.ruleType}
                  </Badge>
                  <span className="text-sm text-muted-foreground">
                    임계값 {(rule.config as { threshold_score?: number }).threshold_score ?? "-"}점 →
                    {(rule.config as { increase_pct?: number }).increase_pct ?? "-"}% 인상
                  </span>
                </div>
                <span className="text-xs text-muted-foreground">우선순위 {rule.priority}</span>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {showHistory && history.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-sm text-foreground">가격 변경 이력</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {history.map((item) => (
              <div key={item.id} className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  {formatKRW(item.oldPrice)} → {formatKRW(item.newPrice)}
                </span>
                <span className="text-xs text-muted-foreground">{item.reason ?? item.ruleType}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
