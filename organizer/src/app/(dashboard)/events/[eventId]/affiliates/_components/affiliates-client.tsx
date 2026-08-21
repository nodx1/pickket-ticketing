"use client";

import { useEffect, useState } from "react";
import { useConfirmAction } from "@/lib/hooks/useConfirmAction";
import { Pencil, Share2, Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { DataTable } from "@/components/shared/data-table";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { showError, showSuccess } from "@/lib/hooks/useToast";
import { AFFILIATE_STATUS_LABELS } from "@/lib/constants";
import { fetchWithRefresh } from "@/lib/fetchWithAuth";

interface AffiliateRow extends Record<string, string | number | boolean | null> {
  id: string;
  name: string;
  code: string;
  commissionRate: number;
  conversionCount: number;
  commissionTotal: number;
  status: string;
}

export function AffiliatesClient({ eventId }: { eventId: string }) {
  const [items, setItems] = useState<AffiliateRow[]>([]);
  const [eventSlug, setEventSlug] = useState("");
  const [form, setForm] = useState({ name: "", code: "", commissionRate: "10" });
  const [editing, setEditing] = useState<AffiliateRow | null>(null);
  const [editForm, setEditForm] = useState({ name: "", commissionRate: "", status: "active" });
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  async function refresh() {
    setError(false);
    try {
      const [affiliateResponse, eventResponse] = await Promise.all([
        fetchWithRefresh(`/api/events/${eventId}/affiliates`, { credentials: "include" }),
        fetchWithRefresh(`/api/events/${eventId}`, { credentials: "include" }),
      ]);
      const affiliatePayload = (await affiliateResponse.json()) as { data?: AffiliateRow[] };
      const eventPayload = (await eventResponse.json()) as { data?: { slug?: string } };
      setItems(affiliatePayload.data ?? []);
      setEventSlug(eventPayload.data?.slug ?? "");
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  async function createAffiliate() {
    const response = await fetchWithRefresh(`/api/events/${eventId}/affiliates`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: form.name,
        code: form.code.toUpperCase(),
        commissionRate: Number(form.commissionRate),
      }),
    });
    if (response.ok) {
      setForm({ name: "", code: "", commissionRate: "10" });
      await refresh();
      showSuccess("어필리에이트가 추가되었습니다");
    } else {
      showError("어필리에이트 추가에 실패했습니다");
    }
  }

  function openEdit(row: AffiliateRow) {
    setEditing(row);
    setEditForm({
      name: row.name,
      commissionRate: String(row.commissionRate),
      status: row.status,
    });
  }

  async function saveEdit() {
    if (!editing) return;
    const response = await fetchWithRefresh(`/api/events/${eventId}/affiliates/${editing.id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: editForm.name,
        commissionRate: Number(editForm.commissionRate),
        status: editForm.status,
      }),
    });
    setEditing(null);
    if (!response.ok) {
      showError("어필리에이트 수정에 실패했습니다");
      return;
    }
    await refresh();
    showSuccess("어필리에이트가 수정되었습니다");
  }

  async function deleteAffiliate() {
    if (!deletingId) return;
    const response = await fetchWithRefresh(`/api/events/${eventId}/affiliates/${deletingId}`, {
      method: "DELETE",
      credentials: "include",
    });
    setDeletingId(null);
    if (!response.ok) {
      showError("어필리에이트 삭제에 실패했습니다");
      return;
    }
    await refresh();
    showSuccess("어필리에이트가 삭제되었습니다");
  }

  // 확인 버튼 잠금 + 재진입 차단 + 실패 시 해제 (S3). `deleteAffiliate` 이 창을 닫는다.
  const deleteAction = useConfirmAction(() => deleteAffiliate());

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-3xl font-black tracking-[-0.04em] text-foreground">어필리에이트</h2>
          <p className="mt-2 text-sm text-muted-foreground">추천 링크 실적과 수수료를 추적합니다.</p>
        </div>
      </div>

      <div className="grid gap-3 rounded-lg border border-border bg-card/95 p-5 lg:grid-cols-4">
        <Input placeholder="이름" value={form.name} onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))} />
        <Input placeholder="코드" value={form.code} onChange={(event) => setForm((prev) => ({ ...prev, code: event.target.value.toUpperCase() }))} />
        <Input placeholder="수수료율" value={form.commissionRate} onChange={(event) => setForm((prev) => ({ ...prev, commissionRate: event.target.value }))} />
        <Button onClick={() => void createAffiliate()}>추가</Button>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-14 animate-pulse rounded-lg border border-border bg-bg-muted" />
          ))}
        </div>
      ) : error ? (
        <ErrorState description="어필리에이트를 불러오지 못했습니다." onRetry={() => void refresh()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={Share2}
          title="어필리에이트가 없습니다"
          description="추천 파트너에게 코드를 발급해 유입과 전환을 추적해보세요. 위 입력란에서 바로 추가할 수 있습니다."
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">어필리에이트 목록</CardTitle>
          </CardHeader>
          <CardContent>
            <DataTable
              data={items}
              columns={[
                { key: "name", label: "이름" },
                { key: "code", label: "코드" },
                { key: "commissionRate", label: "수수료율", render: (row) => `${row.commissionRate}%` },
                { key: "conversionCount", label: "전환수" },
                { key: "commissionTotal", label: "수수료 합계", render: (row) => `${Number(row.commissionTotal).toLocaleString("ko-KR")}원` },
                { key: "status", label: "상태", render: (row) => AFFILIATE_STATUS_LABELS[String(row.status)] ?? row.status },
                {
                  key: "id",
                  label: "",
                  render: (row) => (
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          navigator.clipboard.writeText(`${window.location.origin}/e/${eventSlug || eventId}?ref=${row.code}`)
                            .then(() => showSuccess("링크가 복사되었습니다"))
                            .catch(() => showError("링크 복사에 실패했습니다"));
                        }}
                      >
                        링크 복사
                      </Button>
                      <Button variant="outline" size="icon" aria-label="어필리에이트 수정" onClick={() => openEdit(row)}>
                        <Pencil className="size-4" />
                      </Button>
                      <Button variant="outline" size="icon" aria-label="어필리에이트 삭제" onClick={() => setDeletingId(row.id)}>
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  ),
                },
              ]}
            />
          </CardContent>
        </Card>
      )}

      <Dialog open={editing !== null} onOpenChange={() => setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>어필리에이트 수정</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="edit-affiliate-name">이름</Label>
              <Input id="edit-affiliate-name" value={editForm.name} onChange={(event) => setEditForm((prev) => ({ ...prev, name: event.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-affiliate-commission">수수료율 (%)</Label>
              <Input id="edit-affiliate-commission" type="number" min="0" max="100" value={editForm.commissionRate} onChange={(event) => setEditForm((prev) => ({ ...prev, commissionRate: event.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label>상태</Label>
              <Select value={editForm.status} onValueChange={(value) => setEditForm((prev) => ({ ...prev, status: value }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">활성</SelectItem>
                  <SelectItem value="inactive">비활성</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>취소</Button>
            <Button onClick={() => void saveEdit()}>저장</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deletingId !== null}
        title="어필리에이트 삭제"
        description="이 어필리에이트를 삭제하시겠습니까? 기존 전환 기록도 함께 삭제됩니다."
        confirmText="삭제"
        pending={deleteAction.pending}
        onConfirm={deleteAction.run}
        onOpenChange={() => setDeletingId(null)}
      />
    </div>
  );
}
