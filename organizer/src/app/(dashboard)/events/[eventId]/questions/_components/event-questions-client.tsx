"use client";

import { useEffect, useState } from "react";
import { useConfirmAction } from "@/lib/hooks/useConfirmAction";
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { fetchWithAuth } from "@/lib/fetchWithAuth";
import { showError, showSuccess } from "@/lib/hooks/useToast";

const QUESTION_TYPE_LABELS: Record<string, string> = {
  short_text: "단답",
  long_text: "장문",
  single_choice: "단일선택",
  multiple_choice: "다중선택",
  checkbox: "체크박스",
};

interface QuestionItem {
  id: string;
  label: string;
  questionType: "short_text" | "long_text" | "single_choice" | "multiple_choice" | "checkbox";
  isRequired: boolean;
  options: string[];
  sortOrder: number;
}

export function EventQuestionsClient({ eventId }: { eventId: string }) {
  const [items, setItems] = useState<QuestionItem[]>([]);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [questionType, setQuestionType] = useState<QuestionItem["questionType"]>("short_text");
  const [isRequired, setIsRequired] = useState(false);
  const [options, setOptions] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    async function load() {
      try {
        const payload = await fetchWithAuth<{ data?: QuestionItem[] }>(`/api/events/${eventId}/questions`);
        if (isMounted) {
          setItems(payload.data ?? []);
        }
      } catch {
        /* ignore */
      }
    }
    void load();
    return () => {
      isMounted = false;
    };
  }, [eventId]);

  async function refresh() {
    try {
      const payload = await fetchWithAuth<{ data?: QuestionItem[] }>(`/api/events/${eventId}/questions`);
      setItems(payload.data ?? []);
    } catch {
      /* ignore */
    }
  }

  function resetForm() {
    setEditingId(null);
    setLabel("");
    setQuestionType("short_text");
    setIsRequired(false);
    setOptions("");
  }

  function openCreate() {
    resetForm();
    setOpen(true);
  }

  function openEdit(item: QuestionItem) {
    setEditingId(item.id);
    setLabel(item.label);
    setQuestionType(item.questionType);
    setIsRequired(item.isRequired);
    setOptions(item.options.join("\n"));
    setOpen(true);
  }

  async function handleSave() {
    const isChoice =
      questionType === "single_choice" || questionType === "multiple_choice" || questionType === "checkbox";
    const parsedOptions = isChoice
      ? options.split("\n").map((value) => value.trim()).filter(Boolean)
      : [];
    const payload = { label, questionType, isRequired, options: parsedOptions };
    try {
      const url = editingId
        ? `/api/events/${eventId}/questions/${editingId}`
        : `/api/events/${eventId}/questions`;
      const res = await fetchWithAuth<{ success?: boolean }>(url, {
        method: editingId ? "PATCH" : "POST",
        body: JSON.stringify(payload),
      });
      if (!res) throw new Error(editingId ? "질문 수정에 실패했습니다" : "질문 추가에 실패했습니다");
      showSuccess(editingId ? "질문이 수정되었습니다" : "질문이 추가되었습니다");
      setOpen(false);
      resetForm();
      await refresh();
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : editingId ? "질문 수정에 실패했습니다" : "질문 추가에 실패했습니다");
    }
  }

  async function moveQuestion(index: number, direction: -1 | 1) {
    const next = [...items];
    const swapIndex = index + direction;
    if (!next[swapIndex]) {
      return;
    }
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
    setItems(next);
    try {
      await fetchWithAuth(`/api/events/${eventId}/questions/reorder`, {
        method: "PUT",
        body: JSON.stringify({ orderedIds: next.map((item) => item.id) }),
      });
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "순서 변경에 실패했습니다");
      await refresh();
    }
  }

  async function removeQuestion(id: string) {
    try {
      await fetchWithAuth(`/api/events/${eventId}/questions/${id}`, {
        method: "DELETE",
      });
      showSuccess("질문이 삭제되었습니다");
      await refresh();
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "질문 삭제에 실패했습니다");
    }
  }

  // 확인 버튼 잠금 + 재진입 차단 + 실패 시 해제 (S3).
  // 종전엔 `void fn(); setTarget(null)` 라 **요청이 끝나기 전에 창이 닫혔다** —
  // 그 상태로 pending 을 넘겨봐야 보이지도 않는다. 끝난 뒤 닫도록 바꿨다.
  const removeAction = useConfirmAction(async () => {
    if (!deletingId) return;
    await removeQuestion(deletingId);
    setDeletingId(null);
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-muted-foreground">등록 질문</p>
          <h2 className="mt-2 text-3xl font-black tracking-[-0.04em] text-foreground">등록 질문</h2>
        </div>
        <Button onClick={openCreate}>
          <Plus className="size-4" />
          질문 추가
        </Button>
      </div>

      <div className="space-y-4">
        {items.map((item, index) => (
          <Card key={item.id}>
            <CardHeader className="flex-row items-center justify-between gap-4">
              <div>
                <CardTitle className="text-foreground">{item.label}</CardTitle>
                <div className="mt-2 flex gap-2">
                  <Badge>{QUESTION_TYPE_LABELS[item.questionType] ?? item.questionType}</Badge>
                  {item.isRequired ? <Badge variant="warning">필수</Badge> : null}
                </div>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="icon" aria-label="위로 이동" onClick={() => void moveQuestion(index, -1)}>
                  <ArrowUp className="size-4" />
                </Button>
                <Button variant="outline" size="icon" aria-label="아래로 이동" onClick={() => void moveQuestion(index, 1)}>
                  <ArrowDown className="size-4" />
                </Button>
                <Button variant="outline" size="icon" aria-label="질문 수정" onClick={() => openEdit(item)}>
                  <Pencil className="size-4" />
                </Button>
                <Button variant="outline" size="icon" aria-label="질문 삭제" onClick={() => setDeletingId(item.id)}>
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </CardHeader>
            {item.options.length > 0 ? (
              <CardContent className="text-sm text-muted-foreground">
                {item.options.join(", ")}
              </CardContent>
            ) : null}
          </Card>
        ))}
      </div>

      <ConfirmDialog
        open={Boolean(deletingId)}
        title="질문을 삭제할까요?"
        description="이 질문을 삭제할까요? 기존 답변 데이터 표시에 영향이 있을 수 있습니다."
        confirmText="삭제하기"
        pending={removeAction.pending}
        onConfirm={removeAction.run}
        onOpenChange={(isOpen) => {
          if (!isOpen) setDeletingId(null);
        }}
      />

      <Dialog open={open} onOpenChange={(isOpen) => { setOpen(isOpen); if (!isOpen) resetForm(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId ? "질문 수정" : "질문 추가"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="question-label">질문 문구</Label>
              <Input id="question-label" value={label} onChange={(event) => setLabel(event.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>질문 유형</Label>
              <Select value={questionType} onValueChange={(value: QuestionItem["questionType"]) => setQuestionType(value)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="short_text">단답</SelectItem>
                  <SelectItem value="long_text">장문</SelectItem>
                  <SelectItem value="single_choice">단일선택</SelectItem>
                  <SelectItem value="multiple_choice">다중선택</SelectItem>
                  <SelectItem value="checkbox">체크박스</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {questionType === "single_choice" || questionType === "multiple_choice" || questionType === "checkbox" ? (
              <div className="space-y-2">
                <Label htmlFor="question-options">선택지 (줄바꿈으로 구분)</Label>
                <textarea
                  id="question-options"
                  className="min-h-28 w-full rounded-lg border border-border bg-background px-4 py-3 text-sm text-foreground outline-none"
                  value={options}
                  onChange={(event) => setOptions(event.target.value)}
                />
              </div>
            ) : null}
            <div className="flex items-center justify-between rounded-lg border border-border bg-muted px-4 py-3">
              <Label htmlFor="question-required">필수 질문</Label>
              <Switch id="question-required" checked={isRequired} onCheckedChange={setIsRequired} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setOpen(false); resetForm(); }}>
              취소
            </Button>
            <Button onClick={() => void handleSave()} disabled={label.trim().length < 2}>저장</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
