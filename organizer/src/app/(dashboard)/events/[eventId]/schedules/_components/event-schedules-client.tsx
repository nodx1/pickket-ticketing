"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { useConfirmAction } from "@/lib/hooks/useConfirmAction";
import { Pencil, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { ImageUpload } from "@/components/shared/image-upload";
import { formatKstDateTime, toKstLocalInput } from "@/lib/datetime/kst-local";
import { fetchWithAuth } from "@/lib/fetchWithAuth";
import { showError, showSuccess } from "@/lib/hooks/useToast";

interface ScheduleRow {
  id: string;
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string;
  venueName: string | null;
  sortOrder: number;
  /** 일정에 붙은 안내 이미지(조편성표 등). 없으면 `null`. */
  imageUrl: string | null;
}

/**
 * 🔴 `timeZone` 없는 `toLocaleString` 을 쓰지 않는다 (2026-07-31 실사고).
 *    그러면 **보는 사람 PC 시간대**로 렌더돼, 같은 일정이 해외 스태프에게 다른 시각으로 보인다.
 */
const formatDateTime = formatKstDateTime;

export function EventSchedulesClient({ eventId }: { eventId: string }) {
  const [items, setItems] = useState<ScheduleRow[]>([]);
  const [form, setForm] = useState({
    title: "",
    description: "",
    startsAt: "",
    endsAt: "",
    venueName: "",
    /** 🔴 폼 안에서는 빈 문자열이 「없음」이다(ImageUpload 계약). 보낼 때 `null` 로 바꾼다. */
    imageUrl: "",
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({
    title: "",
    description: "",
    startsAt: "",
    endsAt: "",
    venueName: "",
    imageUrl: "",
  });
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function load() {
    try {
      const payload = await fetchWithAuth<{ data?: ScheduleRow[] }>(`/api/events/${eventId}/schedules`);
      setItems(payload.data ?? []);
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  async function createSchedule() {
    if (!form.title.trim()) {
      showError("일정 제목을 입력해주세요");
      return;
    }
    try {
      const response = await fetchWithAuth<{ success?: boolean }>(`/api/events/${eventId}/schedules`, {
        method: "POST",
        body: JSON.stringify({
          ...form,
          // 🔴 `""` 를 그대로 보내면 서버 `.url()` 검증이 400 을 낸다. 「없음」은 `null` 로 보낸다.
          imageUrl: form.imageUrl || null,
          sortOrder: items.length,
        }),
      });
      if (response) {
        showSuccess("일정이 추가되었습니다");
        setForm({ title: "", description: "", startsAt: "", endsAt: "", venueName: "", imageUrl: "" });
        await load();
      }
    } catch {
      showError("일정 추가에 실패했습니다");
    }
  }

  function startEdit(item: ScheduleRow) {
    setEditingId(item.id);
    setEditForm({
      title: item.title,
      description: item.description ?? "",
      // 🔴 `slice(0,16)` 은 **UTC 를 그대로 잘라** 입력칸에 넣는다 — 수정할 때마다 9시간 밀렸다.
      startsAt: toKstLocalInput(item.startsAt),
      endsAt: toKstLocalInput(item.endsAt),
      venueName: item.venueName ?? "",
      imageUrl: item.imageUrl ?? "",
    });
  }

  async function saveEdit() {
    if (!editingId) return;
    try {
      await fetchWithAuth(`/api/events/${eventId}/schedules/${editingId}`, {
        method: "PATCH",
        body: JSON.stringify({ ...editForm, imageUrl: editForm.imageUrl || null }),
      });
      showSuccess("일정이 수정되었습니다");
      setEditingId(null);
      await load();
    } catch {
      showError("일정 수정에 실패했습니다");
    }
  }

  async function handleDelete() {
    if (!deletingId) return;
    try {
      await fetchWithAuth(`/api/events/${eventId}/schedules/${deletingId}`, {
        method: "DELETE",
      });
      showSuccess("일정이 삭제되었습니다");
      await load();
    } catch {
      showError("일정 삭제에 실패했습니다");
    }
    setDeletingId(null);
  }

  // 확인 버튼 잠금 + 재진입 차단 + 실패 시 해제 (S3). `handleDelete` 이 창을 닫는다.
  const deleteAction = useConfirmAction(() => handleDelete());

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-black tracking-[-0.04em] text-foreground">일정</h2>
        <p className="mt-2 text-sm text-muted-foreground">세션/공연/프로그램 시간을 타임라인으로 운영합니다.</p>
      </div>

      <div className="grid gap-3 rounded-lg border border-border bg-card/95 p-5 lg:grid-cols-2">
        <Input placeholder="일정 제목" value={form.title} onChange={(event) => setForm((prev) => ({ ...prev, title: event.target.value }))} />
        <Input placeholder="장소" value={form.venueName} onChange={(event) => setForm((prev) => ({ ...prev, venueName: event.target.value }))} />
        <Input type="datetime-local" value={form.startsAt} aria-label="시작 일시" onChange={(event) => setForm((prev) => ({ ...prev, startsAt: event.target.value }))} />
        <Input type="datetime-local" value={form.endsAt} aria-label="종료 일시" onChange={(event) => setForm((prev) => ({ ...prev, endsAt: event.target.value }))} />
        <div className="lg:col-span-2">
          <Textarea placeholder="설명" value={form.description} onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))} />
        </div>
        <div className="lg:col-span-2">
          <ImageUpload
            label="안내 이미지 (선택)"
            value={form.imageUrl}
            onChange={(url) => setForm((prev) => ({ ...prev, imageUrl: url }))}
            hint={{ size: "가로 1200px 이상 권장", tip: "조편성표·좌석 안내처럼 글자가 있는 이미지는 폭이 넓을수록 잘 읽힙니다. 공개 상세의 프로그램·일정 탭에 이 일정과 함께 표시됩니다." }}
          />
        </div>
        <div className="lg:col-span-2">
          <Button onClick={() => void createSchedule()}>일정 추가</Button>
        </div>
      </div>

      <div className="space-y-4">
        {items.map((item) =>
          editingId === item.id ? (
            <Card key={item.id} className="border-primary bg-card/95">
              <CardContent className="space-y-3 p-5">
                <div className="grid gap-3 lg:grid-cols-2">
                  <Input value={editForm.title} onChange={(e) => setEditForm((p) => ({ ...p, title: e.target.value }))} placeholder="일정 제목" />
                  <Input value={editForm.venueName} onChange={(e) => setEditForm((p) => ({ ...p, venueName: e.target.value }))} placeholder="장소" />
                  <Input type="datetime-local" value={editForm.startsAt} aria-label="시작 일시" onChange={(e) => setEditForm((p) => ({ ...p, startsAt: e.target.value }))} />
                  <Input type="datetime-local" value={editForm.endsAt} aria-label="종료 일시" onChange={(e) => setEditForm((p) => ({ ...p, endsAt: e.target.value }))} />
                  <div className="lg:col-span-2">
                    <Textarea value={editForm.description} onChange={(e) => setEditForm((p) => ({ ...p, description: e.target.value }))} placeholder="설명" />
                  </div>
                  <div className="lg:col-span-2">
                    <ImageUpload
                      label="안내 이미지 (선택)"
                      value={editForm.imageUrl}
                      onChange={(url) => setEditForm((p) => ({ ...p, imageUrl: url }))}
                      hint={{ size: "가로 1200px 이상 권장", tip: "삭제하고 저장하면 공개 화면에서도 사라집니다." }}
                    />
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => void saveEdit()}>저장</Button>
                  <Button size="sm" variant="outline" onClick={() => setEditingId(null)}>
                    <X className="size-4" /> 취소
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card key={item.id} className="border-border bg-card/95">
              <CardContent className="space-y-2 p-5">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-lg font-bold text-foreground">{item.title}</h3>
                  <div className="flex items-center gap-2">
                    <p className="text-xs uppercase tracking-[0.14em] text-primary">#{item.sortOrder + 1}</p>
                    <Button variant="outline" size="icon" aria-label="일정 수정" onClick={() => startEdit(item)}>
                      <Pencil className="size-4" />
                    </Button>
                    <Button variant="outline" size="icon" aria-label="일정 삭제" onClick={() => setDeletingId(item.id)}>
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground">{item.description ?? "설명 없음"}</p>
                <p className="text-sm text-muted-foreground">{formatDateTime(item.startsAt)} ~ {formatDateTime(item.endsAt)}</p>
                <p className="text-sm text-muted-foreground">{item.venueName ?? "장소 미정"}</p>
                {item.imageUrl ? (
                  <a href={item.imageUrl} target="_blank" rel="noopener noreferrer" className="block w-fit">
                    {/* 원본이 세로로 긴 안내물(조편성표)일 수 있어 잘라내지 않고 축소만 한다. */}
                    <Image
                      src={item.imageUrl}
                      alt={`${item.title} 안내 이미지`}
                      width={240}
                      height={0}
                      unoptimized
                      className="h-auto w-[240px] rounded-lg border border-border"
                    />
                  </a>
                ) : null}
              </CardContent>
            </Card>
          ),
        )}
      </div>

      <ConfirmDialog
        open={Boolean(deletingId)}
        title="일정을 삭제할까요?"
        description="이 일정 항목이 삭제됩니다."
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
