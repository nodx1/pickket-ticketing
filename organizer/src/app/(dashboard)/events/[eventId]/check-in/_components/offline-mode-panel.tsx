"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CloudOff, RefreshCw, Search, WifiOff, AlertTriangle, CheckCircle2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { EmptyState } from "@/components/shared/empty-state";
import { showError, showSuccess, showWarning } from "@/lib/hooks/useToast";
import {
  clearSynced,
  enqueueOfflineCheckIn,
  listQueue,
  searchRoster,
  type CachedGuest,
  type OfflineCheckIn,
} from "@/lib/checkin/offline-store";
import { makeDefaultPoster, syncOfflineQueue } from "@/lib/checkin/offline-sync";
import { formatTimeSecKst } from "@/lib/format";

interface OfflineModePanelProps {
  eventId: string;
  online: boolean;
  offlineMode: boolean;
  onOfflineModeChange: (value: boolean) => void;
  selectedListId: string;
  staffLabel: string;
  rosterCount: number;
  rosterCachedAt: number | null;
  onSynced: () => void;
}

const ADMISSION_LABEL: Record<string, string> = {
  single: "단일일",
  daypass: "지정일",
  allpass: "전일권",
};

function statusBadge(state: OfflineCheckIn["syncState"]) {
  if (state === "synced") return <Badge variant="success">동기화됨</Badge>;
  if (state === "conflict") return <Badge variant="destructive">충돌</Badge>;
  return <Badge variant="warning">대기</Badge>;
}

export function OfflineModePanel({
  eventId,
  online,
  offlineMode,
  onOfflineModeChange,
  selectedListId,
  staffLabel,
  rosterCount,
  rosterCachedAt,
  onSynced,
}: OfflineModePanelProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CachedGuest[]>([]);
  const [queue, setQueue] = useState<OfflineCheckIn[]>([]);
  const [syncing, setSyncing] = useState(false);

  const refreshQueue = useCallback(async () => {
    try {
      setQueue(await listQueue(eventId));
    } catch {
      // IndexedDB 미지원 등 — 조용히 무시(오프라인 기능 비활성).
    }
  }, [eventId]);

  useEffect(() => {
    void refreshQueue();
  }, [refreshQueue]);

  const pendingCount = useMemo(() => queue.filter((q) => q.syncState === "pending").length, [queue]);
  const conflictItems = useMemo(() => queue.filter((q) => q.syncState === "conflict"), [queue]);

  async function runSearch(next: string) {
    setQuery(next);
    if (next.trim().length === 0) {
      setResults([]);
      return;
    }
    try {
      setResults(await searchRoster(eventId, next, 20));
    } catch {
      setResults([]);
    }
  }

  async function handleOfflineCheckIn(guest: CachedGuest) {
    if (!selectedListId) {
      showWarning("체크인 리스트를 먼저 선택해주세요");
      return;
    }
    // 명단 상태 육안 판단 보조: 취소 상태는 경고(스태프가 최종 판단).
    if (guest.status === "cancelled") {
      showWarning(`${guest.name} 은(는) 취소 상태로 캐시되어 있습니다. 육안 확인 후 진행하세요.`);
    }
    try {
      await enqueueOfflineCheckIn({
        eventId,
        checkInListId: selectedListId,
        ticketNumber: guest.ticketNumber,
        guestName: guest.name,
        staffLabel,
      });
      showSuccess(`오프라인 체크인 기록됨 · ${guest.name}`);
      setQuery("");
      setResults([]);
      await refreshQueue();
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "오프라인 체크인 기록에 실패했습니다");
    }
  }

  async function handleSync() {
    if (pendingCount === 0) {
      showWarning("동기화할 대기 항목이 없습니다");
      return;
    }
    if (!online) {
      showWarning("네트워크가 연결되면 동기화할 수 있습니다");
      return;
    }
    setSyncing(true);
    try {
      const result = await syncOfflineQueue(eventId, makeDefaultPoster(eventId));
      await clearSynced(eventId);
      await refreshQueue();
      const parts = [`성공 ${result.synced}`];
      if (result.conflict > 0) parts.push(`충돌 ${result.conflict}`);
      if (result.failed > 0) parts.push(`실패 ${result.failed}`);
      if (result.conflict > 0 || result.failed > 0) {
        showWarning(`동기화 완료 — ${parts.join(" · ")}`);
      } else {
        showSuccess(`동기화 완료 — ${parts.join(" · ")}`);
      }
      onSynced();
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "동기화 중 오류가 발생했습니다");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <Card className={offlineMode ? "border-2 border-warning/60 bg-warning/5" : undefined}>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="flex items-center gap-2 text-foreground">
          <CloudOff className="size-4 text-muted-foreground" />
          오프라인 체크인 모드
        </CardTitle>
        <div className="flex items-center gap-2">
          {!online ? (
            <Badge variant="warning">
              <WifiOff className="mr-1 size-3" />
              네트워크 끊김
            </Badge>
          ) : null}
          <Switch checked={offlineMode} onCheckedChange={onOfflineModeChange} aria-label="오프라인 체크인 모드" />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          <p>
            LTE 불안정(야외·골프장) 대비 폴백입니다. 켜면 명단 검색으로 게스트를 확인해 로컬에 기록하고,
            네트워크 복귀 시 서버로 동기화합니다.
          </p>
          <p className="mt-1 flex items-center gap-1 font-medium text-warning">
            <AlertTriangle className="size-3.5" />
            오프라인은 회전 QR을 서버검증할 수 없습니다. 스태프가 명단의 이름으로 육안 대조하세요.
          </p>
          <p className="mt-1">
            캐시된 명단: {rosterCount}명
            {rosterCachedAt ? ` · ${formatTimeSecKst(rosterCachedAt)} 갱신` : " · 미캐시"}
          </p>
        </div>

        {offlineMode ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="offline-search">명단 검색 (이름 또는 티켓번호)</Label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="offline-search"
                  className="pl-9"
                  placeholder="이름 또는 티켓번호로 검색"
                  value={query}
                  onChange={(e) => void runSearch(e.target.value)}
                />
              </div>
            </div>

            {query.trim().length > 0 ? (
              results.length > 0 ? (
                <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                  {results.map((guest) => (
                    <li key={guest.rowKey} className="flex items-center justify-between gap-3 px-3 py-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-foreground">{guest.name}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {guest.ticketNumber}
                          {guest.admissionMode ? ` · ${ADMISSION_LABEL[guest.admissionMode] ?? guest.admissionMode}` : ""}
                          {guest.productName ? ` · ${guest.productName}` : ""}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {guest.status === "cancelled" ? <Badge variant="destructive">취소</Badge> : null}
                        {guest.status === "checked_in" ? <Badge variant="secondary">입장기록</Badge> : null}
                        <Button size="sm" onClick={() => void handleOfflineCheckIn(guest)}>
                          체크인
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
                  일치하는 게스트가 없습니다. 캐시된 명단을 확인하세요.
                </p>
              )
            ) : null}
          </div>
        ) : null}

        {/* 큐 요약 + 동기화 */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>대기 {pendingCount}건</span>
            {conflictItems.length > 0 ? <Badge variant="destructive">충돌 {conflictItems.length}건</Badge> : null}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleSync()}
            disabled={syncing || pendingCount === 0 || !online}
          >
            <RefreshCw className={`size-4 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "동기화 중..." : "서버로 동기화"}
          </Button>
        </div>

        {/* 충돌 리뷰 목록(스태프 표면화) */}
        {conflictItems.length > 0 ? (
          <div className="space-y-2">
            <p className="flex items-center gap-1.5 text-sm font-semibold text-destructive">
              <AlertTriangle className="size-4" />
              충돌 리뷰 (서버가 입장을 거부함 — 수동 확인 필요)
            </p>
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-destructive/40">
              {conflictItems.map((item) => (
                <li key={item.localId} className="px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-medium text-foreground">
                      {item.guestName} · {item.ticketNumber}
                    </p>
                    {statusBadge(item.syncState)}
                  </div>
                  {item.syncMessage ? (
                    <p className="mt-0.5 text-xs text-destructive">{item.syncMessage}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* 전체 큐(대기·동기화·충돌) */}
        {queue.length > 0 ? (
          <div className="space-y-2">
            <p className="text-sm font-semibold text-foreground">오프라인 큐 ({queue.length}건)</p>
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
              {queue.slice(0, 30).map((item) => (
                <li key={item.localId} className="flex items-center justify-between gap-2 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-foreground">
                      {item.guestName} · {item.ticketNumber}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatTimeSecKst(item.checkedInAt)} · {item.staffLabel}
                    </p>
                  </div>
                  {statusBadge(item.syncState)}
                </li>
              ))}
            </ul>
          </div>
        ) : offlineMode ? (
          <EmptyState
            icon={CheckCircle2}
            title="오프라인 기록 없음"
            description="명단에서 게스트를 검색해 오프라인 체크인을 기록하세요."
          />
        ) : null}
      </CardContent>
    </Card>
  );
}
