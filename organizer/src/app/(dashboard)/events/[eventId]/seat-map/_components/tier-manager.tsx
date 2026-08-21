"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { showError, showSuccess } from "@/lib/hooks/useToast";
import { fetchWithAuth } from "@/lib/fetchWithAuth";
import {
  buildTierPatch,
  buildTierPayload,
  isUnsellableCapacity,
} from "@/lib/seats/tier-form";
import type { SeatTier } from "@/lib/seats/types";

interface TierManagerProps {
  eventId: string;
  onTiersChange?: (tiers: SeatTier[]) => void;
}

interface TierListResponse {
  success?: boolean;
  data?: SeatTier[];
}

interface EditDraft {
  name: string;
  price: string;
  capacity: string;
}

export function TierManager({ eventId, onTiersChange }: TierManagerProps) {
  const [tiers, setTiers] = useState<SeatTier[]>([]);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [capacity, setCapacity] = useState("");
  const [color, setColor] = useState("#6c5ce7");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<EditDraft>({ name: "", price: "", capacity: "" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetchWithAuth<TierListResponse>(`/api/events/${eventId}/seat-tiers`);
      const list = res.data ?? [];
      setTiers(list);
      onTiersChange?.(list);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "등급 조회 실패");
    }
  }, [eventId, onTiersChange]);

  useEffect(() => {
    // 외부 시스템(API) 동기화 — 마운트/eventId 변경 시 1회 조회
    void load();
  }, [load]);

  async function add() {
    const built = buildTierPayload({ name, price, capacity, colorHex: color });
    if (!built.ok) {
      showError(built.error);
      return;
    }
    setBusy(true);
    try {
      await fetchWithAuth(`/api/events/${eventId}/seat-tiers`, {
        method: "POST",
        body: JSON.stringify(built.payload),
      });
      setName("");
      setPrice("");
      setCapacity("");
      showSuccess("등급이 추가되었습니다");
      void load();
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "등급 추가 실패");
    } finally {
      setBusy(false);
    }
  }

  function startEdit(t: SeatTier) {
    setEditingId(t.id);
    setDraft({ name: t.name, price: String(t.basePrice), capacity: String(t.capacity) });
  }

  function cancelEdit() {
    setEditingId(null);
  }

  async function saveEdit(t: SeatTier) {
    const built = buildTierPatch(
      { name: t.name, basePrice: t.basePrice, capacity: t.capacity },
      draft,
    );
    if (!built.ok) {
      showError(built.error);
      return;
    }
    // 변경분이 없으면 요청을 보내지 않는다 — 불필요한 write 가 tier 카탈로그를 건드리지 않게.
    if (Object.keys(built.patch).length === 0) {
      setEditingId(null);
      return;
    }
    setBusy(true);
    try {
      await fetchWithAuth(`/api/events/${eventId}/seat-tiers/${t.id}`, {
        method: "PATCH",
        body: JSON.stringify(built.patch),
      });
      setEditingId(null);
      showSuccess("등급이 수정되었습니다");
      void load();
    } catch (err: unknown) {
      // 판매분 이하로 수량을 줄이면 서버가 409 로 막는다 — 사유를 그대로 보여준다.
      showError(err instanceof Error ? err.message : "등급 수정 실패");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    try {
      await fetchWithAuth(`/api/events/${eventId}/seat-tiers/${id}`, { method: "DELETE" });
      showSuccess("삭제됨");
      void load();
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "삭제 실패");
    }
  }

  return (
    <div className="space-y-4 rounded-lg border border-border bg-card p-4">
      <h3 className="font-bold">좌석 등급</h3>
      <div className="space-y-2">
        {tiers.length === 0 ? (
          <p className="text-xs text-muted-foreground">등록된 등급이 없습니다.</p>
        ) : (
          tiers.map((t) =>
            editingId === t.id ? (
              <div key={t.id} className="space-y-2 rounded border border-primary p-2">
                <Input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="등급 이름"
                  aria-label="등급 이름"
                />
                <div className="flex gap-2">
                  <Input
                    type="number"
                    value={draft.price}
                    onChange={(e) => setDraft({ ...draft, price: e.target.value })}
                    placeholder="가격 (원)"
                    aria-label="가격 (원)"
                  />
                  <Input
                    type="number"
                    value={draft.capacity}
                    onChange={(e) => setDraft({ ...draft, capacity: e.target.value })}
                    placeholder="수량 (장)"
                    aria-label="수량 (장)"
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    className="flex-1"
                    disabled={busy}
                    onClick={() => void saveEdit(t)}
                  >
                    <Check className="mr-1 size-4" />
                    저장
                  </Button>
                  <Button size="sm" variant="outline" onClick={cancelEdit} disabled={busy}>
                    <X className="mr-1 size-4" />
                    취소
                  </Button>
                </div>
              </div>
            ) : (
              <div key={t.id} className="space-y-1 rounded border border-border p-2">
                <div className="flex items-center gap-2">
                  <span
                    className="size-4 rounded"
                    style={{ backgroundColor: t.colorHex ?? "#9ca3af" }}
                  />
                  <span className="flex-1 text-sm font-medium">{t.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {t.basePrice.toLocaleString()}원 · {t.capacity.toLocaleString()}장
                  </span>
                  <button
                    type="button"
                    onClick={() => startEdit(t)}
                    className="text-content-subtle hover:opacity-80"
                    aria-label="등급 수정"
                  >
                    <Pencil className="size-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(t.id)}
                    className="text-error hover:opacity-80"
                    aria-label="등급 삭제"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
                {isUnsellableCapacity(t.capacity) && (
                  <p className="flex items-center gap-1 text-xs text-warning">
                    <AlertTriangle className="size-3 shrink-0" />
                    수량이 0장이라 판매되지 않습니다. 수량을 입력하거나 배치도에서 좌석을 그려주세요.
                  </p>
                )}
              </div>
            ),
          )
        )}
      </div>
      <div className="space-y-2 border-t border-border pt-3">
        <Label className="text-xs">새 등급 추가</Label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="VIP, R, S, A"
          aria-label="등급 이름"
        />
        <Input
          type="number"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          placeholder="가격 (원)"
          aria-label="가격 (원)"
        />
        <Input
          type="number"
          value={capacity}
          onChange={(e) => setCapacity(e.target.value)}
          placeholder="수량 (장) — 배치도로 채우려면 비워두세요"
          aria-label="수량 (장)"
        />
        <Input
          type="color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          className="h-10"
          aria-label="등급 색상"
        />
        <Button onClick={() => void add()} className="w-full" size="sm" disabled={busy}>
          <Plus className="mr-1 size-4" />
          추가
        </Button>
      </div>
    </div>
  );
}
