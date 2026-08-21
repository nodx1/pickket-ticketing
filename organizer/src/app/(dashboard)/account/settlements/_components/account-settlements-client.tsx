"use client";

import { useCallback, useEffect, useState } from "react";
import { EmptyState } from "@/components/shared/empty-state";
import { Pagination } from "@/components/shared/pagination";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/shared/data-table";
import { Card, CardContent } from "@/components/ui/card";
import { fetchWithAuth } from "@/lib/fetchWithAuth";
import { formatDate, formatKRW } from "@/lib/format";
import { showError, showSuccess } from "@/lib/hooks/useToast";
import { SettlementDialogs } from "./settlement-dialogs";
import type { EventOption, SettlementRow } from "./settlement-types";

interface SettlementListResponse {
  success: boolean;
  data: SettlementRow[];
  meta: { total: number; page: number; limit: number };
  totalSummary?: { grossAmount: number; platformFee: number; netAmount: number };
}

const statusMeta: Record<
  SettlementRow["status"],
  { label: string; variant: "warning" | "default" | "success" }
> = {
  pending: { label: "정산 대기", variant: "warning" },
  processing: { label: "처리중", variant: "default" },
  completed: { label: "정산 완료", variant: "success" },
};

export function AccountSettlementsClient() {
  const [items, setItems] = useState<SettlementRow[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState({ grossAmount: 0, platformFee: 0, netAmount: 0 });
  const limit = 10;

  // 정산 마감 모달
  const [finalizeOpen, setFinalizeOpen] = useState(false);
  const [events, setEvents] = useState<EventOption[]>([]);
  const [selectedEventIds, setSelectedEventIds] = useState<Set<string>>(new Set());
  const [finalizing, setFinalizing] = useState(false);

  // 입금 완료 모달
  const [completeTarget, setCompleteTarget] = useState<SettlementRow | null>(null);
  const [completing, setCompleting] = useState(false);
  const [bankForm, setBankForm] = useState({ bankName: "", bankAccount: "", bankHolder: "" });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await fetchWithAuth<SettlementListResponse>(
        `/api/account/settlements?page=${page}&limit=${limit}`,
      );
      setItems(payload.data);
      setTotal(payload.meta.total);
      if (payload.totalSummary) setSummary(payload.totalSummary);
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    void load();
  }, [load]);

  // 모달 열 때 마감 가능한 이벤트 목록 로드
  const openFinalize = useCallback(async () => {
    setFinalizeOpen(true);
    setSelectedEventIds(new Set());
    try {
      const res = await fetchWithAuth<{ data: EventOption[] }>(
        "/api/events?limit=100",
      );
      setEvents(res.data ?? []);
    } catch (err) {
      showError(err instanceof Error ? err.message : "이벤트 목록 로드 실패");
    }
  }, []);

  const handleFinalize = useCallback(async () => {
    if (selectedEventIds.size === 0) {
      showError("이벤트를 1개 이상 선택해주세요");
      return;
    }
    setFinalizing(true);
    try {
      const res = await fetchWithAuth<{
        data: {
          summary: { ok: number; skipped: number; error: number };
          results: Array<{
            eventTitle: string;
            status: "ok" | "skipped" | "error";
            error?: string;
          }>;
        };
      }>("/api/account/settlements/finalize", {
        method: "POST",
        body: JSON.stringify({ eventIds: Array.from(selectedEventIds) }),
      });
      const { summary: s, results } = res.data;
      const errors = results.filter((r) => r.status === "error");
      if (errors.length > 0) {
        showError(
          `정산 ${s.ok}건 성공 · ${s.error}건 실패\n` +
            errors.map((e) => `${e.eventTitle}: ${e.error}`).join("\n"),
        );
      } else if (s.skipped > 0) {
        showSuccess(`정산 ${s.ok}건 마감 완료 (${s.skipped}건 스킵)`);
      } else {
        showSuccess(`정산 ${s.ok}건 마감 완료`);
      }
      setFinalizeOpen(false);
      await load();
    } catch (err) {
      showError(err instanceof Error ? err.message : "정산 마감 실패");
    } finally {
      setFinalizing(false);
    }
  }, [selectedEventIds, load]);

  const openComplete = useCallback((row: SettlementRow) => {
    setCompleteTarget(row);
    setBankForm({
      bankName: row.bankName ?? "",
      bankAccount: row.bankAccount ?? "",
      bankHolder: row.bankHolder ?? "",
    });
  }, []);

  const handleComplete = useCallback(async () => {
    if (!completeTarget) return;
    if (!bankForm.bankName || !bankForm.bankAccount || !bankForm.bankHolder) {
      showError("은행명/계좌번호/예금주를 모두 입력해주세요");
      return;
    }
    setCompleting(true);
    try {
      await fetchWithAuth(`/api/account/settlements/${completeTarget.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: "completed",
          bankName: bankForm.bankName,
          bankAccount: bankForm.bankAccount,
          bankHolder: bankForm.bankHolder,
        }),
      });
      showSuccess("입금 완료 처리됨");
      setCompleteTarget(null);
      await load();
    } catch (err) {
      showError(err instanceof Error ? err.message : "입금 완료 처리 실패");
    } finally {
      setCompleting(false);
    }
  }, [completeTarget, bankForm, load]);

  const totalPages = Math.max(Math.ceil(total / limit), 1);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-black tracking-[-0.04em] text-foreground">정산 내역</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            이벤트별 매출과 플랫폼 수수료, 최종 입금 금액을 확인할 수 있습니다.
          </p>
        </div>
        <Button onClick={openFinalize}>정산 마감</Button>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {[
          { label: "이번 달 매출", value: formatKRW(summary.grossAmount) },
          { label: "이번 달 수수료", value: formatKRW(summary.platformFee) },
          { label: "이번 달 입금액", value: formatKRW(summary.netAmount) },
        ].map((card) => (
          <Card key={card.label} className="rounded-lg border-border bg-card/95">
            <CardContent className="p-6">
              <p className="text-sm text-muted-foreground">{card.label}</p>
              <p className="mt-3 text-3xl font-black tracking-[-0.04em] text-foreground">
                {card.value}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      {items.length === 0 && !loading ? (
        <EmptyState
          title="정산 내역이 없습니다"
          description='우측 상단 "정산 마감" 버튼으로 이벤트 정산을 생성해주세요.'
        />
      ) : (
        <div className="space-y-4">
          <DataTable
            data={items}
            loading={loading}
            emptyMessage="정산 내역이 없습니다"
            columns={[
              {
                key: "eventTitle",
                label: "이벤트",
                render: (row) => row.eventTitle ?? "(이벤트 없음)",
              },
              {
                key: "periodStart",
                label: "기간",
                render: (row) =>
                  `${formatDate(row.periodStart)} ~ ${formatDate(row.periodEnd)}`,
              },
              {
                key: "grossAmount",
                label: "총매출",
                render: (row) => formatKRW(Number(row.grossAmount)),
              },
              {
                key: "platformFee",
                label: "플랫폼 수수료",
                render: (row) => formatKRW(Number(row.platformFee)),
              },
              {
                key: "pgFee",
                label: "PG 수수료",
                render: (row) => formatKRW(Number(row.pgFee)),
              },
              {
                key: "refundAmount",
                label: "환불",
                render: (row) => formatKRW(Number(row.refundAmount)),
              },
              {
                key: "netAmount",
                label: "입금액",
                render: (row) => (
                  <span className="font-semibold">{formatKRW(Number(row.netAmount))}</span>
                ),
              },
              {
                key: "status",
                label: "상태",
                render: (row) => (
                  <Badge variant={statusMeta[row.status].variant}>
                    {statusMeta[row.status].label}
                  </Badge>
                ),
              },
              {
                key: "id",
                label: "",
                render: (row) =>
                  row.status === "completed" ? (
                    <span className="text-xs text-muted-foreground">
                      {row.paidAt ? formatDate(row.paidAt) : ""}
                    </span>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => openComplete(row)}>
                      입금 완료 처리
                    </Button>
                  ),
              },
            ]}
          />
          <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
        </div>
      )}

      <SettlementDialogs
        finalizeOpen={finalizeOpen}
        setFinalizeOpen={setFinalizeOpen}
        events={events}
        selectedEventIds={selectedEventIds}
        setSelectedEventIds={setSelectedEventIds}
        finalizing={finalizing}
        onFinalize={handleFinalize}
        completeTarget={completeTarget}
        setCompleteTarget={setCompleteTarget}
        completing={completing}
        bankForm={bankForm}
        setBankForm={setBankForm}
        onComplete={handleComplete}
      />
    </div>
  );
}
