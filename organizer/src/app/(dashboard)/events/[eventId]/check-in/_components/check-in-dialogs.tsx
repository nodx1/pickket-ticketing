"use client";

import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface CreateListDialogProps {
  open: boolean;
  name: string;
  creating: boolean;
  onNameChange: (value: string) => void;
  onOpenChange: (open: boolean) => void;
  onSubmit: () => void;
}

export function CreateListDialog({ open, name, creating, onNameChange, onOpenChange, onSubmit }: CreateListDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>체크인 리스트 만들기</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <Label htmlFor="checkin-list-name">리스트 이름</Label>
          <Input
            id="checkin-list-name"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="예: 1회차, VIP 입장, 일반 입장"
            onKeyDown={(e) => { if (e.key === "Enter") onSubmit(); }}
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={creating}>
            취소
          </Button>
          <Button onClick={onSubmit} disabled={creating || !name.trim()}>
            {creating ? "생성 중..." : "만들기"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface UndoDialogProps {
  open: boolean;
  name: string | null;
  attendedDate: string | null;
  reason: string;
  undoing: boolean;
  onReasonChange: (value: string) => void;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
}

// §13 체크인 취소(오스캔 복구) — 스태프 사유 필수.
export function UndoDialog({ open, name, attendedDate, reason, undoing, onReasonChange, onConfirm, onOpenChange }: UndoDialogProps) {
  return (
    <ConfirmDialog
      open={open}
      title="체크인 취소"
      description={
        <div className="space-y-3">
          <p>
            {name ?? "참석자"}
            {attendedDate ? ` (${attendedDate})` : ""} 의 입장을 취소합니다.
            오스캔·테스트 스캔 복구용입니다. 취소 후 재입장이 가능합니다.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="undo-reason">취소 사유</Label>
            <Input
              id="undo-reason"
              value={reason}
              onChange={(e) => onReasonChange(e.target.value)}
              placeholder="예: 잘못된 게이트 스캔, 테스트 스캔"
              autoFocus
            />
          </div>
        </div>
      }
      confirmText={undoing ? "취소 중..." : "체크인 취소"}
      cancelText="닫기"
      // `undoing` 이 진짜 in-flight 플래그다(부모 event-check-in-client.tsx:181/207 에서
      // 요청 전후로 토글). 이미 받고 있었는데 ConfirmDialog 로 안 넘기고 있었다.
      pending={undoing}
      onConfirm={onConfirm}
      onOpenChange={onOpenChange}
    />
  );
}
