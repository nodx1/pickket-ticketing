"use client";

import { Gift, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface DrawFormProps {
  seed: string;
  count: string;
  drawKey: string;
  drawing: boolean;
  onSeedChange: (value: string) => void;
  onCountChange: (value: string) => void;
  onDrawKeyChange: (value: string) => void;
  onSubmit: () => void;
}

// 추첨 실행 입력: 공개 시드(재현 근거)·당첨 수·멱등 키(이중추첨 방지, 선택).
export function DrawForm({
  seed,
  count,
  drawKey,
  drawing,
  onSeedChange,
  onCountChange,
  onDrawKeyChange,
  onSubmit,
}: DrawFormProps) {
  const parsedCount = Number(count);
  const canSubmit =
    !drawing && seed.trim().length > 0 && Number.isInteger(parsedCount) && parsedCount >= 1;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <Gift className="size-5 text-primary" />
          추첨 실행
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="raffle-seed">공개 시드</Label>
          <Input
            id="raffle-seed"
            value={seed}
            onChange={(e) => onSeedChange(e.target.value)}
            placeholder="예: 방송 추첨 시드 2026-07-21"
            maxLength={256}
          />
          <p className="text-xs text-content-subtle">
            같은 시드·같은 대상이면 항상 같은 결과가 나옵니다(재현 가능). 공개적으로 정한 값을 입력하세요.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="raffle-count">당첨 수</Label>
          <Input
            id="raffle-count"
            type="number"
            min={1}
            step={1}
            value={count}
            onChange={(e) => onCountChange(e.target.value)}
            placeholder="예: 10"
            className="w-full sm:w-40"
          />
          <p className="text-xs text-content-subtle">
            추첨 대상(체크인 완료자)보다 크면 자동으로 대상 수만큼 당첨됩니다.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="raffle-draw-key">추첨 키 (선택)</Label>
          <Input
            id="raffle-draw-key"
            value={drawKey}
            onChange={(e) => onDrawKeyChange(e.target.value)}
            placeholder="예: main-prize (같은 키 재실행 = 같은 추첨)"
            maxLength={128}
          />
          <div className="flex items-start gap-2 rounded-lg border border-border-subtle bg-bg-muted px-3 py-2 text-xs text-content-subtle">
            <Info className="mt-0.5 size-3.5 shrink-0" />
            <span>
              같은 추첨 키로 다시 실행하면 기존 결과가 그대로 재생됩니다(이중 추첨 방지). 새 추첨을 원하면
              키를 비우거나 다른 키를 사용하세요.
            </span>
          </div>
        </div>

        <Button onClick={onSubmit} disabled={!canSubmit} className="w-full sm:w-auto">
          {drawing ? "추첨 실행 중..." : "추첨 실행"}
        </Button>
      </CardContent>
    </Card>
  );
}
