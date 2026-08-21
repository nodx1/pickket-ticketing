"use client";

import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface DrawConfirmDialogProps {
  open: boolean;
  seed: string;
  count: number;
  drawKey: string;
  drawing: boolean;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
}

// 이중추첨 방지 확인 다이얼로그 — 실행 전 시드·당첨 수·재현성 안내.
export function DrawConfirmDialog({ open, seed, count, drawKey, drawing, onConfirm, onOpenChange }: DrawConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!drawing) onOpenChange(next); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-5 text-warning" />
            추첨을 실행할까요?
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-1 text-sm text-content-subtle">
          <p>아래 조건으로 경품 추첨을 실행합니다. 추첨은 되돌릴 수 없으니 시드와 당첨 수를 확인해주세요.</p>
          <ul className="space-y-1.5 rounded-lg border border-border-subtle bg-bg-muted px-4 py-3">
            <li>
              <span className="text-content-muted">공개 시드</span>{" "}
              <span className="break-all font-medium text-foreground">{seed}</span>
            </li>
            <li>
              <span className="text-content-muted">당첨 수</span>{" "}
              <span className="font-medium text-foreground">{count}</span>
            </li>
            <li>
              <span className="text-content-muted">추첨 키</span>{" "}
              <span className="font-medium text-foreground">{drawKey.trim() || "(자동 · 새 추첨)"}</span>
            </li>
          </ul>
          <p className="text-xs">
            같은 시드·같은 대상이면 같은 결과가 재현됩니다. 같은 추첨 키로 재실행하면 기존 결과가 그대로 재생됩니다.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={drawing}>
            취소
          </Button>
          <Button onClick={onConfirm} disabled={drawing}>
            {drawing ? "추첨 실행 중..." : "추첨 실행"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
