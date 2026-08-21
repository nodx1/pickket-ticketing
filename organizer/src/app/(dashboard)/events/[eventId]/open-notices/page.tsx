"use client";

import { useCallback, useEffect, useState } from "react";
import { useConfirmAction } from "@/lib/hooks/useConfirmAction";
import { useParams } from "next/navigation";
import { Megaphone, Pencil, Plus, Trash2, X } from "lucide-react";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { fetchWithAuth } from "@/lib/fetchWithAuth";
import { useToast } from "@/lib/hooks/useToast";
import { useUnsavedChanges } from "@/lib/hooks/useUnsavedChanges";
import { Button } from "@/components/ui/button";
import { formatDateTimeSecKst } from "@/lib/format";

interface Notice { id: string; type: string; title: string; content: string; isPublished: boolean; publishedAt: string | null; createdAt: string; }
const TYPE_LABELS: Record<string, string> = { cancellation: "취소", refund: "환불", schedule_change: "일정변경", general: "일반" };

export default function OpenNoticesPage() {
  const { eventId } = useParams<{ eventId: string }>();
  const [notices, setNotices] = useState<Notice[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ type: "general", title: "", content: "", isPublished: false });
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ type: "general", title: "", content: "", isPublished: false });
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const { addToast } = useToast();

  // B8: 작성 폼 또는 수정 폼 입력 중 dirty
  const newFormDirty = showForm && (form.title.trim().length > 0 || form.content.trim().length > 0);
  const editFormDirty = editingId !== null && (editForm.title.trim().length > 0 || editForm.content.trim().length > 0);
  useUnsavedChanges(newFormDirty || editFormDirty);

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetchWithAuth<{ success: boolean; data: Notice[] }>(`/api/events/${eventId}/open-notices`);
      if (res.success) setNotices(res.data);
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [eventId]);

  useEffect(() => { fetch_(); }, [fetch_]);

  const submit = async () => {
    if (!form.title.trim() || !form.content.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetchWithAuth<{ success: boolean; data: Notice }>(`/api/events/${eventId}/open-notices`, {
        method: "POST", body: JSON.stringify(form),
      });
      if (res.success) {
        setNotices((p) => [res.data, ...p]);
        setForm({ type: "general", title: "", content: "", isPublished: false });
        setShowForm(false);
        addToast({ message: "공지가 등록되었습니다.", variant: "success" });
      }
    } catch { addToast({ message: "등록에 실패했습니다.", variant: "error" }); }
    finally { setSubmitting(false); }
  };

  const startEdit = (n: Notice) => {
    setEditingId(n.id);
    setEditForm({ type: n.type, title: n.title, content: n.content, isPublished: n.isPublished });
  };

  const saveEdit = async () => {
    if (!editingId) return;
    try {
      const res = await fetchWithAuth<{ success: boolean; data: Notice }>(`/api/events/${eventId}/open-notices/${editingId}`, {
        method: "PATCH", body: JSON.stringify(editForm),
      });
      if (res.success) {
        setNotices((p) => p.map((n) => n.id === editingId ? res.data : n));
        setEditingId(null);
        addToast({ message: "수정되었습니다.", variant: "success" });
      }
    } catch { addToast({ message: "수정에 실패했습니다.", variant: "error" }); }
  };

  const handleDelete = async () => {
    if (!deletingId) return;
    try {
      const res = await fetchWithAuth<{ success: boolean }>(`/api/events/${eventId}/open-notices/${deletingId}`, {
        method: "DELETE",
      });
      if (res.success) {
        setNotices((p) => p.filter((n) => n.id !== deletingId));
        addToast({ message: "삭제되었습니다.", variant: "success" });
      }
    } catch { addToast({ message: "삭제에 실패했습니다.", variant: "error" }); }
    setDeletingId(null);
  };

  // 확인 버튼 잠금 + 재진입 차단 + 실패 시 해제 (S3). `handleDelete` 이 창을 닫는다.
  const deleteAction = useConfirmAction(() => handleDelete());

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div><p className="text-sm text-content-subtle">공개 공지</p><h2 className="mt-2 text-3xl font-black tracking-[-0.04em] text-foreground">공개 공지</h2></div>
        <Button onClick={() => setShowForm(!showForm)}>
          <Plus className="size-4" /> 공지 작성
        </Button>
      </div>

      {showForm ? (
        <div className="rounded-lg border border-border bg-card p-6 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div><label className="text-sm font-medium">유형</label>
              <select value={form.type} onChange={(e) => setForm((p) => ({ ...p, type: e.target.value }))} className="mt-1 w-full rounded-lg border border-border bg-card px-3 py-2.5 text-sm">
                {Object.entries(TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <div><label className="text-sm font-medium">즉시 발행</label>
              <label className="mt-2 flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={form.isPublished} onChange={(e) => setForm((p) => ({ ...p, isPublished: e.target.checked }))} className="size-4 rounded" />
                <span className="text-sm">작성 즉시 공개</span>
              </label>
            </div>
          </div>
          <div><label className="text-sm font-medium">제목</label><input value={form.title} onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))} className="mt-1 w-full rounded-lg border border-border bg-card px-4 py-2.5 text-sm" placeholder="공지 제목" /></div>
          <div><label className="text-sm font-medium">내용</label><textarea value={form.content} onChange={(e) => setForm((p) => ({ ...p, content: e.target.value }))} rows={4} className="mt-1 w-full rounded-lg border border-border bg-card px-4 py-2.5 text-sm" placeholder="공지 내용을 작성하세요" /></div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowForm(false)} className="rounded-lg border border-border px-4 py-2 text-sm">취소</button>
            <Button type="button" onClick={submit} disabled={submitting || !form.title.trim()}>{submitting ? "등록중..." : "등록"}</Button>
          </div>
        </div>
      ) : null}

      {loading ? <div className="animate-pulse rounded-lg border bg-card p-6"><div className="h-5 w-48 rounded bg-bg-muted" /></div> : notices.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-12 text-center"><Megaphone className="mx-auto size-12 text-primary" /><h3 className="mt-4 text-lg font-bold">등록된 공지가 없습니다</h3></div>
      ) : (
        <div className="space-y-3">
          {notices.map((n) =>
            editingId === n.id ? (
              <div key={n.id} className="rounded-lg border border-primary bg-card p-5 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium">유형</label>
                    <select value={editForm.type} onChange={(e) => setEditForm((p) => ({ ...p, type: e.target.value }))} className="mt-1 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm">
                      {Object.entries(TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-medium">발행 상태</label>
                    <label className="mt-2 flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={editForm.isPublished} onChange={(e) => setEditForm((p) => ({ ...p, isPublished: e.target.checked }))} className="size-4 rounded" />
                      <span className="text-sm">{editForm.isPublished ? "발행됨" : "미발행"}</span>
                    </label>
                  </div>
                </div>
                <input value={editForm.title} onChange={(e) => setEditForm((p) => ({ ...p, title: e.target.value }))} className="w-full rounded-lg border border-border bg-card px-4 py-2 text-sm" />
                <textarea value={editForm.content} onChange={(e) => setEditForm((p) => ({ ...p, content: e.target.value }))} rows={3} className="w-full rounded-lg border border-border bg-card px-4 py-2 text-sm" />
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => void saveEdit()}>저장</Button>
                  <Button size="sm" variant="outline" onClick={() => setEditingId(null)}>
                    <X className="size-3" /> 취소
                  </Button>
                </div>
              </div>
            ) : (
              <div key={n.id} className="rounded-lg border border-border bg-card p-5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${n.type === "cancellation" ? "bg-error/10 text-error" : n.type === "refund" ? "bg-warning/10 text-warning" : "bg-bg-muted text-content-subtle"}`}>{TYPE_LABELS[n.type] ?? n.type}</span>
                    <h4 className="font-semibold text-foreground">{n.title}</h4>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-xs ${n.isPublished ? "text-success" : "text-content-muted"}`}>{n.isPublished ? "발행됨" : "미발행"}</span>
                    <button onClick={() => startEdit(n)} className="rounded p-1.5 text-content-subtle hover:bg-muted hover:text-foreground">
                      <Pencil className="size-3.5" />
                    </button>
                    <button onClick={() => setDeletingId(n.id)} className="rounded p-1.5 text-content-subtle hover:bg-error/10 hover:text-error">
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                </div>
                <p className="mt-2 text-sm text-content-subtle line-clamp-2">{n.content}</p>
                <p className="mt-2 text-xs text-content-muted">{formatDateTimeSecKst(n.createdAt)}</p>
              </div>
            ),
          )}
        </div>
      )}

      <ConfirmDialog
        open={Boolean(deletingId)}
        title="공지를 삭제할까요?"
        description="이 공지가 삭제됩니다."
        confirmText="삭제하기"
        pending={deleteAction.pending}
        onConfirm={deleteAction.run}
        onOpenChange={(open) => {
          if (!open) setDeletingId(null);
        }}
      />
    </div>
  );
}
