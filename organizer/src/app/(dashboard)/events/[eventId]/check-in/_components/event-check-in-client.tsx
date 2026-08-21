"use client";

import { useMemo, useState } from "react";
import { fetchWithRefresh } from "@/lib/fetchWithAuth";
import { CheckCircle2, AlertTriangle, Download, QrCode, Plus, RotateCcw, Undo2 } from "lucide-react";
import { EmptyState } from "@/components/shared/empty-state";
import { CheckInLog } from "./check-in-log";
import { ManualCheckIn } from "./manual-check-in";
import { RosterLookupPanel, type RosterRow } from "./roster-lookup-panel";
import { QrScannerPanel } from "./qr-scanner-panel";
import { QrToleranceControl } from "./qr-tolerance-control";
import { OfflineModePanel } from "./offline-mode-panel";
import { useCheckInData } from "./use-check-in-data";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { CreateListDialog, UndoDialog } from "./check-in-dialogs";
import { showError, showSuccess, showWarning } from "@/lib/hooks/useToast";
import { useOnlineStatus } from "@/lib/hooks/useOnlineStatus";
import { useAuthStore } from "@/lib/stores/authStore";

// §13 게이트 신호: admitted(신규입장 초록)·reentry_ok(당일 재입장 초록)·rejected(차단 빨강).
type Outcome = "admitted" | "reentry_ok" | "rejected";

interface CheckInResult {
  success: boolean;
  data?: {
    alreadyCheckedIn?: boolean;
    outcome?: "admitted" | "reentry_ok";
    attendee?: { id?: string; name: string; ticketNumber?: string; product?: string; checkedInAt?: string; attendedDate?: string };
  };
  error?: string;
}

interface LastCheckIn {
  attendeeId: string | null; // undo 대상(스캔 경로는 응답에 attendeeId 없어 로그로 유도)
  ticketNumber: string;
  name: string;
  attendedDate: string | null;
}

export function EventCheckInClient({ eventId }: { eventId: string }) {
  const online = useOnlineStatus();
  const staffLabel = useAuthStore((s) => s.user?.name ?? "스태프");
  const {
    error: loadError,
    lists,
    selectedListId,
    setSelectedListId,
    logs,
    stats,
    roster,
    rosterCount,
    rosterCachedAt,
    refresh,
  } = useCheckInData(eventId, online);

  const [feedback, setFeedback] = useState<{ outcome: Outcome; title: string; description: string } | null>(null);
  const [lastCheckIn, setLastCheckIn] = useState<LastCheckIn | null>(null);
  const [undoTarget, setUndoTarget] = useState<LastCheckIn | null>(null);
  const [undoReason, setUndoReason] = useState("");
  const [undoing, setUndoing] = useState(false);
  const [createListOpen, setCreateListOpen] = useState(false);
  const [createListName, setCreateListName] = useState("기본 입장");
  const [creating, setCreating] = useState(false);
  // §13 오프라인 폴백 + QR 창 킬스위치(명시 토글 — 자동 무단 전환 아님).
  const [offlineMode, setOfflineMode] = useState(false);
  const [qrToleranceEnabled, setQrToleranceEnabled] = useState(false);
  const [qrToleranceWindows, setQrToleranceWindows] = useState(4);

  const selectedList = useMemo(
    () => lists.find((item) => item.id === selectedListId) ?? null,
    [lists, selectedListId],
  );

  async function submitCreateList() {
    const name = createListName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const response = await fetchWithRefresh(`/api/events/${eventId}/check-in-lists`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, productIds: [] }),
      });
      const payload = (await response.json()) as { success: boolean; data?: { id: string }; error?: string };
      if (!payload.success) {
        throw new Error(payload.error ?? "체크인 리스트 생성에 실패했습니다");
      }
      showSuccess("체크인 리스트가 생성되었습니다");
      setCreateListOpen(false);
      setCreateListName("기본 입장");
      if (payload.data?.id) {
        setSelectedListId(payload.data.id);
      }
      await refresh(payload.data?.id ?? "");
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "체크인 리스트 생성에 실패했습니다");
    } finally {
      setCreating(false);
    }
  }

  // 스캔 경로: 회전 QR 원문(PKT:...)을 서버로 전달. 킬스위치 켜짐 시 tolerance 창 확대 전달.
  async function submitScan(scanPayload: string) {
    await postCheckIn({
      mode: "scan",
      scanPayload,
      qrToleranceWindows: qrToleranceEnabled ? qrToleranceWindows : undefined,
    });
  }

  // 수동 경로: 스태프 명시 액션 — 티켓번호 + 사유(감사).
  async function submitManual(ticketNumber: string, reason: string) {
    await postCheckIn({ mode: "manual", ticketNumber, manualReason: reason });
  }

  async function postCheckIn(input:
    | { mode: "scan"; scanPayload: string; qrToleranceWindows?: number }
    | { mode: "manual"; ticketNumber: string; manualReason: string }) {
    if (!selectedListId) {
      setFeedback({ outcome: "rejected", title: "체크인 리스트 선택", description: "먼저 체크인 리스트를 선택해주세요." });
      showWarning("체크인 리스트를 먼저 선택해주세요");
      return;
    }

    const response = await fetchWithRefresh(`/api/events/${eventId}/check-in`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, checkInListId: selectedListId }),
    });

    const payload = (await response.json()) as CheckInResult;
    const attendee = payload.data?.attendee;

    if (payload.success && attendee) {
      // §13: 당일 재입장(reentry_ok)은 차단이 아니라 정상 통과(초록). 신규 입장(admitted)도 초록.
      const outcome: Outcome = payload.data?.outcome ?? (payload.data?.alreadyCheckedIn ? "reentry_ok" : "admitted");
      const reentry = outcome === "reentry_ok";
      if (reentry) {
        showSuccess("재입장 확인 (당일 재입장 허용)");
      } else {
        showSuccess("체크인이 완료되었습니다");
      }
      setFeedback({
        outcome,
        title: reentry ? `재입장 OK · ${attendee.name}` : attendee.name,
        description: reentry
          ? `${attendee.product ?? "티켓"} · 당일 재입장이 허용된 티켓입니다.`
          : (attendee.product ?? "참석자 체크인이 완료되었습니다."),
      });
      // undo 대상 기록(오스캔 복구). 신규/재입장 모두 취소 가능.
      setLastCheckIn({
        attendeeId: attendee.id ?? null,
        ticketNumber: attendee.ticketNumber ?? "",
        name: attendee.name,
        attendedDate: attendee.attendedDate ?? null,
      });
    } else {
      // 실제 차단(빨강): 취소/만료·입장일 아님·미확정 참석자 등.
      const msg = payload.error ?? "체크인에 실패했습니다";
      showError(msg);
      setFeedback({ outcome: "rejected", title: "입장 차단", description: msg });
      setLastCheckIn(null);
    }

    await refresh(selectedListId);
    window.setTimeout(() => setFeedback(null), 4000);
  }

  async function confirmUndo() {
    const target = undoTarget;
    if (!target?.attendeeId) {
      showError("취소할 참석자를 찾을 수 없습니다");
      return;
    }
    const reason = undoReason.trim();
    if (!reason) {
      showWarning("취소 사유를 입력해주세요");
      return;
    }
    setUndoing(true);
    try {
      const response = await fetchWithRefresh(`/api/events/${eventId}/check-in`, {
        method: "DELETE",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          attendeeId: target.attendeeId,
          attendedDate: target.attendedDate ?? undefined,
          reason,
        }),
      });
      const payload = (await response.json()) as { success: boolean; error?: string };
      if (!payload.success) {
        throw new Error(payload.error ?? "체크인 취소에 실패했습니다");
      }
      showSuccess("체크인이 취소되었습니다");
      setFeedback({ outcome: "rejected", title: "체크인 취소됨", description: `${target.name} · ${reason}` });
      setLastCheckIn(null);
      setUndoTarget(null);
      setUndoReason("");
      await refresh(selectedListId);
      window.setTimeout(() => setFeedback(null), 4000);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "체크인 취소에 실패했습니다");
    } finally {
      setUndoing(false);
    }
  }

  async function handleExport() {
    try {
      const response = await fetchWithRefresh(`/api/events/${eventId}/check-in/export`, { credentials: "include" });
      if (!response.ok) {
        throw new Error("체크인 로그 다운로드에 실패했습니다");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `check-in-${eventId}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      showSuccess("체크인 로그가 다운로드되었습니다");
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "체크인 로그 다운로드에 실패했습니다");
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-sm text-muted-foreground">체크인 운영</p>
          <h2 className="mt-2 text-3xl font-black tracking-[-0.04em] text-foreground">체크인</h2>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => { setCreateListName("기본 입장"); setCreateListOpen(true); }}>
            <Plus className="size-4" />
            리스트 만들기
          </Button>
          <Button variant="outline" onClick={handleExport}>
            <Download className="size-4" />
            CSV 내보내기
          </Button>
          <Select value={selectedListId} onValueChange={setSelectedListId}>
            <SelectTrigger className="w-full sm:w-[240px]" aria-label="체크인 리스트 선택">
              <SelectValue placeholder="체크인 리스트 선택" />
            </SelectTrigger>
            <SelectContent>
              {lists.map((list) => (
                <SelectItem key={list.id} value={list.id}>
                  {list.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <StatCard label="체크인됨" value={String(stats.checkedIn)} />
        <StatCard label="전체 참석자" value={String(stats.total)} />
      </div>

      <div aria-live="assertive" aria-atomic="true">
        {feedback ? (
          <Card
            className={
              feedback.outcome === "rejected"
                ? "border-2 border-error/60 bg-error/5"
                : feedback.outcome === "reentry_ok"
                  ? "border-2 border-success/60 bg-success/5"
                  : "border-2 border-success/50 bg-success/5"
            }
          >
            <CardContent className="flex items-center justify-between gap-4 p-5">
              <div className="flex items-center gap-4">
                {feedback.outcome === "rejected" ? (
                  <AlertTriangle className="size-9 text-error" />
                ) : feedback.outcome === "reentry_ok" ? (
                  <RotateCcw className="size-9 text-success" />
                ) : (
                  <CheckCircle2 className="size-9 text-success" />
                )}
                <div>
                  <p className="text-lg font-bold text-foreground">{feedback.title}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{feedback.description}</p>
                </div>
              </div>
              {feedback.outcome !== "rejected" && lastCheckIn?.attendeeId ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { setUndoReason(""); setUndoTarget(lastCheckIn); }}
                >
                  <Undo2 className="size-4" />
                  체크인 취소
                </Button>
              ) : null}
            </CardContent>
          </Card>
        ) : null}
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_0.8fr]">
        {lists.length === 0 ? (
          // 🔴 리스트가 비는 이유는 둘이다 — 정말 없거나, **조회가 실패**했거나.
          //    종전에는 실패를 조용히 삼켜 둘 다 "먼저 만드세요" 로 보였다. 게이트 스태프는
          //    권한 문제로 먹통인데도 "리스트를 만들라" 는 안내만 보게 된다. 사유를 구분한다.
          <EmptyState
            icon={QrCode}
            title={loadError ? "체크인 목록을 불러오지 못했습니다" : "체크인 리스트가 없습니다"}
            description={
              loadError ??
              "체크인 리스트를 먼저 만든 뒤 QR 또는 수동 체크인을 시작할 수 있습니다."
            }
          />
        ) : (
          <>
            <div className="space-y-6">
              <QrToleranceControl
                enabled={qrToleranceEnabled}
                windows={qrToleranceWindows}
                onEnabledChange={setQrToleranceEnabled}
                onWindowsChange={setQrToleranceWindows}
              />
              <OfflineModePanel
                eventId={eventId}
                online={online}
                offlineMode={offlineMode}
                onOfflineModeChange={setOfflineMode}
                selectedListId={selectedListId}
                staffLabel={staffLabel}
                rosterCount={rosterCount}
                rosterCachedAt={rosterCachedAt}
                onSynced={() => void refresh(selectedListId)}
              />
              {offlineMode ? null : (
                <>
                  <QrScannerPanel onScan={(scanPayload) => void submitScan(scanPayload)} />
                  {/*
                    🔴 현장 임시티켓 발급용 조회 (2026-08-19 업체 요청).
                       검색은 아무것도 바꾸지 않는다 — 「입장 처리」를 눌러야 체크인된다.
                  */}
                  <RosterLookupPanel
                    rows={roster as RosterRow[]}
                    onCheckIn={(ticketNumber) =>
                      void submitManual(ticketNumber, "현장 조회 후 임시티켓 발급")
                    }
                  />
                  <ManualCheckIn onSubmit={submitManual} />
                </>
              )}
            </div>
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="text-foreground">현재 리스트</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">
                    {selectedList ? `${selectedList.name} · ${selectedList.status}` : "체크인 리스트를 선택해주세요."}
                  </p>
                </CardContent>
              </Card>
              <CheckInLog
                logs={logs}
                onCancel={(target) => {
                  // 과거 로그 행 취소 — 마지막 스캔 카드와 동일한 사유 입력 다이얼로그 재사용.
                  setUndoReason("");
                  setUndoTarget({
                    attendeeId: target.attendeeId,
                    ticketNumber: target.ticketNumber,
                    name: target.name,
                    attendedDate: target.attendedDate,
                  });
                }}
              />
            </div>
          </>
        )}
      </div>

      {/* 체크인 리스트 생성 다이얼로그 — window.prompt 대체 (#22 수정) */}
      <CreateListDialog
        open={createListOpen}
        name={createListName}
        creating={creating}
        onNameChange={setCreateListName}
        onOpenChange={setCreateListOpen}
        onSubmit={() => void submitCreateList()}
      />

      <UndoDialog
        open={undoTarget !== null}
        name={undoTarget?.name ?? null}
        attendedDate={undoTarget?.attendedDate ?? null}
        reason={undoReason}
        undoing={undoing}
        onReasonChange={setUndoReason}
        onConfirm={() => void confirmUndo()}
        onOpenChange={(open) => {
          if (!open && !undoing) {
            setUndoTarget(null);
            setUndoReason("");
          }
        }}
      />
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-3xl font-black tracking-[-0.04em] text-foreground">{value}</p>
      </CardContent>
    </Card>
  );
}
