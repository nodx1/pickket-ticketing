import { Undo2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/format";

// 로그 취소 대상(과거 오스캔 복구). attendeeId 가 있어야 revoke-admission 호출 가능.
export interface CheckInLogCancelTarget {
  attendeeId: string;
  name: string;
  ticketNumber: string;
  attendedDate: string | null;
}

interface CheckInLogProps {
  logs: Array<{
    id: string;
    attendeeId: string | null;
    name: string;
    ticketNumber: string;
    productName: string;
    method: string;
    attendedDate: string | null;
    createdAt: string;
  }>;
  /** 행별 체크인 취소 트리거(사유 입력 다이얼로그로 이어짐). */
  onCancel: (target: CheckInLogCancelTarget) => void;
}

export function CheckInLog({ logs, onCancel }: CheckInLogProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">최근 체크인</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {logs.length === 0 ? (
          <p className="text-sm text-content-subtle">아직 체크인 기록이 없습니다.</p>
        ) : (
          logs.map((log) => (
            <div key={log.id} className="rounded-lg border border-border bg-bg-muted px-4 py-3 text-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-3">
                    <p className="truncate font-medium text-foreground">{log.name}</p>
                    <p className="shrink-0 text-content-subtle">{formatDate(log.createdAt)}</p>
                  </div>
                  <p className="mt-2 text-content-subtle">
                    {log.productName} · {log.ticketNumber} · {log.method}
                    {log.attendedDate ? ` · ${log.attendedDate}` : ""}
                  </p>
                </div>
              </div>
              {log.attendeeId ? (
                <div className="mt-3 flex justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      onCancel({
                        attendeeId: log.attendeeId as string,
                        name: log.name,
                        ticketNumber: log.ticketNumber,
                        attendedDate: log.attendedDate,
                      })
                    }
                  >
                    <Undo2 className="size-4" />
                    체크인 취소
                  </Button>
                </div>
              ) : null}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
