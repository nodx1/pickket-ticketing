"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Eye, EyeOff, Music, Pencil, Plus, Trash2, X } from "lucide-react";
import { fetchWithAuth } from "@/lib/fetchWithAuth";
import { useToast } from "@/lib/hooks/useToast";

interface Participant {
  id: string;
  name: string;
  role: string;
  bio: string | null;
  image_url: string | null;
  sort_order: number;
  is_visible: boolean;
}

const ROLE_LABELS: Record<string, string> = {
  performer: "공연자",
  speaker: "스피커",
  mc: "MC",
  dj: "DJ",
  guest: "게스트",
};

export default function ParticipantsPage() {
  const { eventId } = useParams<{ eventId: string }>();
  const [items, setItems] = useState<Participant[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [role, setRole] = useState("performer");
  const [bio, setBio] = useState("");
  const [editId, setEditId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<Participant & { imageUrl: string }>>({});
  const { addToast } = useToast();

  const load = useCallback(async () => {
    try {
      const res = await fetchWithAuth<{ success: boolean; data: Participant[] }>(
        `/api/events/${eventId}/participants`,
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
      const res = await fetchWithAuth<{ success: boolean; data: Participant }>(
        `/api/events/${eventId}/participants`,
        { method: "POST", body: JSON.stringify({ name, role, bio: bio || null }) },
      );
      if (res.success) {
        setItems((p) => [...p, res.data]);
        setName("");
        setBio("");
        addToast({ message: "출연진이 추가되었습니다.", variant: "success" });
      }
    } catch {
      addToast({ message: "추가에 실패했습니다.", variant: "error" });
    }
  };

  const update = async (id: string) => {
    try {
      const res = await fetchWithAuth<{ success: boolean; data: Participant }>(
        `/api/events/${eventId}/participants/${id}`,
        { method: "PATCH", body: JSON.stringify(editForm) },
      );
      if (res.success) {
        setItems((p) => p.map((item) => (item.id === id ? res.data : item)));
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
        `/api/events/${eventId}/participants/${id}`,
        { method: "DELETE" },
      );
      if (res.success) {
        setItems((p) => p.filter((item) => item.id !== id));
        addToast({ message: "삭제되었습니다.", variant: "success" });
      }
    } catch {
      addToast({ message: "삭제에 실패했습니다.", variant: "error" });
    }
  };

  const toggleVisibility = async (p: Participant) => {
    try {
      const res = await fetchWithAuth<{ success: boolean; data: Participant }>(
        `/api/events/${eventId}/participants/${p.id}`,
        { method: "PATCH", body: JSON.stringify({ isVisible: !p.is_visible }) },
      );
      if (res.success) {
        setItems((prev) => prev.map((item) => (item.id === p.id ? res.data : item)));
      }
    } catch {
      addToast({ message: "변경에 실패했습니다.", variant: "error" });
    }
  };

  const startEdit = (p: Participant) => {
    setEditId(p.id);
    setEditForm({ name: p.name, role: p.role, bio: p.bio ?? "" });
  };

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-content-subtle">출연진 관리</p>
        <h2 className="mt-2 text-3xl font-black tracking-[-0.04em] text-foreground">출연진</h2>
      </div>

      {/* 추가 폼 */}
      <div className="space-y-3 rounded-lg border border-border bg-card p-5">
        <div className="flex gap-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="출연진 이름"
            className="flex-1 rounded-lg border border-border bg-card px-4 py-2.5 text-sm"
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)} aria-label="역할"
            className="rounded-lg border border-border bg-card px-3 py-2.5 text-sm"
          >
            {Object.entries(ROLE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <button
            onClick={add}
            className="flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-white"
          >
            <Plus className="size-4" /> 추가
          </button>
        </div>
        <input
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          placeholder="소개 (선택)"
          className="w-full rounded-lg border border-border bg-card px-4 py-2.5 text-sm"
        />
      </div>

      {/* 목록 */}
      {loading ? (
        <div className="animate-pulse rounded-lg border bg-card p-6">
          <div className="h-5 w-48 rounded bg-bg-muted" />
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-12 text-center">
          <Music className="mx-auto size-12 text-primary" />
          <h3 className="mt-4 text-lg font-bold">등록된 출연진이 없습니다</h3>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((p) =>
            editId === p.id ? (
              <div key={p.id} className="space-y-3 rounded-lg border-2 border-primary bg-card p-5">
                <input
                  value={editForm.name ?? ""}
                  onChange={(e) => setEditForm((prev) => ({ ...prev, name: e.target.value }))}
                  className="w-full rounded-lg border border-border px-3 py-2 text-sm"
                  placeholder="이름"
                />
                <select
                  value={editForm.role ?? "performer"}
                  onChange={(e) => setEditForm((prev) => ({ ...prev, role: e.target.value }))}
                  className="w-full rounded-lg border border-border px-3 py-2 text-sm"
                >
                  {Object.entries(ROLE_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
                <textarea
                  value={(editForm.bio as string) ?? ""}
                  onChange={(e) => setEditForm((prev) => ({ ...prev, bio: e.target.value }))}
                  className="w-full rounded-lg border border-border px-3 py-2 text-sm"
                  rows={3}
                  placeholder="소개"
                />
                <div className="flex gap-2">
                  <button onClick={() => update(p.id)} className="rounded-lg bg-primary px-4 py-2 text-xs font-medium text-white">저장</button>
                  <button onClick={() => { setEditId(null); setEditForm({}); }} className="rounded-lg bg-muted px-4 py-2 text-xs">
                    <X className="size-3" />
                  </button>
                </div>
              </div>
            ) : (
              <div key={p.id} className={`rounded-lg border border-border bg-card p-5 transition hover:border-primary/40 ${!p.is_visible ? "opacity-50" : ""}`}>
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-lg font-bold text-primary">
                      {p.name[0]}
                    </div>
                    <div>
                      <p className="font-semibold text-foreground">{p.name}</p>
                      <p className="text-xs text-content-muted">{ROLE_LABELS[p.role] ?? p.role}</p>
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <button onClick={() => toggleVisibility(p)} className="rounded p-1.5 text-content-subtle hover:bg-muted hover:text-foreground" title={p.is_visible ? "숨기기" : "보이기"}>
                      {p.is_visible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
                    </button>
                    <button onClick={() => startEdit(p)} className="rounded p-1.5 text-content-subtle hover:bg-muted hover:text-foreground">
                      <Pencil className="size-3.5" />
                    </button>
                    <button onClick={() => remove(p.id)} className="rounded p-1.5 text-content-subtle hover:bg-error/10 hover:text-error">
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                </div>
                {p.bio ? <p className="mt-3 text-sm text-content-subtle">{p.bio}</p> : null}
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}
