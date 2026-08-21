"use client";

import type { Dispatch, SetStateAction } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatDate, formatKRW } from "@/lib/format";
import { EVENT_STATUS_LABELS } from "@/lib/constants";
import type { BankForm, EventOption, SettlementRow } from "./settlement-types";

interface SettlementDialogsProps {
  // 정산 마감
  finalizeOpen: boolean;
  setFinalizeOpen: (open: boolean) => void;
  events: EventOption[];
  selectedEventIds: Set<string>;
  setSelectedEventIds: Dispatch<SetStateAction<Set<string>>>;
  finalizing: boolean;
  onFinalize: () => void;
  // 입금 완료
  completeTarget: SettlementRow | null;
  setCompleteTarget: (row: SettlementRow | null) => void;
  completing: boolean;
  bankForm: BankForm;
  setBankForm: Dispatch<SetStateAction<BankForm>>;
  onComplete: () => void;
}

export function SettlementDialogs({
  finalizeOpen,
  setFinalizeOpen,
  events,
  selectedEventIds,
  setSelectedEventIds,
  finalizing,
  onFinalize,
  completeTarget,
  setCompleteTarget,
  completing,
  bankForm,
  setBankForm,
  onComplete,
}: SettlementDialogsProps) {
  return (
    <>
      {/* 정산 마감 모달 */}
      <Dialog open={finalizeOpen} onOpenChange={setFinalizeOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>정산 마감</DialogTitle>
            <DialogDescription>
              마감할 이벤트를 선택하세요. v2 에서 현재까지 누적 매출/수수료/환불 집계를 받아서 정산 row 를
              생성합니다. 이미 마감된 이벤트는 갱신됩니다 (입금 완료된 건 제외).
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-80 overflow-y-auto rounded-lg border border-border">
            {events.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">불러올 이벤트가 없습니다.</p>
            ) : (
              <ul className="divide-y divide-border">
                {events.map((ev) => {
                  const checked = selectedEventIds.has(ev.id);
                  return (
                    <li key={ev.id} className="flex items-center gap-3 p-3">
                      <input
                        type="checkbox"
                        id={`ev-${ev.id}`}
                        checked={checked}
                        onChange={(e) => {
                          setSelectedEventIds((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(ev.id);
                            else next.delete(ev.id);
                            return next;
                          });
                        }}
                      />
                      <label
                        htmlFor={`ev-${ev.id}`}
                        className="flex flex-1 cursor-pointer items-center justify-between text-sm"
                      >
                        <span>{ev.title}</span>
                        <span className="text-xs text-muted-foreground">
                          {ev.endsAt ? formatDate(ev.endsAt) : "종료일 미정"} · {EVENT_STATUS_LABELS[ev.status as keyof typeof EVENT_STATUS_LABELS] ?? ev.status}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setFinalizeOpen(false)} disabled={finalizing}>
              취소
            </Button>
            <Button onClick={onFinalize} disabled={finalizing}>
              {finalizing ? "처리 중..." : `${selectedEventIds.size}건 마감`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 입금 완료 모달 */}
      <Dialog open={!!completeTarget} onOpenChange={(o) => !o && setCompleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>입금 완료 처리</DialogTitle>
            <DialogDescription>
              이 정산 건의 입금을 완료 처리합니다. 은행 정보를 입력해주세요. 완료 후에는 상태를 되돌릴 수 없습니다.
            </DialogDescription>
          </DialogHeader>
          {completeTarget && (
            <div className="space-y-4">
              <div className="rounded-lg bg-muted p-4 text-sm">
                <p>
                  <span className="text-muted-foreground">이벤트:</span>{" "}
                  {completeTarget.eventTitle ?? "(없음)"}
                </p>
                <p>
                  <span className="text-muted-foreground">입금 예정액:</span>{" "}
                  <span className="font-bold">{formatKRW(Number(completeTarget.netAmount))}</span>
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="bank-name">은행명</Label>
                <Input
                  id="bank-name"
                  value={bankForm.bankName}
                  onChange={(e) => setBankForm((p) => ({ ...p, bankName: e.target.value }))}
                  placeholder="예: 국민은행"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="bank-account">계좌번호</Label>
                <Input
                  id="bank-account"
                  value={bankForm.bankAccount}
                  onChange={(e) => setBankForm((p) => ({ ...p, bankAccount: e.target.value }))}
                  placeholder="예: 123-456-789012"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="bank-holder">예금주</Label>
                <Input
                  id="bank-holder"
                  value={bankForm.bankHolder}
                  onChange={(e) => setBankForm((p) => ({ ...p, bankHolder: e.target.value }))}
                  placeholder="예: 홍길동"
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCompleteTarget(null)} disabled={completing}>
              취소
            </Button>
            <Button onClick={onComplete} disabled={completing}>
              {completing ? "처리 중..." : "입금 완료"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
