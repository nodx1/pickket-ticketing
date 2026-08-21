"use client";

import { useCallback, useEffect, useState } from "react";
import { Gauge } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/shared/empty-state";
import { fetchWithAuth } from "@/lib/fetchWithAuth";
import { showError, showSuccess } from "@/lib/hooks/useToast";

interface CapacityRow {
  id: string;
  productId: string;
  productName: string;
  capacity: number;
  usedCapacity: number;
}

export function EventCapacityClient({ eventId }: { eventId: string }) {
  const [items, setItems] = useState<CapacityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editTarget, setEditTarget] = useState<CapacityRow | null>(null);
  const [capacityInput, setCapacityInput] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchWithAuth<{ data: CapacityRow[] }>(`/api/events/${eventId}/capacity`);
      setItems(res.data ?? []);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "용량 정보를 불러오지 못했습니다");
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    void load();
  }, [load]);

  function openEdit(row: CapacityRow) {
    setEditTarget(row);
    setCapacityInput(String(row.capacity));
  }

  async function saveCapacity() {
    if (!editTarget) return;
    const capacity = Number(capacityInput);
    if (!Number.isInteger(capacity) || capacity <= 0) {
      showError("용량은 1 이상의 정수여야 합니다");
      return;
    }
    setSaving(true);
    try {
      await fetchWithAuth(`/api/events/${eventId}/capacity`, {
        method: "POST",
        body: JSON.stringify({ productId: editTarget.productId, capacity }),
      });
      showSuccess("용량을 저장했습니다");
      setEditTarget(null);
      await load();
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "용량 저장에 실패했습니다");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-content-muted">고급 설정</p>
        <h2 className="mt-2 text-3xl font-black tracking-[-0.04em] text-foreground">용량 관리</h2>
        <p className="mt-2 text-sm text-content-subtle">상품별 판매 용량을 설정합니다. 사용량은 v2 판매 수량(환불 제외)에서 자동 반영됩니다.</p>
      </div>

      {loading ? (
        <div className="grid gap-4 md:grid-cols-2">
          {[0, 1].map((i) => (
            <div key={i} className="h-[132px] animate-pulse rounded-lg border border-border-subtle bg-bg-muted" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={Gauge}
          title="용량이 설정된 상품이 없습니다"
          description="상품(티켓)을 등록하면 이곳에서 상품별 판매 용량을 관리할 수 있습니다."
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {items.map((item) => {
            const percent = item.capacity > 0 ? Math.min((item.usedCapacity / item.capacity) * 100, 100) : 0;
            return (
              <Card key={item.id}>
                <CardHeader className="flex-row items-center justify-between gap-2">
                  <CardTitle className="text-foreground">{item.productName}</CardTitle>
                  <Button variant="outline" size="sm" onClick={() => openEdit(item)}>수정</Button>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-sm text-content-subtle">
                    사용 {item.usedCapacity} / {item.capacity} ({Math.round(percent)}%)
                  </p>
                  <div className="h-3 overflow-hidden rounded-full bg-bg-muted">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={editTarget !== null} onOpenChange={(o) => { if (!o) setEditTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>용량 수정 — {editTarget?.productName}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="capacity-input">판매 용량</Label>
            <Input
              id="capacity-input"
              type="number"
              min={1}
              inputMode="numeric"
              value={capacityInput}
              onChange={(e) => setCapacityInput(e.target.value)}
            />
            <p className="text-xs text-content-muted">
              현재 사용량 {editTarget?.usedCapacity ?? 0}건. 사용량보다 작게 설정하면 신규 판매가 중단됩니다.
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditTarget(null)} disabled={saving}>취소</Button>
            <Button onClick={() => void saveCapacity()} disabled={saving}>{saving ? "저장 중..." : "저장"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
