"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  ExternalLink,
  Loader2,
  PlayCircle,
  RefreshCcw,
  Send,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchWithAuth } from "@/lib/fetchWithAuth";
import { showError, showSuccess } from "@/lib/hooks/useToast";
import { cn } from "@/lib/utils";
import { formatDateTimeSecKst } from "@/lib/format";

type EventStatus =
  | "draft"
  | "pending_review"
  | "rejected"
  | "live"
  | "paused"
  | "archived";

interface ReviewHistory {
  action: "submit" | "approve" | "reject" | "resubmit" | "auto_approved";
  reason: string | null;
  created_at: string;
}

type CheckStatus = "pass" | "warn" | "fail";

interface CheckItem {
  label: string;
  status: CheckStatus;
  message: string;
  link?: string;
}

export function PublishChecklistClient({ eventId }: { eventId: string }) {
  const [checks, setChecks] = useState<CheckItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<EventStatus | null>(null);
  const [latestReview, setLatestReview] = useState<ReviewHistory | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const evRes = await fetchWithAuth<{ data: { status: EventStatus } }>(
        `/api/events/${eventId}`,
      );
      setStatus(evRes.data.status);
      // 최신 심사 이력 조회
      const revRes = await fetchWithAuth<{ data: ReviewHistory[] }>(
        `/api/events/${eventId}/reviews`,
      ).catch(() => null);
      if (revRes?.data?.length) setLatestReview(revRes.data[0]);
    } catch {
      /* noop */
    }
  }, [eventId]);

  const requestReview = useCallback(async () => {
    setSubmitting(true);
    try {
      await fetchWithAuth(`/api/events/${eventId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "pending_review" }),
      });
      showSuccess(
        "심사 요청이 접수되었습니다. 보통 24시간 내 검토 후 알림으로 결과를 전달드립니다.",
      );
      await loadStatus();
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "심사 요청에 실패했습니다");
    } finally {
      setSubmitting(false);
    }
  }, [eventId, loadStatus]);

  const loadChecklist = useCallback(async () => {
    setLoading(true);
    try {
      const result = await fetchWithAuth<{ data: CheckItem[] }>(
        `/api/events/${eventId}/publish-check`,
      );
      setChecks(result.data);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "게시 준비 상태를 불러오지 못했습니다");
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    void loadChecklist();
    void loadStatus();
  }, [loadChecklist, loadStatus]);

  const summary = useMemo(() => {
    const passCount = checks.filter((check) => check.status === "pass").length;
    const failCount = checks.filter((check) => check.status === "fail").length;
    const warnCount = checks.filter((check) => check.status === "warn").length;
    // 제출 가능 조건: fail 이 하나도 없으면 OK. warn 은 선택 사항이라 블록 안 함.
    const canSubmit = checks.length > 0 && failCount === 0;
    return {
      passCount,
      failCount,
      warnCount,
      totalCount: checks.length,
      issueCount: failCount,
      allPassed: canSubmit,
    };
  }, [checks]);

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">
          publish
        </p>
        <h1 className="mt-2 text-3xl font-black tracking-[-0.04em] text-foreground">
          게시 준비
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          이벤트 공개 전에 핵심 설정과 SEO 준비 상태를 한 번에 점검합니다.
        </p>
      </div>

      {/* 심사 상태 배너 */}
      {status === "pending_review" && (
        <Card className="border-warning/40 bg-warning/5">
          <CardContent className="flex items-start gap-3 p-5">
            <Clock className="mt-0.5 size-5 shrink-0 text-warning" />
            <div className="flex-1">
              <p className="font-bold text-warning">심사 진행 중</p>
              <p className="mt-1 text-sm text-muted-foreground">
                운영팀이 이벤트를 검토하고 있습니다. 평균 대응 시간은 24시간 이내입니다.
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                제출: {latestReview ? formatDateTimeSecKst(latestReview.created_at) : "-"}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {status === "rejected" && (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="flex flex-col gap-3 p-5">
            <div className="flex items-start gap-3">
              <XCircle className="mt-0.5 size-5 shrink-0 text-destructive" />
              <div className="flex-1">
                <p className="font-bold text-destructive">반려됨</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  검토 결과 수정이 필요합니다. 사유를 확인하고 수정 후 재제출해주세요.
                </p>
                {latestReview?.reason && (
                  <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 p-3">
                    <p className="text-xs font-semibold text-destructive">반려 사유</p>
                    <p className="mt-1 text-sm text-foreground">{latestReview.reason}</p>
                  </div>
                )}
              </div>
            </div>
            <Button
              onClick={() => void requestReview()}
              disabled={!summary.allPassed || submitting}
              className="ml-auto gap-2"
            >
              <Send className="size-4" />
              {submitting ? "제출 중..." : "수정 완료 · 재제출"}
            </Button>
          </CardContent>
        </Card>
      )}

      {status === "live" && (
        <Card className="border-success/40 bg-success/5">
          <CardContent className="flex items-start gap-3 p-5">
            <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" />
            <div className="flex-1">
              <p className="font-bold text-success">공개 중</p>
              <p className="mt-1 text-sm text-muted-foreground">
                이벤트가 승인되어 구매 페이지에 노출되고 있습니다.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {status === "draft" && summary.allPassed && (
        <Card className="border-primary/40 bg-primary/5">
          <CardContent className="flex items-center justify-between gap-3 p-5">
            <div>
              <p className="font-bold text-primary">심사 요청 준비 완료</p>
              <p className="mt-1 text-sm text-muted-foreground">
                체크리스트를 모두 통과했습니다. 운영팀에 심사 요청을 보낼 수 있어요.
              </p>
            </div>
            <Button
              size="lg"
              onClick={() => void requestReview()}
              disabled={submitting}
              className="gap-2"
            >
              <Send className="size-4" />
              {submitting ? "제출 중..." : "심사 요청"}
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="flex items-center gap-4 p-5">
          {loading ? (
            <>
              <Loader2 className="size-5 animate-spin text-primary" />
              <div>
                <p className="font-bold text-foreground">게시 준비 상태를 확인하는 중입니다</p>
                <p className="text-sm text-muted-foreground">필수 설정과 추천 항목을 점검하고 있습니다.</p>
              </div>
            </>
          ) : summary.allPassed ? (
            <>
              <CheckCircle2 className="size-6 text-success" />
              <div>
                <p className="font-bold text-success">
                  심사 요청 가능
                  {summary.warnCount > 0 && ` · 선택 항목 ${summary.warnCount}개 미완성`}
                </p>
                <p className="text-sm text-muted-foreground">
                  {summary.warnCount > 0
                    ? "필수 항목은 모두 통과했습니다. 선택 항목은 나중에 보완해도 됩니다."
                    : "모든 항목을 통과했습니다. 심사 요청하세요."}
                </p>
              </div>
            </>
          ) : (
            <>
              <AlertTriangle className="size-6 text-warning" />
              <div>
                <p className="font-bold text-warning">
                  필수 {summary.failCount}개 수정 필요
                </p>
                <p className="text-sm text-muted-foreground">
                  통과 {summary.passCount} · 선택 {summary.warnCount} · 필수 미완 {summary.failCount}
                </p>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-foreground">체크리스트</CardTitle>
            <Button variant="outline" size="sm" onClick={() => void loadChecklist()} disabled={loading}>
              <RefreshCcw className="mr-1 size-3" />
              다시 검사
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="size-5 animate-spin text-primary" />
            </div>
          ) : (
            <div className="space-y-2">
              {checks.map((check) => {
                const Icon =
                  check.status === "pass"
                    ? CheckCircle2
                    : check.status === "warn"
                      ? AlertTriangle
                      : XCircle;
                const color =
                  check.status === "pass"
                    ? "text-success"
                    : check.status === "warn"
                      ? "text-warning"
                      : "text-destructive";

                return (
                  <div
                    key={check.label}
                    className="flex items-center gap-3 rounded-lg border border-border bg-muted px-4 py-3"
                  >
                    <Icon className={cn("size-4 shrink-0", color)} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-foreground">{check.label}</p>
                      <p className="text-xs text-muted-foreground">{check.message}</p>
                    </div>
                    {check.link ? (
                      <Link
                        href={check.link}
                        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                      >
                        이동
                        <ExternalLink className="size-3" />
                      </Link>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 리허설/점검 도구 — 상시 기능토글에서 게시 준비 내 진입점으로 이동 (Phase2 슬림화) */}
      <Card>
        <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <PlayCircle className="mt-0.5 size-5 shrink-0 text-primary" />
            <div>
              <p className="font-bold text-foreground">리허설 · 점검</p>
              <p className="mt-1 text-sm text-muted-foreground">
                실제 판매 없이 티켓·주문·참석자 플로우를 모의 실행해 문제를 미리 확인합니다.
              </p>
            </div>
          </div>
          <Button asChild variant="outline" className="shrink-0 gap-2">
            <Link href={`/events/${eventId}/rehearsal`}>
              리허설 열기
              <ExternalLink className="size-3.5" />
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
