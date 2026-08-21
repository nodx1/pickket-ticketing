"use client";

import { useCallback, useEffect, useState } from "react";
import { useConfirmAction } from "@/lib/hooks/useConfirmAction";
import { useParams } from "next/navigation";
import { Building, Pencil, Plus, Trash2, X } from "lucide-react";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { Button } from "@/components/ui/button";
import { fetchWithAuth } from "@/lib/fetchWithAuth";
import { useToast } from "@/lib/hooks/useToast";

interface Facility {
  id: string;
  name: string;
  category: string;
  quantity: number;
  status: string;
  vendor: string | null;
  cost: number;
  notes: string | null;
}

const CAT_LABELS: Record<string, string> = {
  stage: "무대",
  sound: "음향",
  lighting: "조명",
  booth: "부스",
  seating: "좌석",
  general: "일반",
};

const STATUS_LABELS: Record<string, string> = {
  planned: "계획",
  confirmed: "확정",
  setup: "설치중",
  active: "운용중",
  returned: "반납",
};

const STATUS_COLORS: Record<string, string> = {
  planned: "bg-muted text-content-subtle",
  confirmed: "bg-primary/10 text-primary",
  setup: "bg-warning/10 text-warning",
  active: "bg-success/10 text-success",
  returned: "bg-muted text-content-subtle",
};

export default function FacilitiesPage() {
  const { eventId } = useParams<{ eventId: string }>();
  const [items, setItems] = useState<Facility[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("general");
  const [editId, setEditId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<Facility>>({});
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const { addToast } = useToast();

  const load = useCallback(async () => {
    try {
      const res = await fetchWithAuth<{ success: boolean; data: Facility[] }>(
        `/api/events/${eventId}/facilities`,
      );
      if (res.success) setItems(res.data);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    load();
  }, [load]);

  const add = async () => {
    if (!name.trim()) return;
    try {
      const res = await fetchWithAuth<{ success: boolean; data: Facility }>(
        `/api/events/${eventId}/facilities`,
        { method: "POST", body: JSON.stringify({ name, category }) },
      );
      if (res.success) {
        setItems((p) => [...p, res.data]);
        setName("");
        addToast({ message: "시설이 추가되었습니다.", variant: "success" });
      }
    } catch {
      addToast({ message: "추가에 실패했습니다.", variant: "error" });
    }
  };

  const update = async (id: string) => {
    try {
      const res = await fetchWithAuth<{ success: boolean; data: Facility }>(
        `/api/events/${eventId}/facilities/${id}`,
        { method: "PATCH", body: JSON.stringify(editForm) },
      );
      if (res.success) {
        setItems((p) => p.map((f) => (f.id === id ? res.data : f)));
        setEditId(null);
        setEditForm({});
        addToast({ message: "수정되었습니다.", variant: "success" });
      }
    } catch {
      addToast({ message: "수정에 실패했습니다.", variant: "error" });
    }
  };

  const remove = async (id: string) => {
    try {
      const res = await fetchWithAuth<{ success: boolean }>(
        `/api/events/${eventId}/facilities/${id}`,
        { method: "DELETE" },
      );
      if (res.success) {
        setItems((p) => p.filter((f) => f.id !== id));
        addToast({ message: "삭제되었습니다.", variant: "success" });
      }
    } catch {
      addToast({ message: "삭제에 실패했습니다.", variant: "error" });
    }
  };

  const startEdit = (f: Facility) => {
    setEditId(f.id);
    setEditForm({ name: f.name, category: f.category, quantity: f.quantity, status: f.status, vendor: f.vendor ?? "", cost: f.cost, notes: f.notes ?? "" });
  };

  const totalCost = items.reduce((s, f) => s + Number(f.cost), 0);

  // 확인 버튼 잠금 + 재진입 차단 + 실패 시 해제 (S3).
  // 종전엔 `void fn(); setTarget(null)` 라 **요청이 끝나기 전에 창이 닫혔다** —
  // 그 상태로 pending 을 넘겨봐야 보이지도 않는다. 끝난 뒤 닫도록 바꿨다.
  const removeAction = useConfirmAction(async () => {
    if (!deletingId) return;
    await remove(deletingId);
    setDeletingId(null);
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-content-subtle">시설 관리</p>
          <h2 className="mt-2 text-3xl font-black tracking-[-0.04em] text-foreground">시설 관리</h2>
        </div>
        {totalCost > 0 ? (
          <p className="text-sm text-content-subtle">
            총 비용: <span className="font-bold text-foreground">₩{totalCost.toLocaleString()}</span>
          </p>
        ) : null}
      </div>

      {/* 추가 폼 */}
      <div className="flex gap-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="시설/장비명"
          className="flex-1 rounded-lg border border-border bg-card px-4 py-2.5 text-sm"
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)} aria-label="분류"
          className="rounded-lg border border-border bg-card px-3 py-2.5 text-sm"
        >
          {Object.entries(CAT_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <Button onClick={add}>
          <Plus className="size-4" /> 추가
        </Button>
      </div>

      {/* 목록 */}
      {loading ? (
        <div className="animate-pulse rounded-lg border bg-card p-6">
          <div className="h-5 w-48 rounded bg-bg-muted" />
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-12 text-center">
          <Building className="mx-auto size-12 text-primary" />
          <h3 className="mt-4 text-lg font-bold">등록된 시설이 없습니다</h3>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border text-left text-xs text-content-muted">
                <th className="px-4 py-3">시설명</th>
                <th className="px-4 py-3">분류</th>
                <th className="px-4 py-3">수량</th>
                <th className="px-4 py-3">상태</th>
                <th className="px-4 py-3 text-right">비용</th>
                <th className="px-4 py-3 text-right">관리</th>
              </tr>
            </thead>
            <tbody>
              {items.map((f) =>
                editId === f.id ? (
                  <tr key={f.id} className="border-b border-border bg-muted/30 last:border-0">
                    <td className="px-4 py-2">
                      <input
                        value={editForm.name ?? ""}
                        onChange={(e) => setEditForm((p) => ({ ...p, name: e.target.value }))}
                        className="w-full rounded border border-border px-2 py-1 text-sm"
                      />
                    </td>
                    <td className="px-4 py-2">
                      <select
                        value={editForm.category ?? "general"}
                        onChange={(e) => setEditForm((p) => ({ ...p, category: e.target.value }))}
                        className="rounded border border-border px-2 py-1 text-sm"
                      >
                        {Object.entries(CAT_LABELS).map(([k, v]) => (
                          <option key={k} value={k}>{v}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-2">
                      <input
                        type="number"
                        min="1"
                        value={editForm.quantity ?? 1}
                        onChange={(e) => setEditForm((p) => ({ ...p, quantity: Number(e.target.value) }))}
                        className="w-16 rounded border border-border px-2 py-1 text-sm"
                      />
                    </td>
                    <td className="px-4 py-2">
                      <select
                        value={editForm.status ?? "planned"}
                        onChange={(e) => setEditForm((p) => ({ ...p, status: e.target.value }))}
                        className="rounded border border-border px-2 py-1 text-sm"
                      >
                        {Object.entries(STATUS_LABELS).map(([k, v]) => (
                          <option key={k} value={k}>{v}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-2">
                      <input
                        type="number"
                        min="0"
                        value={editForm.cost ?? 0}
                        onChange={(e) => setEditForm((p) => ({ ...p, cost: Number(e.target.value) }))}
                        className="w-24 rounded border border-border px-2 py-1 text-right text-sm"
                      />
                    </td>
                    <td className="px-4 py-2" colSpan={1}>
                      <div className="flex flex-col gap-1">
                        <input
                          value={editForm.vendor ?? ""}
                          onChange={(e) => setEditForm((p) => ({ ...p, vendor: e.target.value }))}
                          placeholder="업체명"
                          className="w-full rounded border border-border px-2 py-1 text-sm"
                        />
                        <input
                          value={editForm.notes ?? ""}
                          onChange={(e) => setEditForm((p) => ({ ...p, notes: e.target.value }))}
                          placeholder="비고"
                          className="w-full rounded border border-border px-2 py-1 text-sm"
                        />
                        <div className="mt-1 flex justify-end gap-1">
                          <Button size="sm" onClick={() => update(f.id)}>저장</Button>
                          <Button size="sm" variant="outline" aria-label="편집 취소" onClick={() => { setEditId(null); setEditForm({}); }}>
                            <X className="size-3" />
                          </Button>
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : (
                  <tr key={f.id} className="border-b border-border last:border-0 hover:bg-muted/20">
                    <td className="px-4 py-3 text-sm font-medium">{f.name}</td>
                    <td className="px-4 py-3 text-sm text-content-subtle">{CAT_LABELS[f.category] ?? f.category}</td>
                    <td className="px-4 py-3 text-sm">{f.quantity}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_COLORS[f.status] ?? "bg-muted"}`}>
                        {STATUS_LABELS[f.status] ?? f.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-sm">{Number(f.cost) > 0 ? `₩${Number(f.cost).toLocaleString()}` : "-"}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-1">
                        <button onClick={() => startEdit(f)} className="rounded p-1.5 text-content-subtle hover:bg-muted hover:text-foreground">
                          <Pencil className="size-3.5" />
                        </button>
                        <button onClick={() => setDeletingId(f.id)} className="rounded p-1.5 text-content-subtle hover:bg-error/10 hover:text-error">
                          <Trash2 className="size-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(deletingId)}
        title="시설을 삭제할까요?"
        description="이 시설 정보가 삭제됩니다."
        confirmText="삭제하기"
        pending={removeAction.pending}
        onConfirm={removeAction.run}
        onOpenChange={(open) => {
          if (!open) setDeletingId(null);
        }}
      />
    </div>
  );
}
