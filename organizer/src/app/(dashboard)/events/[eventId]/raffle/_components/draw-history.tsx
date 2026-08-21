import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/format";
import type { RaffleDraw } from "./types";
import { WinningNumbers } from "./winning-numbers";

interface DrawHistoryProps {
  draws: RaffleDraw[];
  loading: boolean;
}

// 추첨 이력(GET draws) — 최신순. 각 행: 시드·풀·당첨 경품번호·시각.
export function DrawHistory({ draws, loading }: DrawHistoryProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">추첨 이력</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <p className="text-sm text-content-subtle">이력을 불러오는 중...</p>
        ) : draws.length === 0 ? (
          <p className="text-sm text-content-subtle">아직 추첨 이력이 없습니다.</p>
        ) : (
          draws.map((draw) => (
            <div key={draw.drawId} className="space-y-3 rounded-lg border border-border bg-bg-muted px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">시드: {draw.seed}</p>
                  <p className="mt-0.5 text-xs text-content-subtle">
                    {formatDate(draw.executedAt)} · 대상 {draw.poolSize}명
                    {draw.drawKey ? ` · 키 ${draw.drawKey}` : ""}
                  </p>
                </div>
                <Badge variant="secondary">당첨 {draw.winningNumbers.length}건</Badge>
              </div>
              <WinningNumbers numbers={draw.winningNumbers} />
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
