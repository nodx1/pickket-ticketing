"use client";

import { useEffect, useState } from "react";
import { Inbox, Mail } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/empty-state";
import { fetchWithAuth } from "@/lib/fetchWithAuth";
import { showError } from "@/lib/hooks/useToast";
import { formatDate } from "@/lib/format";
import { InboxDetailModal, type InboxStatus } from "./inbox-detail-modal";

interface InboundEmail {
  id: string;
  fromEmail: string;
  fromName: string | null;
  subject: string | null;
  status: string;
  excerpt: string | null;
  hasAiDraft: boolean;
  createdAt: string;
}

const statusLabels: Record<string, string> = {
  new: "새 메일",
  replied: "답장 완료",
  archived: "보관",
};

export function InboxClient({ eventId }: { eventId: string }) {
  const [emails, setEmails] = useState<InboundEmail[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const res = await fetchWithAuth<{ data: InboundEmail[] }>(`/api/events/${eventId}/inbox`);
        setEmails(res.data ?? []);
      } catch (err: unknown) {
        if (err instanceof Error) showError(err.message);
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, [eventId]);

  function handleStatusChange(id: string, status: InboxStatus) {
    setEmails((prev) => prev.map((e) => (e.id === id ? { ...e, status } : e)));
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-content-muted">고객 문의</p>
        <h2 className="mt-2 text-3xl font-black tracking-[-0.04em] text-foreground">인박스</h2>
        <p className="mt-2 text-sm text-content-subtle">
          참석자가 보낸 이메일을 확인하고 AI 답장 초안과 함께 응대 상태를 관리하세요.
        </p>
      </div>

      {loading ? (
        <div className="space-y-3" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-[76px] animate-pulse rounded-lg border border-border-subtle bg-bg-muted" />
          ))}
        </div>
      ) : emails.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="수신 이메일이 없습니다"
          description="참석자가 이메일을 보내면 이곳에서 확인하고 답장할 수 있습니다."
        />
      ) : (
        <div className="space-y-3">
          {emails.map((email) => (
            <Card
              key={email.id}
              role="button"
              tabIndex={0}
              aria-label={`${email.fromName ?? email.fromEmail}의 이메일 열기`}
              className="cursor-pointer transition hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              onClick={() => setOpenId(email.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setOpenId(email.id);
                }
              }}
            >
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <Mail className="mt-1 size-4 shrink-0 text-content-muted" />
                    <div className="min-w-0 space-y-1">
                      <p className="font-semibold text-foreground">
                        {email.fromName ?? email.fromEmail}
                      </p>
                      <p className="truncate text-sm text-content-subtle">
                        {email.subject ?? "(제목 없음)"}
                      </p>
                      {email.excerpt ? (
                        <p className="line-clamp-1 text-sm text-content-muted">{email.excerpt}</p>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {email.hasAiDraft ? <Badge variant="secondary">AI 초안</Badge> : null}
                    <Badge variant={email.status === "new" ? "default" : "outline"}>
                      {statusLabels[email.status] ?? email.status}
                    </Badge>
                    <span className="text-xs text-content-muted">{formatDate(email.createdAt)}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <InboxDetailModal
        eventId={eventId}
        emailId={openId}
        open={openId !== null}
        onClose={() => setOpenId(null)}
        onStatusChange={handleStatusChange}
      />
    </div>
  );
}
