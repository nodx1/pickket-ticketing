"use client";

import Link from "next/link";
import { useConfirmAction } from "@/lib/hooks/useConfirmAction";
import { Copy, FolderArchive, Plus, RotateCcw, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useTutorialStore } from "@/lib/stores/tutorialStore";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { EmptyState } from "@/components/shared/empty-state";
import { MoneyDisplay } from "@/components/shared/money-display";
import { Pagination } from "@/components/shared/pagination";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatDate } from "@/lib/format";
import { showError, showSuccess } from "@/lib/hooks/useToast";
import { useEventStore, type EventListItem } from "@/lib/stores/eventStore";
import { fetchWithRefresh } from "@/lib/fetchWithAuth";

function statusForTab(tab: string) {
  if (tab === "scheduled") {
    return "scheduled";
  }
  if (tab === "archived") {
    return "archived";
  }
  if (tab === "ended") {
    return "ended";
  }
  return "";
}

export default function EventsPage() {
  const { events, meta, fetchEvents, isLoading } = useEventStore();
  const { startTour, isTourCompleted, isTourSkipped, activeTourId } = useTutorialStore();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [tab, setTab] = useState(() => searchParams.get("tab") ?? "scheduled");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("latest");
  const [page, setPage] = useState(() => {
    const raw = Number(searchParams.get("page"));
    return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
  });
  const [archiveTarget, setArchiveTarget] = useState<EventListItem | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<EventListItem | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<EventListItem | null>(null);

  // 쿼리 조립 단일화(중복 조립 4곳 재발 방지). page 를 인자로 받아 항상 반영.
  const buildQuery = useCallback(
    (targetPage: number) => {
      const params = new URLSearchParams();
      const status = statusForTab(tab);
      if (status) {
        params.set("status", status);
      }
      if (search.trim()) {
        params.set("search", search.trim());
      }
      params.set("sort", sort);
      if (targetPage > 1) {
        params.set("page", String(targetPage));
      }
      return `?${params.toString()}`;
    },
    [tab, search, sort],
  );

  function refetch() {
    void fetchEvents(buildQuery(page));
  }

  function handleTabChange(value: string) {
    setTab(value);
    setPage(1);
    const params = new URLSearchParams(searchParams.toString());
    if (value === "scheduled") {
      params.delete("tab");
    } else {
      params.set("tab", value);
    }
    params.delete("page");
    const qs = params.toString();
    router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
  }

  function handlePageChange(nextPage: number) {
    setPage(nextPage);
    const params = new URLSearchParams(searchParams.toString());
    if (nextPage > 1) {
      params.set("page", String(nextPage));
    } else {
      params.delete("page");
    }
    const qs = params.toString();
    router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
  }

  useEffect(() => {
    void fetchEvents(buildQuery(page));
  }, [fetchEvents, buildQuery, page]);

  useEffect(() => {
    if (!isLoading && events.length === 0 && !activeTourId && !isTourCompleted("create-event") && !isTourSkipped("create-event")) {
      const timer = setTimeout(() => startTour("create-event"), 600);
      return () => clearTimeout(timer);
    }
  }, [isLoading, events.length, activeTourId, isTourCompleted, isTourSkipped, startTour]);

  const filtered = useMemo(() => events, [events]);
  const totalPages = meta && meta.limit > 0 ? Math.ceil(meta.total / meta.limit) : 1;

  async function handleDuplicate(eventId: string) {
    const response = await fetchWithRefresh(`/api/events/${eventId}/duplicate`, {
      method: "POST",
      credentials: "include",
    });

    if (response.ok) {
      void fetchEvents(buildQuery(page));
      showSuccess("이벤트가 복제되었습니다");
      return;
    }

    showError("이벤트 복제에 실패했습니다");
  }

  async function handleArchive(eventId: string) {
    const response = await fetchWithRefresh(`/api/events/${eventId}`, {
      method: "DELETE",
      credentials: "include",
    });

    if (response.ok) {
      void fetchEvents(buildQuery(page));
      showSuccess("이벤트가 보관 처리되었습니다");
      return;
    }

    showError("이벤트 보관에 실패했습니다");
  }

  async function handleRestore(eventId: string) {
    const response = await fetchWithRefresh(`/api/events/${eventId}/restore`, {
      method: "POST",
      credentials: "include",
    });
    if (response.ok) {
      refetch();
      showSuccess("이벤트를 복원했습니다. 예정 탭에서 확인하세요.");
      return;
    }
    showError("이벤트 복원에 실패했습니다");
  }

  async function handlePurge(eventId: string) {
    const response = await fetchWithRefresh(`/api/events/${eventId}/purge`, {
      method: "DELETE",
      credentials: "include",
    });
    if (response.ok) {
      refetch();
      showSuccess("이벤트를 영구삭제했습니다");
      return;
    }
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    showError(payload.error ?? "이벤트 영구삭제에 실패했습니다");
  }

  const archiveAction = useConfirmAction(async () => {
    if (!archiveTarget) return;
    await handleArchive(archiveTarget.id);
    setArchiveTarget(null);
  });
  const restoreAction = useConfirmAction(async () => {
    if (!restoreTarget) return;
    await handleRestore(restoreTarget.id);
    setRestoreTarget(null);
  });
  const purgeAction = useConfirmAction(async () => {
    if (!purgeTarget) return;
    await handlePurge(purgeTarget.id);
    setPurgeTarget(null);
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-sm text-content-subtle">이벤트 관리</p>
          <h2 className="mt-2 text-3xl font-black tracking-[-0.04em] text-foreground">모든 이벤트</h2>
        </div>
        <Button asChild data-tutorial="create-event-button">
          <Link href="/events/create">
            <Plus className="size-4" />
            이벤트 만들기
          </Link>
        </Button>
      </div>

      <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4 lg:flex-row lg:items-center lg:justify-between">
        <Tabs value={tab} onValueChange={handleTabChange}>
          <TabsList className="grid w-full grid-cols-3 lg:w-[320px]">
            <TabsTrigger value="scheduled">예정</TabsTrigger>
            <TabsTrigger value="ended">종료</TabsTrigger>
            <TabsTrigger value="archived">보관됨</TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="flex flex-col gap-3 lg:flex-row">
          <div className="flex items-center gap-2 rounded-full border border-border bg-muted/40 px-4">
            <Search className="size-4 text-content-subtle" />
            <input
              className="h-11 bg-transparent text-sm outline-none placeholder:text-content-subtle"
              placeholder="이벤트명 또는 주최자 검색"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
            />
          </div>
          <Select
            value={sort}
            onValueChange={(value) => {
              setSort(value);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-[180px]" aria-label="상태 필터">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="latest">최신 일정순</SelectItem>
              <SelectItem value="oldest">오래된 일정순</SelectItem>
              <SelectItem value="created">최근 생성순</SelectItem>
              <SelectItem value="title">이름순</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {isLoading ? (
        <div className="grid gap-5 xl:grid-cols-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <div
              key={`event-skeleton-${index}`}
              className="overflow-hidden rounded-lg border border-border bg-card/95"
            >
              <Skeleton className="h-40 rounded-none" />
              <div className="space-y-3 p-6">
                <Skeleton className="h-6 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
                <div className="grid grid-cols-2 gap-3">
                  <Skeleton className="h-4" />
                  <Skeleton className="h-4" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          title="등록된 이벤트가 없습니다"
          description="첫 이벤트를 만들고 퍼블릭 판매 흐름을 바로 테스트해보세요."
          actionLabel="이벤트 만들기"
          onAction={() => {
            window.location.href = "/events/create";
          }}
        />
      ) : (
        <div className="grid gap-5 xl:grid-cols-2">
          {filtered.map((item) => (
            <EventCard
              key={item.id}
              item={item}
              isArchived={tab === "archived"}
              onArchive={setArchiveTarget}
              onDuplicate={handleDuplicate}
              onRestore={setRestoreTarget}
              onPurge={setPurgeTarget}
            />
          ))}
        </div>
      )}

      {!isLoading && totalPages > 1 ? (
        <Pagination page={page} totalPages={totalPages} onPageChange={handlePageChange} />
      ) : null}

      <ConfirmDialog
        open={Boolean(archiveTarget)}
        title="이벤트 보관"
        description="이 이벤트를 보관하면 목록에서 숨겨집니다. 보관됨 탭에서 확인할 수 있습니다."
        confirmText="보관하기"
        pending={archiveAction.pending}
        onConfirm={archiveAction.run}
        onOpenChange={(open) => {
          if (!open) {
            setArchiveTarget(null);
          }
        }}
      />

      <ConfirmDialog
        open={Boolean(restoreTarget)}
        title="이벤트 복원"
        description="이 이벤트를 초안(예정) 상태로 되돌립니다. 예정 탭에서 다시 편집·판매할 수 있습니다."
        confirmText="복원하기"
        pending={restoreAction.pending}
        onConfirm={restoreAction.run}
        onOpenChange={(open) => {
          if (!open) {
            setRestoreTarget(null);
          }
        }}
      />

      <ConfirmDialog
        open={Boolean(purgeTarget)}
        title="이벤트 영구삭제"
        description="이 이벤트와 모든 설정을 영구히 삭제합니다. 되돌릴 수 없습니다. 주문·참석자가 없는 테스트 이벤트만 삭제할 수 있습니다."
        confirmText="영구삭제"
        pending={purgeAction.pending}
        onConfirm={purgeAction.run}
        onOpenChange={(open) => {
          if (!open) {
            setPurgeTarget(null);
          }
        }}
      />
    </div>
  );
}

function EventCard({
  item,
  isArchived,
  onArchive,
  onDuplicate,
  onRestore,
  onPurge,
}: {
  item: EventListItem;
  isArchived: boolean;
  onArchive: (item: EventListItem) => void;
  onDuplicate: (eventId: string) => Promise<void>;
  onRestore: (item: EventListItem) => void;
  onPurge: (item: EventListItem) => void;
}) {
  // 영구삭제는 주문·참석자 0인 테스트 이벤트만 허용(회계·감사 보존).
  const canPurge = item.orderCount === 0 && item.attendeeCount === 0;
  // 확인 버튼 잠금 + 재진입 차단 + 실패 시 해제 (S3).
  // 종전엔 `void fn(); setTarget(null)` 라 **요청이 끝나기 전에 창이 닫혔다** —
  // 그 상태로 pending 을 넘겨봐야 보이지도 않는다. 끝난 뒤 닫도록 바꿨다.
  return (
    <Card className="card-hover overflow-hidden border-border bg-card/95">
      <div className="relative h-40 overflow-hidden bg-gradient-to-br from-primary/12 via-accent/8 to-success/6">
        {item.heroImageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.heroImageUrl} alt={item.title} className="size-full object-cover" />
        ) : null}
      </div>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <CardTitle className="truncate text-xl text-foreground">{item.title}</CardTitle>
            <StatusBadge status={item.status} endsAt={item.endsAt} />
          </div>
          <p className="mt-2 text-sm text-content-subtle">
            {Array.isArray(item.organizers) && item.organizers.length > 0
              ? item.organizers
                  .filter((o: { role: string }) => o.role === "host")
                  .map((o: { name: string }) => o.name)
                  .join(", ") || item.organizerName
              : item.organizerName}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {isArchived ? (
            <>
              <Button variant="outline" size="icon" aria-label="이벤트 복원" onClick={() => onRestore(item)}>
                <RotateCcw className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                aria-label="이벤트 영구삭제"
                disabled={!canPurge}
                title={canPurge ? "영구삭제" : "주문·참석자가 있어 영구삭제할 수 없습니다"}
                onClick={() => onPurge(item)}
              >
                <Trash2 className="size-4 text-destructive" />
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" size="icon" aria-label="이벤트 복제" onClick={() => void onDuplicate(item.id)}>
                <Copy className="size-4" />
              </Button>
              <Button variant="outline" size="icon" aria-label="이벤트 보관" onClick={() => onArchive(item)}>
                <FolderArchive className="size-4" />
              </Button>
            </>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 text-sm text-content-subtle lg:grid-cols-2">
          <p>일정: {formatDate(item.startsAt)}</p>
          <p>장소: {item.isOnline ? "온라인" : item.venueName || "장소 미정"}</p>
          <p>참석자: {item.attendeeCount.toLocaleString("ko-KR")}명</p>
          <p>주문: {item.orderCount.toLocaleString("ko-KR")}건</p>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 px-4 py-3">
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-content-subtle">매출</p>
            <MoneyDisplay amount={item.revenue} />
          </div>
          <Button asChild variant="outline">
            <Link href={`/events/${item.id}/dashboard`}>상세 보기</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
