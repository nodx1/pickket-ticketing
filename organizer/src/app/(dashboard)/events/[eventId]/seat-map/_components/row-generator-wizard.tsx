"use client";

/**
 * 트랙 2.4 — 행/열 자동 생성 마법사
 *
 * 행 수, 열 수, 시작 위치, 간격, 곡률을 입력하면 generateRows() 가
 * 좌석 배열을 만들어 visual-builder 의 commit 으로 일괄 추가한다.
 */

import React, { useState } from "react";
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
import { generateRows, type RowWizardConfig, type GeneratedSeat } from "@/lib/builder/row-wizard";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultTierId?: string | null;
  onGenerate: (seats: GeneratedSeat[]) => void;
}

export function RowGeneratorWizard({
  open,
  onOpenChange,
  defaultTierId,
  onGenerate,
}: Props) {
  const [cfg, setCfg] = useState<RowWizardConfig>({
    rows: 5,
    cols: 10,
    startX: 200,
    startY: 150,
    spacingX: 32,
    spacingY: 36,
    arcRadians: 0,
    rowLabel: "letter",
    startSeatNumber: 1,
    defaultTierId: defaultTierId ?? null,
  });

  function update<K extends keyof RowWizardConfig>(
    key: K,
    value: RowWizardConfig[K],
  ) {
    setCfg((prev) => ({ ...prev, [key]: value }));
  }

  function handleConfirm() {
    const seats = generateRows({ ...cfg, defaultTierId });
    onGenerate(seats);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>행/열 자동 생성</DialogTitle>
          <DialogDescription>
            한 번에 여러 행과 열을 생성합니다. 부채꼴 곡률을 주면 무대를 향해
            굽어지는 좌석 배치가 만들어집니다.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <label>
            행 수
            <Input
              type="number"
              min={1}
              max={50}
              value={cfg.rows}
              onChange={(e) => update("rows", Number(e.target.value))}
            />
          </label>
          <label>
            열 수
            <Input
              type="number"
              min={1}
              max={100}
              value={cfg.cols}
              onChange={(e) => update("cols", Number(e.target.value))}
            />
          </label>
          <label>
            시작 X
            <Input
              type="number"
              value={cfg.startX}
              onChange={(e) => update("startX", Number(e.target.value))}
            />
          </label>
          <label>
            시작 Y
            <Input
              type="number"
              value={cfg.startY}
              onChange={(e) => update("startY", Number(e.target.value))}
            />
          </label>
          <label>
            X 간격(px)
            <Input
              type="number"
              value={cfg.spacingX}
              onChange={(e) => update("spacingX", Number(e.target.value))}
            />
          </label>
          <label>
            Y 간격(px)
            <Input
              type="number"
              value={cfg.spacingY}
              onChange={(e) => update("spacingY", Number(e.target.value))}
            />
          </label>
          <label>
            곡률 (0=직선)
            <Input
              type="number"
              step="0.1"
              value={cfg.arcRadians}
              onChange={(e) => update("arcRadians", Number(e.target.value))}
            />
          </label>
          <label>
            시작 좌석 번호
            <Input
              type="number"
              value={cfg.startSeatNumber}
              onChange={(e) => update("startSeatNumber", Number(e.target.value))}
            />
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            취소
          </Button>
          <Button onClick={handleConfirm}>
            {cfg.rows * cfg.cols}석 생성
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
