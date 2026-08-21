"use client";

import { AlertTriangle, Clock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// §13 QR 창 확대 킬스위치. 기본 tolerance = 1창(±30초 = 총 60초).
// 확대 옵션: 창 개수 → 총 수락 시간(초). 넓힐수록 캡처방지 강도 약화(명시적 트레이드오프).
const OPTIONS: Array<{ windows: number; label: string }> = [
  { windows: 2, label: "총 2분 30초 (±2분)" },
  { windows: 4, label: "총 4분 30초 (±4분)" },
  { windows: 10, label: "총 10분 30초 (±10분)" },
  { windows: 20, label: "총 20분 30초 (±20분)" },
];

interface QrToleranceControlProps {
  enabled: boolean;
  windows: number;
  onEnabledChange: (enabled: boolean) => void;
  onWindowsChange: (windows: number) => void;
}

export function QrToleranceControl({ enabled, windows, onEnabledChange, onWindowsChange }: QrToleranceControlProps) {
  return (
    <Card className={enabled ? "border-2 border-warning/50 bg-warning/5" : undefined}>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="flex items-center gap-2 text-foreground">
          <Clock className="size-4 text-muted-foreground" />
          QR 수락 시간창 확대
        </CardTitle>
        <Switch
          checked={enabled}
          onCheckedChange={onEnabledChange}
          aria-label="QR 수락 시간창 확대"
        />
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          관객 폰이 회전 QR(30초 갱신)을 제때 받지 못할 때(야외·LTE 불안정) 게이트 마비를 막기 위해
          QR 수락 시간창을 넓힙니다. 기본은 총 60초(±30초)입니다.
        </p>
        {enabled ? (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="qr-tolerance-select">수락 시간창</Label>
              <Select
                value={String(windows)}
                onValueChange={(value) => onWindowsChange(Number(value))}
              >
                <SelectTrigger id="qr-tolerance-select" className="w-full sm:w-[260px]">
                  <SelectValue placeholder="시간창 선택" />
                </SelectTrigger>
                <SelectContent>
                  {OPTIONS.map((opt) => (
                    <SelectItem key={opt.windows} value={String(opt.windows)}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>
                시간창이 넓어질수록 회전 QR 캡처방지 강도가 약해집니다. 통신이 안정되면 다시 꺼주세요.
              </span>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
