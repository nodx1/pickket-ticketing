"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatKRW } from "@/lib/format";
import { RefundLandingActions } from "./refund-landing-actions";

export function RefundRequestClient({
  ticket,
  eventSlug,
}: {
  /** 행사 슬러그. 못 알아내면 null — 그때는 행사 버튼을 그리지 않는다. */
  eventSlug?: string | null;
  ticket: {
    ticketNumber: string;
    orderId: string;
    orderNumber: string;
    buyerEmail: string;
    buyerPhone: string | null;
    eventTitle: string;
  };
}) {
  const [step, setStep] = useState(1);
  /** 서버가 즉시 집행했는지("completed") 접수만 했는지("received"). */
  const [outcome, setOutcome] = useState<"completed" | "received">("received");
  const [settledAmount, setSettledAmount] = useState<number | null>(null);
  const [email, setEmail] = useState(ticket.buyerEmail);
  const [phone, setPhone] = useState(ticket.buyerPhone ?? "");
  const [preview, setPreview] = useState<{ refundAmount: number; refundPercent: number; policyLabel: string; canRefund: boolean } | null>(null);
  const [reason, setReason] = useState<"개인사정" | "일정변경" | "기타">("개인사정");
  const [reasonDetail, setReasonDetail] = useState("");
  const [error, setError] = useState<string | null>(null);
  // 더블서밋 방지 — 제출 중 버튼 비활성화 (#10 수정).
  const [submitting, setSubmitting] = useState(false);

  async function handleVerify() {
    const response = await fetch("/api/public/refund/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId: ticket.orderId, email }),
    });
    const payload = (await response.json()) as { data?: { refundAmount: number; refundPercent: number; policyLabel: string; canRefund: boolean }; error?: string };
    if (!response.ok || !payload.data) {
      setError(payload.error ?? "환불 가능 여부를 확인할 수 없습니다");
      return;
    }
    setPreview(payload.data);
    setError(null);
    setStep(2);
  }

  async function handleSubmit() {
    if (submitting) return;
    setSubmitting(true);
    try {
      const response = await fetch("/api/public/refund", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: ticket.orderId, buyerEmail: email, buyerPhone: phone, reason, reasonDetail }),
      });
      const payload = (await response.json()) as {
        error?: string;
        data?: { status?: string; refundAmount?: number };
      };
      if (!response.ok) {
        setError(payload.error ?? "환불 신청에 실패했습니다");
        return;
      }
      setError(null);
      // 🔴 서버가 실제로 무엇을 했는지에 따라 화면이 달라져야 한다 (2026-08-01).
      //    종전엔 무조건 "관리자 확인 후 처리됩니다" 였는데, 실제로는 아무도 그 신청을
      //    보지 않았다(처리 코드도 화면도 없었다). 손님은 오지 않는 처리를 기다렸다.
      setOutcome(payload.data?.status === "completed" ? "completed" : "received");
      setSettledAmount(payload.data?.refundAmount ?? preview?.refundAmount ?? null);
      setStep(4);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-background px-4 py-10">
      <div className="mx-auto max-w-2xl">
        <Card className="border-border bg-card/95">
          <CardHeader>
            <CardTitle className="text-3xl font-black tracking-[-0.04em] text-foreground">환불 신청</CardTitle>
            <p className="text-sm text-muted-foreground">{ticket.eventTitle} · {ticket.orderNumber}</p>
          </CardHeader>
          <CardContent className="space-y-6">
            {step === 1 ? (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>주문번호</Label>
                  <Input value={ticket.orderNumber} disabled />
                </div>
                <div className="space-y-2">
                  <Label>이메일</Label>
                  <Input value={email} onChange={(event) => setEmail(event.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label>전화번호</Label>
                  <Input value={phone} onChange={(event) => setPhone(event.target.value)} />
                </div>
                <div className="flex justify-end">
                  <Button onClick={() => void handleVerify()}>본인 확인</Button>
                </div>
              </div>
            ) : null}

            {step === 2 && preview ? (
              <div className="space-y-4">
                <div className="rounded-lg border border-border bg-muted p-5">
                  <p className="text-sm text-muted-foreground">환불 정책</p>
                  {/* 🔴 하드코딩 금지 (2026-07-31 실사고). 종전엔 `D-10:100%, D-7:90%, D-3:80%,
                      D-1:70%` 가 박혀 있었는데 DB 실값은 D-7 70%/D-3 50% 였다 — 구매자가
                      80% 라고 보고 50% 를 받았다. 서버가 **이 티켓의 실제 환불율**을 계산해
                      내려주므로(`refundPercent`) 그 값만 보여준다. 전체 표를 여기 늘어놓을
                      이유도 없다 — 구매자는 자기 건이 궁금하다. */}
                  <p className="mt-2 text-foreground">
                    환불율 <span className="font-bold">{preview.refundPercent}%</span>
                  </p>
                  <p className="mt-2 text-sm text-primary">{preview.policyLabel}</p>
                  <p className="mt-4 text-2xl font-black text-foreground">{formatKRW(preview.refundAmount)}</p>
                </div>
                <div className="flex justify-end">
                  <Button onClick={() => setStep(3)} disabled={!preview.canRefund}>다음</Button>
                </div>
              </div>
            ) : null}

            {step === 3 ? (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>환불 사유</Label>
                  <select className="w-full rounded-lg border border-border bg-background px-4 py-3 text-sm" value={reason} onChange={(event) => setReason(event.target.value as "개인사정" | "일정변경" | "기타")}>
                    <option value="개인사정">개인사정</option>
                    <option value="일정변경">일정변경</option>
                    <option value="기타">기타</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <Label>상세 사유</Label>
                  <Textarea rows={5} value={reasonDetail} onChange={(event) => setReasonDetail(event.target.value)} />
                </div>
                <div className="flex justify-end">
                  <Button onClick={() => void handleSubmit()} disabled={submitting}>
                    {submitting ? "신청 중..." : "환불 신청"}
                  </Button>
                </div>
              </div>
            ) : null}

            {step === 4 ? (
              <>
                {outcome === "completed" ? (
                  <div className="rounded-lg border border-success/30 bg-success/10 p-6 text-center">
                    <p className="text-lg font-semibold text-foreground">환불이 완료되었습니다</p>
                    <p className="mt-2 text-sm text-foreground">
                      {settledAmount !== null ? `${formatKRW(settledAmount)}이 ` : ""}
                      결제하신 카드로 취소되었습니다.
                    </p>
                    {/* 🔴 카드사 반영 지연을 미리 알린다 — 안 알리면 "환불됐다는데 안 들어왔다"
                        문의가 그대로 들어온다. */}
                    <p className="mt-2 text-xs text-muted-foreground">
                      카드사 반영까지 3~5영업일이 걸릴 수 있습니다.
                    </p>
                  </div>
                ) : (
                  <div className="rounded-lg border border-warning/40 bg-warning/5 p-6 text-center">
                    <p className="text-lg font-semibold text-foreground">환불 신청이 접수되었습니다</p>
                    <p className="mt-2 text-sm text-muted-foreground">
                      확인 후 처리되며, 결과는 별도로 안내드립니다.
                    </p>
                  </div>
                )}

                <RefundLandingActions eventSlug={eventSlug} />
              </>
            ) : null}

            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
