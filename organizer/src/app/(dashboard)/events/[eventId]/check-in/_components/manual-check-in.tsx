"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface ManualCheckInProps {
  // §13 수동 체크인은 의도적 스태프 액션 — 티켓번호 + 사유 필수(감사 기록).
  onSubmit: (ticketNumber: string, reason: string) => Promise<void>;
}

export function ManualCheckIn({ onSubmit }: ManualCheckInProps) {
  const [ticketNumber, setTicketNumber] = useState("");
  const [reason, setReason] = useState("");

  const canSubmit = ticketNumber.trim().length > 0 && reason.trim().length > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">수동 체크인 (스태프)</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-3 text-xs text-muted-foreground">
          QR 스캔이 불가한 경우에만 사용하세요. 사유가 감사 로그에 기록됩니다.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSubmit) return;
            void onSubmit(ticketNumber.trim(), reason.trim());
            setTicketNumber("");
            setReason("");
          }}
          className="space-y-3"
        >
          <div className="space-y-1.5">
            <Label htmlFor="manual-ticket-number">티켓번호</Label>
            <Input
              id="manual-ticket-number"
              placeholder="티켓번호를 입력하세요"
              value={ticketNumber}
              onChange={(event) => setTicketNumber(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="manual-reason">사유</Label>
            <Input
              id="manual-reason"
              placeholder="예: QR 미인식, 단말 오류, 고령 관객 지원"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          <Button type="submit" disabled={!canSubmit}>
            수동 체크인
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
