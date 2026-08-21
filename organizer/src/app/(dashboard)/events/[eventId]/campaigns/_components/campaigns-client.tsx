"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useConfirmAction } from "@/lib/hooks/useConfirmAction";
import { Mail, Plus, Send, BarChart3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { EmptyState } from "@/components/shared/empty-state";
import { fetchWithAuth } from "@/lib/fetchWithAuth";
import { showError, showSuccess } from "@/lib/hooks/useToast";
import { formatDate } from "@/lib/format";
import { CampaignComposer } from "./campaign-composer";

interface Campaign {
  id: string;
  subject: string;
  status: string;
  stats: { sent: number; opened: number; clicked: number; bounced: number };
  scheduledAt: string | null;
  sentAt: string | null;
  createdAt: string;
}

export function CampaignsClient({ eventId }: { eventId: string }) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [sendingCampaignId, setSendingCampaignId] = useState<string | null>(null);
  const [recipientCount, setRecipientCount] = useState<number | null>(null);
  const [recipientLoading, setRecipientLoading] = useState(false);
  const dryRunTargetRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchWithAuth<{ data: Campaign[] }>(`/api/events/${eventId}/campaigns`);
      setCampaigns(res.data ?? []);
    } catch (err: unknown) {
      if (err instanceof Error) showError(err.message);
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => { void load(); }, [load]);

  async function openSendDialog(campaignId: string) {
    setSendingCampaignId(campaignId);
    dryRunTargetRef.current = campaignId;
    setRecipientCount(null);
    setRecipientLoading(true);
    try {
      const res = await fetchWithAuth<{ data: { recipientCount: number } }>(
        `/api/events/${eventId}/campaigns/${campaignId}/send?dryRun=true`,
        { method: "POST" },
      );
      // 연속 클릭 가드: 응답 도착 시점에 다른 캠페인이 선택돼 있으면 무시 —
      // 늦게 온 A 의 수신자 수가 B 다이얼로그에 표시되는 오염 방지.
      if (dryRunTargetRef.current !== campaignId) return;
      setRecipientCount(res.data?.recipientCount ?? null);
    } catch {
      // dryRun 실패 시 폴백 — recipientCount null 유지
    } finally {
      if (dryRunTargetRef.current === campaignId) setRecipientLoading(false);
    }
  }

  async function handleSend(campaignId: string) {
    try {
      // M-06: API 는 {queued, scheduled, recipientCount} 를 반환한다(즉시발송은 cron-drain 이라
      // 이 시점 sent 아님). 잘못 sent 를 읽어 "0명 발송" 으로 오표시하던 버그 수정.
      const res = await fetchWithAuth<{
        data: { queued: number; scheduled: boolean; recipientCount: number };
      }>(`/api/events/${eventId}/campaigns/${campaignId}/send`, { method: "POST" });
      const d = res.data;
      if (d?.scheduled) {
        showSuccess(`${d.recipientCount ?? 0}명 대상으로 예약되었습니다`);
      } else {
        showSuccess(`${d?.recipientCount ?? 0}명에게 발송을 시작했습니다 (곧 전송됩니다)`);
      }
      await load();
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "발송 실패");
    }
  }

  const statusLabels: Record<string, string> = {
    draft: "초안",
    scheduled: "예약됨",
    sending: "발송 중",
    sent: "발송 완료",
    sent_with_failures: "일부 실패",
    failed: "실패",
  };

  // 확인 버튼 잠금 + 재진입 차단 + 실패 시 해제 (S3).
  // 종전엔 `void fn(); setTarget(null)` 라 **요청이 끝나기 전에 창이 닫혔다** —
  // 그 상태로 pending 을 넘겨봐야 보이지도 않는다. 끝난 뒤 닫도록 바꿨다.
  const sendAction = useConfirmAction(async () => {
    if (!sendingCampaignId) return;
    await handleSend(sendingCampaignId);
    setSendingCampaignId(null);
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-sm text-content-subtle">소통 허브 · 마케팅</p>
          <div className="mt-2 flex items-center gap-4">
            <h2 className="text-3xl font-black tracking-[-0.04em] text-foreground">이메일 캠페인</h2>
            <a href={`/events/${eventId}/messages`} className="text-sm font-medium text-content-muted hover:text-foreground">
              ← 메시지(단건/단체)
            </a>
          </div>
          <p className="mt-1 text-xs text-content-muted">대량 이메일 뉴스레터. 오픈·클릭은 실측(트래킹 픽셀·링크)입니다.</p>
        </div>
        <Button onClick={() => setShowCreate(!showCreate)}>
          <Plus className="size-4" />
          새 캠페인
        </Button>
      </div>

      {showCreate ? (
        <CampaignComposer
          eventId={eventId}
          onCreated={() => { setShowCreate(false); void load(); }}
          onCancel={() => setShowCreate(false)}
        />
      ) : null}

      {campaigns.length === 0 && !loading ? (
        <EmptyState
          icon={Mail}
          title="캠페인이 없습니다"
          description="이메일 캠페인을 만들어 참석자에게 소식을 전달하세요."
        />
      ) : (
        <div className="space-y-4">
          {campaigns.map((campaign) => (
            <Card key={campaign.id}>
              <CardContent className="flex items-center justify-between p-5">
                <div className="space-y-1">
                  <p className="font-semibold text-foreground">{campaign.subject}</p>
                  <div className="flex items-center gap-3 text-sm text-content-subtle">
                    <Badge
                      variant={
                        campaign.status === "sent"
                          ? "default"
                          : campaign.status === "sent_with_failures"
                            ? "warning"
                            : campaign.status === "failed"
                              ? "destructive"
                              : "outline"
                      }
                    >
                      {statusLabels[campaign.status] ?? campaign.status}
                    </Badge>
                    <span>{formatDate(campaign.createdAt)}</span>
                    {campaign.status === "sent" && (
                      <span className="flex items-center gap-1">
                        <BarChart3 className="size-3" />
                        발송 {campaign.stats?.sent ?? 0} · 오픈 {campaign.stats?.opened ?? 0} · 클릭 {campaign.stats?.clicked ?? 0}
                      </span>
                    )}
                  </div>
                </div>
                {campaign.status === "draft" && (
                  <Button size="sm" onClick={() => void openSendDialog(campaign.id)}>
                    <Send className="size-4" />
                    발송
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={Boolean(sendingCampaignId)}
        title="캠페인을 발송하시겠습니까?"
        description={
          recipientLoading
            ? "수신자 확인 중…"
            : recipientCount !== null
              ? `${recipientCount}명의 참석자에게 이메일이 발송됩니다. 발송 후에는 취소할 수 없습니다.`
              : "모든 참석자에게 이메일이 발송됩니다. 발송 후에는 취소할 수 없습니다."
        }
        confirmText="발송하기"
        pending={sendAction.pending}
        onConfirm={sendAction.run}
        onOpenChange={(open) => {
          if (!open) {
            setSendingCampaignId(null);
            setRecipientCount(null);
          }
        }}
      />
    </div>
  );
}
