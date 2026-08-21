import { CheckCircle2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate } from "@/lib/format";
import type { RaffleDraw } from "./types";
import { WinningNumbers } from "./winning-numbers";

// 방금 실행한 추첨 결과 강조 카드 — 당첨 경품번호 목록.
export function DrawResult({ draw }: { draw: RaffleDraw }) {
  return (
    <Card className="border-2 border-success/50 bg-success/5">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <CheckCircle2 className="size-5 text-success" />
          추첨 완료 · 당첨 {draw.winningNumbers.length}건
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-content-subtle">공개 시드</dt>
            <dd className="mt-0.5 break-all font-medium text-foreground">{draw.seed}</dd>
          </div>
          <div>
            <dt className="text-content-subtle">추첨 대상(풀)</dt>
            <dd className="mt-0.5 font-medium text-foreground">{draw.poolSize}명</dd>
          </div>
          <div>
            <dt className="text-content-subtle">요청 당첨 수</dt>
            <dd className="mt-0.5 font-medium text-foreground">{draw.winnerCount}</dd>
          </div>
          <div>
            <dt className="text-content-subtle">실행 시각</dt>
            <dd className="mt-0.5 font-medium text-foreground">{formatDate(draw.executedAt)}</dd>
          </div>
        </dl>
        <div className="space-y-2">
          <p className="text-sm font-semibold text-foreground">당첨 경품번호</p>
          <WinningNumbers numbers={draw.winningNumbers} />
          <p className="text-xs text-content-subtle">
            ※ 당첨자 신원(이름/연락처) 매핑은 아직 제공되지 않습니다. 현재는 당첨 경품번호만 표시됩니다.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
