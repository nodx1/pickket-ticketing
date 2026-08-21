"use client";

import { useCallback, useEffect, useState } from "react";
import { Send } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { showError, showSuccess } from "@/lib/hooks/useToast";
import { fetchWithRefresh } from "@/lib/fetchWithAuth";

interface WebhookLog {
  id: string;
  eventType: string;
  responseStatus: number | null;
  responseBody: string | null;
  createdAt: string;
}

interface WebhookDetail {
  id: string;
  name: string;
  endpointUrl: string;
  status: string;
  subscribedEvents: string[];
  logs: WebhookLog[];
}

function statusVariant(status: number | null): "success" | "warning" | "destructive" | "secondary" {
  if (status === null) return "secondary";
  if (status >= 200 && status < 300) return "success";
  if (status >= 400 && status < 500) return "warning";
  if (status >= 500 || status === 0) return "destructive";
  return "secondary";
}

export function WebhookDetailDrawer({
  eventId,
  webhookId,
  onClose,
}: {
  eventId: string;
  webhookId: string | null;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<WebhookDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    if (!webhookId) return;
    setLoading(true);
    setError(false);
    try {
      const response = await fetchWithRefresh(`/api/events/${eventId}/webhooks/${webhookId}`, { credentials: "include" });
      if (!response.ok) throw new Error("불러오지 못했습니다");
      const payload = (await response.json()) as { data?: WebhookDetail };
      setDetail(payload.data ?? null);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [eventId, webhookId]);

  useEffect(() => {
    if (webhookId) void load();
    else setDetail(null);
  }, [webhookId, load]);

  async function sendTest() {
    if (!webhookId) return;
    setSending(true);
    try {
      const response = await fetchWithRefresh(`/api/events/${eventId}/webhooks/${webhookId}/test`, {
        method: "POST",
        credentials: "include",
      });
      const payload = (await response.json().catch(() => null)) as
        | { data?: { queued?: boolean; deliveryId?: string }; error?: string }
        | null;
      if (!response.ok) {
        showError(payload?.error ?? "테스트 발송에 실패했습니다");
        return;
      }
      showSuccess(payload?.data?.queued
        ? "테스트 발송을 큐에 넣었습니다"
        : "동일한 테스트 발송이 이미 처리 중입니다");
      await load();
    } catch (err) {
      showError(err instanceof Error ? err.message : "테스트 발송에 실패했습니다");
    } finally {
      setSending(false);
    }
  }

  return (
    <Sheet open={webhookId !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="right" className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>배송 로그</SheetTitle>
        </SheetHeader>

        {loading ? (
          <p className="py-8 text-center text-sm text-content-subtle">불러오는 중…</p>
        ) : error ? (
          <div className="py-8 text-center">
            <p className="text-sm text-content-subtle">웹훅 정보를 불러오지 못했습니다.</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => void load()}>다시 시도</Button>
          </div>
        ) : detail ? (
          <div className="space-y-5">
            <div className="space-y-1 rounded-lg border border-border bg-bg-muted p-3">
              <p className="text-sm font-semibold text-foreground">{detail.name}</p>
              <p className="break-all text-xs text-content-muted">{detail.endpointUrl}</p>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Badge variant={detail.status === "active" ? "success" : "secondary"}>
                  {detail.status === "active" ? "활성" : "비활성"}
                </Badge>
                {detail.subscribedEvents.map((ev) => (
                  <Badge key={ev} variant="outline">{ev}</Badge>
                ))}
              </div>
            </div>

            <Button onClick={() => void sendTest()} disabled={sending} className="w-full">
              <Send className="size-4" />
              {sending ? "발송 중…" : "테스트 발송"}
            </Button>

            <div className="space-y-2">
              <p className="text-sm font-semibold text-foreground">최근 배송 (최대 5건)</p>
              {detail.logs.length === 0 ? (
                <p className="rounded-lg border border-border bg-card p-4 text-center text-sm text-content-subtle">
                  아직 배송 기록이 없습니다.
                </p>
              ) : (
                <ul className="space-y-2">
                  {detail.logs.map((log) => (
                    <li key={log.id} className="rounded-lg border border-border bg-card p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium text-foreground">{log.eventType}</span>
                        <Badge variant={statusVariant(log.responseStatus)}>
                          {log.responseStatus === null ? "미기록" : log.responseStatus === 0 ? "실패" : log.responseStatus}
                        </Badge>
                      </div>
                      <p className="mt-1 text-xs text-content-muted">
                        {new Date(log.createdAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}
                      </p>
                      {log.responseBody ? (
                        <details className="mt-2">
                          <summary className="cursor-pointer text-xs text-content-subtle">응답 본문</summary>
                          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-bg-muted p-2 text-[11px] text-content-subtle">
                            {log.responseBody}
                          </pre>
                        </details>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
