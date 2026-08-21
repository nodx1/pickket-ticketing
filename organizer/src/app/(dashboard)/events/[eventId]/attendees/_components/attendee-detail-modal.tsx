"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { fetchWithAuth } from "@/lib/fetchWithAuth";
import { formatDate } from "@/lib/format";
import { showError } from "@/lib/hooks/useToast";

interface AttendeeDetailModalProps {
  eventId: string;
  attendeeId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface AttendeeDetailResponse {
  data: {
    ticketNumber: string;
    name: string;
    email: string | null;
    phone: string | null;
    status: "pending" | "confirmed" | "cancelled" | "checked_in";
    orderId: string;
    orderNumber: string;
    productName: string;
    checkInLogs: Array<{
      id: string;
      method: string;
      note: string | null;
      createdAt: string;
      listName: string | null;
    }>;
    questionAnswers: Array<{
      id: string;
      questionLabel: string;
      answer: string;
    }>;
  };
}

export function AttendeeDetailModal({ eventId, attendeeId, open, onOpenChange }: AttendeeDetailModalProps) {
  const [detail, setDetail] = useState<AttendeeDetailResponse["data"] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !attendeeId) {
      return;
    }

    setDetail(null);
    setLoading(true);
    let active = true;
    async function loadDetail() {
      try {
        const payload = await fetchWithAuth<AttendeeDetailResponse>(`/api/events/${eventId}/attendees/${attendeeId}`);
        if (active) {
          setDetail(payload.data);
        }
      } catch (err: unknown) {
        if (err instanceof Error) {
          showError(err.message);
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadDetail();
    return () => {
      active = false;
    };
  }, [attendeeId, eventId, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>참석자 상세</DialogTitle>
        </DialogHeader>
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="size-8 animate-spin text-primary" />
          </div>
        ) : detail ? (
          <div className="space-y-6">
            <div className="grid gap-4 md:grid-cols-2">
              <InfoItem label="이름" value={detail.name} />
              <InfoItem label="이메일" value={detail.email || "-"} />
              <InfoItem label="전화번호" value={detail.phone || "-"} />
              <InfoItem label="티켓 코드" value={detail.ticketNumber} />
              <InfoItem label="상품" value={detail.productName} />
              <div>
                <p className="text-sm text-muted-foreground">상태</p>
                <Badge className="mt-2" variant={detail.status === "checked_in" ? "success" : "secondary"}>
                  {detail.status === "checked_in" ? "체크인" : detail.status === "cancelled" ? "취소" : "확정"}
                </Badge>
              </div>
            </div>

            <div className="rounded-lg border border-border bg-muted p-4">
              <p className="text-sm text-muted-foreground">주문 정보</p>
              <Link href={`/events/${eventId}/orders/${detail.orderId}`} className="mt-2 inline-flex font-semibold text-primary">
                {detail.orderNumber}
              </Link>
            </div>

            <section className="space-y-3">
              <h3 className="font-semibold text-foreground">질문 답변</h3>
              {detail.questionAnswers.length === 0 ? (
                <p className="text-sm text-muted-foreground">등록된 추가 답변이 없습니다.</p>
              ) : (
                detail.questionAnswers.map((answer) => (
                  <div key={answer.id} className="rounded-lg border border-border bg-muted p-4">
                    <p className="text-sm text-muted-foreground">{answer.questionLabel}</p>
                    <p className="mt-2 text-sm text-foreground">{answer.answer}</p>
                  </div>
                ))
              )}
            </section>

            <section className="space-y-3">
              <h3 className="font-semibold text-foreground">체크인 이력</h3>
              {detail.checkInLogs.length === 0 ? (
                <p className="text-sm text-muted-foreground">체크인 이력이 없습니다.</p>
              ) : (
                detail.checkInLogs.map((log) => (
                  <div key={log.id} className="rounded-lg border border-border bg-muted p-4">
                    <p className="text-sm text-foreground">{formatDate(log.createdAt)}</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {log.listName || "리스트 없음"} · {log.method}
                    </p>
                  </div>
                ))
              )}
            </section>
          </div>
        ) : null}

      </DialogContent>
    </Dialog>
  );
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-2 text-sm text-foreground">{value}</p>
    </div>
  );
}
