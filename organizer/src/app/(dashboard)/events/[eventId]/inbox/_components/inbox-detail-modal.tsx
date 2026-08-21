"use client";

import { useCallback, useEffect, useState } from "react";
import DOMPurify from "isomorphic-dompurify";
import { Copy, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fetchWithAuth } from "@/lib/fetchWithAuth";
import { showError, showSuccess } from "@/lib/hooks/useToast";
import { formatDate } from "@/lib/format";

export type InboxStatus = "new" | "replied" | "archived";

interface InboundEmailDetail {
  id: string;
  fromEmail: string;
  fromName: string | null;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  status: InboxStatus;
  aiDraft: string | null;
  createdAt: string;
}

const STATUS_LABELS: Record<InboxStatus, string> = {
  new: "새 메일",
  replied: "답장 완료",
  archived: "보관",
};

interface InboxDetailModalProps {
  eventId: string;
  emailId: string | null;
  open: boolean;
  onClose: () => void;
  /** 상태 변경이 성공하면 목록을 갱신하도록 상위에 통지 */
  onStatusChange: (emailId: string, status: InboxStatus) => void;
}

export function InboxDetailModal({ eventId, emailId, open, onClose, onStatusChange }: InboxDetailModalProps) {
  const [detail, setDetail] = useState<InboundEmailDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!open || !emailId) {
      return;
    }
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      setDetail(null);
      setReply("");
      try {
        const res = await fetchWithAuth<{ data: InboundEmailDetail }>(
          `/api/events/${eventId}/inbox/${emailId}`,
        );
        if (!cancelled) {
          setDetail(res.data ?? null);
          setReply(res.data?.aiDraft ?? "");
        }
      } catch (err: unknown) {
        if (!cancelled) setError(err instanceof Error ? err.message : "이메일을 불러오지 못했습니다");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [open, emailId, eventId]);

  const updateStatus = useCallback(
    async (status: InboxStatus) => {
      if (!emailId) return;
      setUpdating(true);
      try {
        await fetchWithAuth(`/api/events/${eventId}/inbox/${emailId}`, {
          method: "PATCH",
          body: JSON.stringify({ status }),
        });
        setDetail((prev) => (prev ? { ...prev, status } : prev));
        onStatusChange(emailId, status);
        showSuccess(`'${STATUS_LABELS[status]}'(으)로 변경했습니다`);
      } catch (err: unknown) {
        showError(err instanceof Error ? err.message : "상태 변경에 실패했습니다");
      } finally {
        setUpdating(false);
      }
    },
    [emailId, eventId, onStatusChange],
  );

  const sendReply = useCallback(async () => {
    if (!emailId) return;
    const trimmed = reply.trim();
    if (!trimmed) return;
    setSending(true);
    try {
      await fetchWithAuth(`/api/events/${eventId}/inbox/${emailId}`, {
        method: "POST",
        body: JSON.stringify({ reply: trimmed }),
      });
      setDetail((prev) => (prev ? { ...prev, status: "replied" } : prev));
      onStatusChange(emailId, "replied");
      showSuccess("답장을 발송했습니다");
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "답장 발송에 실패했습니다");
    } finally {
      setSending(false);
    }
  }, [emailId, eventId, reply, onStatusChange]);

  const copyDraft = useCallback(async () => {
    if (!detail?.aiDraft) return;
    try {
      await navigator.clipboard.writeText(detail.aiDraft);
      showSuccess("AI 초안을 복사했습니다");
    } catch {
      showError("복사에 실패했습니다. 직접 선택해 복사해주세요.");
    }
  }, [detail]);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="pr-8">{detail?.subject ?? "(제목 없음)"}</DialogTitle>
          <DialogDescription>
            {detail ? (
              <>
                {detail.fromName ? `${detail.fromName} · ` : ""}
                {detail.fromEmail} · {formatDate(detail.createdAt)}
              </>
            ) : (
              "이메일 상세"
            )}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="space-y-3 py-6" aria-busy="true">
            <div className="h-4 w-2/3 animate-pulse rounded bg-bg-emphasis" />
            <div className="h-4 w-full animate-pulse rounded bg-bg-emphasis" />
            <div className="h-4 w-5/6 animate-pulse rounded bg-bg-emphasis" />
          </div>
        ) : error ? (
          <div className="rounded-lg border border-error/30 bg-bg-error p-4 text-sm text-content-error">
            {error}
          </div>
        ) : detail ? (
          <div className="space-y-5">
            <div className="flex items-center gap-2">
              <Badge variant={detail.status === "new" ? "default" : "outline"}>
                {STATUS_LABELS[detail.status]}
              </Badge>
            </div>

            {/* 본문 */}
            {detail.bodyHtml ? (
              <div
                className="prose prose-sm max-w-none text-content-default"
                // 수신 이메일 원문 HTML — DOMPurify 로 새니타이즈
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(detail.bodyHtml) }}
              />
            ) : (
              <p className="whitespace-pre-wrap text-sm text-content-default">
                {detail.bodyText ?? "(본문 없음)"}
              </p>
            )}

            {/* AI 초안 */}
            {detail.aiDraft ? (
              <div className="rounded-lg border border-border-subtle bg-bg-muted p-4">
                <div className="mb-2 flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-sm font-semibold text-primary">
                    <Sparkles className="size-4" /> AI 답장 초안
                  </span>
                  <Button type="button" variant="outline" size="sm" onClick={() => void copyDraft()}>
                    <Copy className="size-3.5" /> 복사
                  </Button>
                </div>
                <p className="whitespace-pre-wrap text-sm text-content-subtle">{detail.aiDraft}</p>
                <p className="mt-3 text-xs text-content-muted">
                  초안이 아래 답장 입력창에 채워졌습니다. 내용을 확인·수정한 뒤 발송하세요.
                </p>
              </div>
            ) : null}

            {/* 답장 작성 · 발송 */}
            <div className="space-y-2">
              <label htmlFor="inbox-reply" className="text-sm font-semibold text-content-emphasis">
                답장 작성
              </label>
              <Textarea
                id="inbox-reply"
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                placeholder="보낸 분에게 전달할 답장을 입력하세요"
                maxLength={5000}
                disabled={sending}
                rows={6}
              />
              <p className="text-xs text-content-muted">
                발송하면 발신 도메인은 pickket.kr 이며, 받는 분이 회신하면 주최자 연락 이메일로 전달됩니다.
              </p>
              <div className="flex justify-end">
                <Button
                  type="button"
                  size="sm"
                  disabled={sending || reply.trim().length === 0}
                  onClick={() => void sendReply()}
                >
                  {sending ? "발송 중…" : detail.status === "replied" ? "다시 발송" : "답장 발송"}
                </Button>
              </div>
            </div>
          </div>
        ) : null}

        <DialogFooter className="gap-2 sm:justify-between">
          <div className="flex flex-wrap gap-2">
            {detail && detail.status !== "replied" ? (
              <Button type="button" variant="outline" size="sm" disabled={updating} onClick={() => void updateStatus("replied")}>
                답장 완료로 표시
              </Button>
            ) : null}
            {detail && detail.status !== "archived" ? (
              <Button type="button" variant="outline" size="sm" disabled={updating} onClick={() => void updateStatus("archived")}>
                보관
              </Button>
            ) : null}
            {detail && detail.status !== "new" ? (
              <Button type="button" variant="ghost" size="sm" disabled={updating} onClick={() => void updateStatus("new")}>
                새 메일로 되돌리기
              </Button>
            ) : null}
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            닫기
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
