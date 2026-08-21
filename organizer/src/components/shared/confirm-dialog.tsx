"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  /**
   * 🔴 진행 중 표시 — 켜지면 확인 버튼이 잠기고 문구가 바뀐다 (2026-07-29 감사).
   *
   * 이 다이얼로그는 **환불처럼 돈이 나가는 동작**을 확정하는 데 쓰이는데, 종전에는
   * 확인 버튼에 `disabled` 자체가 없어 응답이 느리면 **몇 번이든 다시 눌렸다**.
   * v2 의 멱등 캐시는 성공 응답만 저장하고 **선점 락이 없어서**(`_idempotent` 주석),
   * 같은 멱등키의 두 요청이 나란히 들어가면 `FOR UPDATE` 는 직렬화만 할 뿐
   * 2차가 갱신된 잔여액으로 재검증을 통과해 **같은 금액을 한 번 더 집행**한다
   * (10,000원 부분환불 1회 지시 → 20,000원 환불).
   *
   * 클라이언트 자동 재시도는 이미 `retries: 0` 으로 막혀 있었지만
   * **사람이 두 번 누르는 경로**는 열려 있었다. 이 prop 이 그 경로를 닫는다.
   * (근본 해결인 서버 선점 락은 별건 — 이건 마지막 방어선이 아니라 첫 방어선이다.)
   */
  pending?: boolean;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmText = "확인",
  cancelText = "취소",
  onConfirm,
  onOpenChange,
  pending = false,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription asChild>
            <div>{description}</div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            {cancelText}
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={pending}>
            {pending ? "처리 중..." : confirmText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
