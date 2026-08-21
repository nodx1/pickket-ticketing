"use client";

import { useCallback, useEffect, useState } from "react";
import { HelpCircle } from "lucide-react";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { fetchWithAuth } from "@/lib/fetchWithAuth";
import { showError, showSuccess } from "@/lib/hooks/useToast";

interface Inquiry {
  id: string;
  contact: string | null;
  question: string;
  answer: string | null;
  status: "open" | "answered" | "archived";
  source: string;
  createdAt: string;
}

interface PatchResult {
  updated: boolean;
  notified: boolean;
  simulated?: boolean;
  reason?: "no_answer" | "non_email_contact" | "send_failed";
}

const STATUS_LABEL: Record<string, string> = { open: "미처리", answered: "답변완료", archived: "보관" };

export function InquiriesClient({ eventId }: { eventId: string }) {
  const [items, setItems] = useState<Inquiry[]>([]);
  const [loading, setLoading] = useState(true);

  // 답변 다이얼로그 상태
  const [answering, setAnswering] = useState<Inquiry | null>(null);
  const [answerText, setAnswerText] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchWithAuth<{ data: Inquiry[] }>(`/api/events/${eventId}/inquiries`);
      setItems(res.data ?? []);
    } catch {
      /* noop */
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => { void load(); }, [load]);

  function openAnswer(inquiry: Inquiry) {
    setAnswering(inquiry);
    setAnswerText(inquiry.answer ?? "");
  }

  function closeAnswer() {
    setAnswering(null);
    setAnswerText("");
    setSaving(false);
  }

  async function submitAnswer() {
    if (!answering) return;
    const trimmed = answerText.trim();
    if (!trimmed) {
      showError("답변 내용을 입력해주세요");
      return;
    }
    setSaving(true);
    try {
      const res = await fetchWithAuth<{ data: PatchResult }>(`/api/events/${eventId}/inquiries`, {
        method: "PATCH",
        body: JSON.stringify({ id: answering.id, answer: trimmed, status: "answered" }),
      });
      const result = res.data;
      setItems((prev) =>
        prev.map((i) => (i.id === answering.id ? { ...i, answer: trimmed, status: "answered" } : i)),
      );
      if (result?.notified) {
        showSuccess(
          result.simulated
            ? "답변을 저장했습니다. (통지 이메일은 시뮬레이션 모드로 실제 발송되지 않았습니다)"
            : "답변을 저장하고 소비자에게 이메일로 통지했습니다",
        );
      } else if (result?.reason === "non_email_contact") {
        showSuccess("답변을 저장했습니다. (연락처가 이메일이 아니어서 자동 통지는 생략됨)");
      } else if (result?.reason === "send_failed") {
        showError("답변은 저장됐지만 통지 발송에 실패했습니다");
      } else {
        showSuccess("답변을 저장했습니다");
      }
      closeAnswer();
    } catch (err) {
      showError(err instanceof Error ? err.message : "답변 저장에 실패했습니다");
      setSaving(false);
    }
  }

  async function setStatus(id: string, status: Inquiry["status"]) {
    try {
      await fetchWithAuth(`/api/events/${eventId}/inquiries`, { method: "PATCH", body: JSON.stringify({ id, status }) });
      setItems((prev) => prev.map((i) => (i.id === id ? { ...i, status } : i)));
    } catch {
      showError("상태 변경에 실패했습니다");
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-content-subtle">소통 & 마케팅</p>
          <h2 className="mt-2 text-3xl font-black tracking-[-0.04em] text-foreground">문의 (FAQ)</h2>
          <p className="mt-1 text-xs text-content-muted">소비자 문의를 모아 답변합니다.</p>
        </div>
      </div>

      {loading ? (
        <p className="py-8 text-center text-sm text-content-subtle">불러오는 중…</p>
      ) : items.length === 0 ? (
        <EmptyState
          icon={HelpCircle}
          title="문의가 없습니다"
          description="공개 이벤트 페이지·챗봇에서 접수된 소비자 문의가 이곳에 모입니다."
        />
      ) : (
        <div className="space-y-2">
          {items.map((q) => (
            <div key={q.id} className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm text-foreground">{q.question}</p>
                  <p className="mt-1 text-xs text-content-muted">
                    {q.contact ?? "익명"} · {new Date(q.createdAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={q.status === "answered" ? "success" : q.status === "archived" ? "secondary" : "warning"}>
                    {STATUS_LABEL[q.status] ?? q.status}
                  </Badge>
                  {q.answer ? (
                    <Button variant="outline" size="sm" onClick={() => openAnswer(q)}>답변 수정</Button>
                  ) : (
                    <Button variant="outline" size="sm" onClick={() => openAnswer(q)}>답변하기</Button>
                  )}
                  {q.status !== "archived" ? (
                    <Button variant="ghost" size="sm" onClick={() => void setStatus(q.id, "archived")}>보관</Button>
                  ) : null}
                </div>
              </div>
              {q.answer ? (
                <div className="mt-3 rounded-lg border border-border bg-bg-muted p-3">
                  <p className="text-xs font-medium text-content-muted">답변</p>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-content-subtle">{q.answer}</p>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      <Dialog open={answering !== null} onOpenChange={(open) => { if (!open) closeAnswer(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{answering?.answer ? "답변 수정" : "문의 답변"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-lg border border-border bg-bg-muted p-3">
              <p className="text-xs font-medium text-content-muted">문의 내용</p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{answering?.question}</p>
              <p className="mt-2 text-xs text-content-muted">{answering?.contact ?? "익명"}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="inquiry-answer">답변</Label>
              <Textarea
                id="inquiry-answer"
                value={answerText}
                onChange={(event) => setAnswerText(event.target.value)}
                maxLength={2000}
                placeholder="소비자에게 전달할 답변을 입력하세요. 연락처가 이메일이면 저장 시 자동으로 통지됩니다."
              />
              <p className="text-[11px] text-content-muted">이메일 연락처인 경우 답변 저장 시 소비자에게 자동으로 통지됩니다.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeAnswer} disabled={saving}>취소</Button>
            <Button onClick={() => void submitAnswer()} disabled={saving || !answerText.trim()}>
              {saving ? "저장 중…" : "저장"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
