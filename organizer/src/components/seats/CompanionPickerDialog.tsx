"use client";

/**
 * CompanionPickerDialog — 트랙 1.8 친구 함께 예매
 *
 * 사용자가 인원 수(2~10)를 입력하면 group-allocator API 가 인접한 좌석을
 * all-win-or-all-lose 로 hold 한다. 결과 좌석 IDs 를 부모에게 전달.
 */

import React, { useState } from "react";
import { Users } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { showError, showSuccess } from "@/lib/hooks/useToast";
import { bookCompanionSeats, type CompanionResult } from "@/lib/seats/client";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  eventSlug: string;
  /** 사용자가 미리 선택한 등급 (옵션) */
  tierId?: string;
  onAllocated: (result: CompanionResult) => void;
}

export function CompanionPickerDialog({
  open,
  onOpenChange,
  eventSlug,
  tierId,
  onAllocated,
}: Props) {
  const [size, setSize] = useState<number>(2);
  const [loading, setLoading] = useState(false);

  async function handleConfirm() {
    if (size < 2 || size > 10) {
      showError("인원은 2명 이상 10명 이하로 입력해주세요");
      return;
    }
    setLoading(true);
    try {
      const result = await bookCompanionSeats(eventSlug, size, tierId);
      showSuccess(`${result.seatIds.length}석을 한 번에 잠갔습니다`);
      onAllocated(result);
      onOpenChange(false);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "친구 함께 예매 실패");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="size-5 text-primary" aria-hidden />
            친구와 함께 예매
          </DialogTitle>
          <DialogDescription>
            인원 수를 입력하면 인접한 좌석을 한 번에 잡아드립니다. 같은 행에서 연달아
            앉을 수 없는 경우 자동으로 실패하고 좌석은 잠기지 않습니다 (전부 또는
            전무).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block text-sm font-medium text-foreground">
            인원 수
          </label>
          <Input
            type="number"
            min={2}
            max={10}
            value={size}
            onChange={(e) => setSize(Number(e.target.value))}
            disabled={loading}
            aria-label="함께 예매할 인원 수"
          />
          <p className="text-xs text-muted-foreground">
            • 최소 2명, 최대 10명 (등급별 상한 다를 수 있음)
            <br />• 인접 좌석을 찾지 못하면 즉시 실패합니다
          </p>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            취소
          </Button>
          <Button type="button" onClick={() => void handleConfirm()} disabled={loading}>
            {loading ? "추천 중..." : "함께 예매"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
