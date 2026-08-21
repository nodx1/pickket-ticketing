"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { PlayCircle, CheckCircle, XCircle, Loader2, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fetchWithAuth } from "@/lib/fetchWithAuth";

interface RehearsalData { status: string; productCount: number; orderCount: number; attendeeCount: number; }
interface RehearsalStep { key: string; label: string; ok: boolean; detail: string; }
interface RehearsalRunResult { steps: RehearsalStep[]; allPassed: boolean; }

export default function RehearsalPage() {
  const { eventId } = useParams<{ eventId: string }>();
  const [data, setData] = useState<RehearsalData | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<RehearsalRunResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetchWithAuth<{ success: boolean; data: RehearsalData }>(`/api/events/${eventId}/rehearsal`);
      if (res.success) setData(res.data);
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [eventId]);

  useEffect(() => { fetch_(); }, [fetch_]);

  const runMock = useCallback(async () => {
    setRunning(true);
    setRunError(null);
    setRunResult(null);
    try {
      const res = await fetchWithAuth<{ success: boolean; data: RehearsalRunResult; error?: string }>(
        `/api/events/${eventId}/rehearsal`,
        { method: "POST" },
      );
      if (res.success) setRunResult(res.data);
      else setRunError(res.error ?? "모의 실행에 실패했습니다.");
    } catch {
      setRunError("모의 실행 요청 중 오류가 발생했습니다.");
    } finally {
      setRunning(false);
    }
  }, [eventId]);

  const checks = data ? [
    { label: "상품 등록", ok: data.productCount > 0, detail: `${data.productCount}개 상품` },
    { label: "이벤트 상태", ok: data.status === "draft" || data.status === "live", detail: data.status },
    { label: "체크인 플로우", ok: data.attendeeCount >= 0, detail: `${data.attendeeCount}명 참석자` },
  ] : [];

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-content-subtle">리허설 모드</p>
        <h2 className="mt-2 text-3xl font-black tracking-[-0.04em] text-foreground">리허설</h2>
      </div>

      <div className="rounded-lg border border-border bg-card p-6">
        <div className="mb-4 flex items-center gap-3">
          <PlayCircle className="size-6 text-primary" />
          <h3 className="text-lg font-bold">판매 플로우 체크리스트</h3>
        </div>
        <p className="mb-6 text-sm text-content-subtle">실제 판매 전에 전체 플로우가 정상인지 확인하세요.</p>
        {loading ? (
          <div className="animate-pulse space-y-3">{[1, 2, 3].map((i) => <div key={i} className="h-10 rounded bg-bg-muted" />)}</div>
        ) : (
          <div className="space-y-3">
            {checks.map((c) => (
              <div key={c.label} className={`flex items-center justify-between rounded-lg border px-4 py-3 ${c.ok ? "border-success/30 bg-success/5" : "border-warning/30 bg-warning/5"}`}>
                <div className="flex items-center gap-3">
                  <CheckCircle className={`size-5 ${c.ok ? "text-success" : "text-warning"}`} />
                  <span className="text-sm font-medium">{c.label}</span>
                </div>
                <span className="text-xs text-content-muted">{c.detail}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-lg border border-border bg-card p-6">
        <div className="mb-4 flex items-center gap-3">
          <PlayCircle className="size-6 text-primary" />
          <h3 className="text-lg font-bold">모의 주문·체크인 실행</h3>
        </div>
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 px-4 py-3">
          <Info className="mt-0.5 size-4 shrink-0 text-primary" />
          <p className="text-xs text-content-subtle">
            실제 주문 생성 → 완료 전이 → 참석자 발행 → 체크인까지 DB 트랜잭션 안에서 모의 실행한 뒤 <strong>롤백</strong>합니다.
            실데이터·정산·리포트에 반영되지 않으며, 결제·이메일·알림 등 외부 발송도 일어나지 않습니다.
          </p>
        </div>

        <Button type="button" onClick={runMock} disabled={running}>
          {running ? <Loader2 className="size-4 animate-spin" /> : <PlayCircle className="size-4" />}
          {running ? "실행 중…" : "모의 주문·체크인 실행"}
        </Button>

        {runError && (
          <div className="mt-4 flex items-center gap-2 rounded-lg border border-error/30 bg-error/5 px-4 py-3">
            <XCircle className="size-5 text-error" />
            <span className="text-sm text-error">{runError}</span>
          </div>
        )}

        {runResult && (
          <div className="mt-4 space-y-3">
            <div className={`flex items-center gap-2 rounded-lg border px-4 py-3 ${runResult.allPassed ? "border-success/30 bg-success/5" : "border-warning/30 bg-warning/5"}`}>
              {runResult.allPassed
                ? <CheckCircle className="size-5 text-success" />
                : <XCircle className="size-5 text-warning" />}
              <span className="text-sm font-semibold">
                {runResult.allPassed ? "모든 단계 통과 — 판매 플로우가 정상입니다." : "일부 단계 실패 — 아래 상세를 확인하세요."}
              </span>
            </div>
            {runResult.steps.map((s) => (
              <div key={s.key} className={`flex items-start justify-between gap-4 rounded-lg border px-4 py-3 ${s.ok ? "border-success/30 bg-success/5" : "border-warning/30 bg-warning/5"}`}>
                <div className="flex items-start gap-3">
                  {s.ok
                    ? <CheckCircle className="mt-0.5 size-5 shrink-0 text-success" />
                    : <XCircle className="mt-0.5 size-5 shrink-0 text-warning" />}
                  <span className="text-sm font-medium">{s.label}</span>
                </div>
                <span className={`text-right text-xs ${s.ok ? "text-content-muted" : "text-warning"}`}>{s.detail}</span>
              </div>
            ))}
            <p className="text-xs text-content-muted">실데이터에 반영되지 않는 모의 실행입니다(롤백).</p>
          </div>
        )}
      </div>
    </div>
  );
}
