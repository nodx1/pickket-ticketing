"use client";

import { useEffect, useState } from "react";
import { Mail, Send } from "lucide-react";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { showError, showSuccess } from "@/lib/hooks/useToast";
import { CHANNEL_LABELS, STATUS_LABELS } from "./message-labels";
import { MessageComposer } from "./message-composer";
import { fetchWithRefresh } from "@/lib/fetchWithAuth";

interface MessageItem {
  id: string;
  title: string;
  channel: "email" | "sms" | "alimtalk";
  status: "draft" | "scheduled" | "queued" | "sending" | "sent" | "failed";
  sentCount: number;
  failedCount: number;
  deliveredCount?: number;
  openedCount?: number;
  clickedCount?: number;
  scheduledAt?: string | null;
  sentAt: string | null;
}

interface DeliveryRow {
  contact: string;
  status: string;
  reason: string | null;
  channel: string;
  deliveredAt: string | null;
  openedAt: string | null;
  clickedAt: string | null;
}
interface DeliverySummary {
  total: number; sent: number; delivered: number; failed: number; skipped: number; opened: number; clicked: number;
}

export function MessagesClient({ eventId }: { eventId: string }) {
  const [items, setItems] = useState<MessageItem[]>([]);
  const [open, setOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailRows, setDetailRows] = useState<DeliveryRow[]>([]);
  const [detailSummary, setDetailSummary] = useState<DeliverySummary | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    let isMounted = true;
    async function load() {
      try {
        const response = await fetchWithRefresh(`/api/events/${eventId}/messages`, { credentials: "include" });
        if (!response.ok) {
          console.warn("메시지 목록 로드 실패:", response.status);
          return;
        }
        const payload = (await response.json()) as { data?: MessageItem[] };
        if (isMounted) setItems(payload.data ?? []);
      } catch (err: unknown) {
        console.warn("메시지 목록 로드 오류:", err instanceof Error ? err.message : err);
      }
    }
    void load();
    return () => {
      isMounted = false;
    };
  }, [eventId]);

  async function refresh() {
    const response = await fetchWithRefresh(`/api/events/${eventId}/messages`, { credentials: "include" });
    const payload = (await response.json()) as { data?: MessageItem[] };
    setItems(payload.data ?? []);
  }

  async function resendMessage(id: string) {
    const res = await fetchWithRefresh(`/api/events/${eventId}/messages/${id}/resend`, { method: "POST", credentials: "include" });
    if (res.ok) {
      showSuccess("실패분 재발송을 대기열에 추가했습니다");
      await refresh();
    } else {
      showError("재발송에 실패했습니다");
    }
  }

  // 발송 상세 — 수신자별 도달/오픈/클릭.
  async function openDetail(id: string) {
    setDetailId(id);
    setDetailLoading(true);
    setDetailRows([]);
    setDetailSummary(null);
    try {
      const res = await fetchWithRefresh(`/api/events/${eventId}/messages/${id}/deliveries`, { credentials: "include" });
      if (res.ok) {
        const { data } = (await res.json()) as { data: { items: DeliveryRow[]; summary: DeliverySummary | null } };
        setDetailRows(data.items ?? []);
        setDetailSummary(data.summary ?? null);
      }
    } finally {
      setDetailLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-muted-foreground">소통 허브</p>
          <div className="mt-2 flex items-center gap-4">
            <h2 className="text-3xl font-black tracking-[-0.04em] text-foreground">메시지</h2>
            <a href={`/events/${eventId}/campaigns`} className="text-sm font-medium text-content-muted hover:text-foreground">
              이메일 캠페인 →
            </a>
          </div>
          <p className="mt-1 text-xs text-content-muted">이메일·SMS·알림톡 단건/단체 발송. 대량 이메일 뉴스레터는 캠페인에서.</p>
        </div>
        <Button onClick={() => setOpen(true)}>
          <Send className="size-4" />
          메시지 보내기
        </Button>
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={Mail}
          title="발송된 메시지가 없습니다"
          description="체크인 안내, 리마인드, 운영 공지를 이곳에서 한 번에 발송할 수 있습니다."
          actionLabel="메시지 보내기"
          onAction={() => setOpen(true)}
        />
      ) : (
        <div className="space-y-4">
          {items.map((item) => (
            <Card key={item.id}>
              <CardHeader className="flex-row items-center justify-between gap-4">
                <div>
                  <CardTitle className="text-foreground">{item.title}</CardTitle>
                  <div className="mt-2 flex items-center gap-2">
                    <Badge>{CHANNEL_LABELS[item.channel] ?? item.channel}</Badge>
                    <Badge variant={item.status === "sent" ? "success" : item.status === "failed" ? "warning" : "secondary"}>
                      {STATUS_LABELS[item.status] ?? item.status}
                    </Badge>
                  </div>
                </div>
                <div className="flex items-center gap-3 text-sm text-muted-foreground">
                  <div className="text-right">
                    <div>{item.sentCount}건 성공 / {item.failedCount}건 실패</div>
                    {item.channel === "email" && item.sentCount > 0 ? (
                      <div className="mt-0.5 text-xs text-content-muted">
                        도달 {item.deliveredCount ?? 0} · 오픈 {item.openedCount ?? 0} · 클릭 {item.clickedCount ?? 0}
                      </div>
                    ) : null}
                    {item.status === "scheduled" && item.scheduledAt ? (
                      <div className="mt-0.5 text-xs text-primary">
                        예약: {new Date(item.scheduledAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}
                      </div>
                    ) : null}
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => void openDetail(item.id)}>
                    상세
                  </Button>
                  {item.failedCount > 0 && item.status !== "queued" && item.status !== "sending" ? (
                    <Button variant="outline" size="sm" onClick={() => void resendMessage(item.id)}>
                      실패분 재발송
                    </Button>
                  ) : null}
                </div>
              </CardHeader>
            </Card>
          ))}
        </div>
      )}

      <MessageComposer eventId={eventId} open={open} onOpenChange={setOpen} onSent={() => void refresh()} />

      <Dialog open={detailId !== null} onOpenChange={(o) => { if (!o) setDetailId(null); }}>
        <DialogContent>
          <DialogHeader className="flex-row items-center justify-between">
            <DialogTitle>발송 상세</DialogTitle>
            {detailId ? (
              <a
                href={`/api/events/${eventId}/messages/${detailId}/deliveries?format=csv`}
                className="mr-6 rounded-lg border border-border px-3 py-1 text-xs text-foreground hover:bg-bg-subtle"
              >
                CSV 내보내기
              </a>
            ) : null}
          </DialogHeader>
          {detailLoading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">불러오는 중…</p>
          ) : (
            <div className="space-y-4">
              {detailSummary ? (
                <div className="grid grid-cols-3 gap-2 text-center sm:grid-cols-6">
                  {[
                    { l: "대상", v: detailSummary.total },
                    { l: "성공", v: detailSummary.sent },
                    { l: "도달", v: detailSummary.delivered },
                    { l: "오픈", v: detailSummary.opened },
                    { l: "클릭", v: detailSummary.clicked },
                    { l: "실패", v: detailSummary.failed },
                  ].map((s) => (
                    <div key={s.l} className="rounded-lg border border-border bg-muted/40 p-2">
                      <div className="text-lg font-bold text-foreground">{s.v}</div>
                      <div className="text-[11px] text-content-muted">{s.l}</div>
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="max-h-72 space-y-1 overflow-y-auto">
                {detailRows.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">아직 발송 기록이 없습니다.</p>
                ) : (
                  detailRows.map((r, i) => (
                    <div key={`${r.contact}-${i}`} className="flex items-center justify-between rounded-md border border-border px-3 py-1.5 text-xs">
                      <span className="text-foreground">{r.contact}</span>
                      <span className="flex items-center gap-2 text-content-muted">
                        <Badge variant={r.status === "delivered" || r.status === "sent" ? "success" : r.status === "failed" ? "warning" : "secondary"}>
                          {STATUS_LABELS[r.status] ?? r.status}
                        </Badge>
                        {r.openedAt ? <span className="text-primary">오픈</span> : null}
                        {r.clickedAt ? <span className="text-primary">클릭</span> : null}
                        {r.reason ? <span className="text-content-muted">{r.reason}</span> : null}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
