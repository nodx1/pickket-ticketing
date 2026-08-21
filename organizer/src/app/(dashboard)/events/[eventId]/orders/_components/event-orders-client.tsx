"use client";

import Link from "next/link";
import { Download, Package } from "lucide-react";
import { useEffect, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { DataTable } from "@/components/shared/data-table";
import { EmptyState } from "@/components/shared/empty-state";
import { Pagination } from "@/components/shared/pagination";
import { SearchInput } from "@/components/shared/search-input";
import { ORDER_STATUS_LABELS } from "@/lib/constants";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { formatDate, formatKRW } from "@/lib/format";
import { fetchWithAuth, fetchWithRefresh } from "@/lib/fetchWithAuth";
import { showError, showSuccess } from "@/lib/hooks/useToast";
import { issueSourceBadge } from "@/lib/orders/issue-source";

/**
 * ⚠️ 인덱스 시그니처에 `undefined` 를 포함한다 — `DataTable<T extends object>` 는 이걸
 *    요구하지 않지만(제약은 `object` 뿐) 여기 남아 있고, 없으면 「모름」을 표현할 수 없다.
 *    `boolean | null` 로 좁히면 `undefined` 가 `false` 로 접혀 **모르는 주문이 실판매로** 보인다.
 */
interface OrderRow extends Record<string, string | number | boolean | null | undefined> {
  id: string;
  orderNumber: string;
  /**
   * 🔴 초대권·수동발권 구분. `undefined` = 모름(v2 앵커 미연결·구버전) → 배지를 안 붙인다.
   *    판정·문구는 `@/lib/orders/issue-source` 하나로만 — 상세 화면과 같은 함수를 쓴다.
   */
  isInvitation?: boolean | null;
  isManualIssue?: boolean | null;
  buyerName: string;
  buyerEmail: string;
  totalAmount: number;
  paidAmount: number;
  status: "pending" | "completed" | "cancelled" | "refunded" | "partially_refunded" | "expired";
  orderedAt: string;
}

interface OrdersResponse {
  data: OrderRow[];
  meta?: {
    total?: number;
    page?: number;
    limit?: number;
    /** 🔴 서버가 적용한 필터 에코. 미적용이면 `null`. */
    issueSource?: string | null;
  };
}

/** 주문 상태별 배지 색. 라벨은 `ORDER_STATUS_LABELS` 가, 색만 여기서 정한다. */
const ORDER_BADGE_VARIANT: Record<string, "success" | "warning" | "outline"> = {
  completed: "success",
  partially_refunded: "warning",
  refunded: "warning",
};

export function EventOrdersClient({ eventId }: { eventId: string }) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [items, setItems] = useState<OrderRow[]>([]);
  const [status, setStatus] = useState(() => searchParams.get("status") ?? "all");
  const [search, setSearch] = useState(() => searchParams.get("q") ?? "");
  const [page, setPage] = useState(() => {
    const p = Number(searchParams.get("page"));
    return p > 0 ? p : 1;
  });
  /**
   * 🔴 초대권·수동발권을 실판매와 갈라 본다. **서버가 자른다** — 클라이언트에서 자르면
   *    페이지네이션과 총계가 어긋나 발주처가 잘못 센다.
   */
  const [issueSource, setIssueSource] = useState(() => searchParams.get("issueSource") ?? "all");
  const [total, setTotal] = useState(0);
  /**
   * 🔴 **서버가 실제로 적용한 필터**(v2 에코). 내 선택과 다르면 필터가 안 먹은 것이다.
   *    없으면 화면이 조용히 전체를 보여주고 발주처가 그걸 「실판매 N건」으로 읽는다.
   */
  const [appliedSource, setAppliedSource] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setPage(1);
  }, [search, status, issueSource]);

  // URL 동기화 — 기본값이면 파라미터 제거해 URL 깔끔하게 유지
  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());
    if (status === "all") {
      params.delete("status");
    } else {
      params.set("status", status);
    }
    if (search.trim()) {
      params.set("q", search.trim());
    } else {
      params.delete("q");
    }
    if (issueSource === "all") {
      params.delete("issueSource");
    } else {
      params.set("issueSource", issueSource);
    }
    if (page > 1) {
      params.set("page", String(page));
    } else {
      params.delete("page");
    }
    const qs = params.toString();
    router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, search, page, issueSource, pathname, router]);

  useEffect(() => {
    let isMounted = true;

    async function fetchOrders() {
      setLoading(true);
      try {
        const params = new URLSearchParams({ page: String(page), limit: "20" });
        if (status !== "all") {
          params.set("status", status);
        }
        if (search.trim()) {
          params.set("q", search.trim());
        }
        if (issueSource !== "all") {
          params.set("issueSource", issueSource);
        }
        const payload = await fetchWithAuth<OrdersResponse>(`/api/events/${eventId}/orders?${params.toString()}`);
        if (isMounted) {
          setItems(payload.data ?? []);
          setTotal(payload.meta?.total ?? 0);
          // 🔴 서버가 **실제로 적용한** 값. 내 선택과 대조해 미적용을 알아챈다.
          setAppliedSource(payload.meta?.issueSource ?? null);
        }
      } catch (err: unknown) {
        if (err instanceof Error) {
          showError(err.message);
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    }

    void fetchOrders();

    return () => {
      isMounted = false;
    };
  }, [eventId, page, search, status, issueSource]);

  async function handleExport() {
    try {
      const response = await fetchWithRefresh(`/api/events/${eventId}/orders/export`, { credentials: "include" });
      if (!response.ok) {
        throw new Error("주문 목록 다운로드에 실패했습니다");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `orders-${eventId}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      showSuccess("주문 목록이 다운로드되었습니다");
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "주문 목록 다운로드에 실패했습니다");
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / 20));

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-sm text-muted-foreground">주문 관리</p>
          <h2 className="mt-2 text-3xl font-black tracking-[-0.04em] text-foreground">주문 목록</h2>
        </div>
        <div className="flex gap-3">
          <Button variant="outline" onClick={handleExport}>
            <Download className="size-4" />
            CSV 내보내기
          </Button>
        </div>
      </div>

      {/*
        🔴 **필터 둘을 한 묶음으로 붙인다** (2026-08-11, 대표 지시).
           종전엔 `justify-between` 이 검색·상태·구분 **셋을 양끝으로** 벌려 필터 둘 사이가
           떨어졌다. 대표님이 「왜 둘로 나눴냐」고 물으신 원인이다 — 두 축이 다른 것을
           거른다는 게 안 보이면 중복으로 읽힌다.
        ⟹ 검색은 왼쪽, 필터 둘은 **한 부모 안에서** 오른쪽에 붙인다.
      */}
      <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4 lg:flex-row lg:items-end">
        <div className="lg:max-w-md lg:flex-1">
          <SearchInput defaultValue={search} onSearch={setSearch} placeholder="주문번호, 구매자, 이메일 검색" />
        </div>

        {/*
          🔴 시각 라벨을 붙인다. 종전엔 `SelectValue` 만 있어 **무엇을 고르는 칸인지**
             화면에 없었다 — 「결제 완료 57건」이 실제로는 판매 6건인데, 두 축이 안 읽히면
             그 57을 매출로 읽는다. **정렬보다 라벨이 본질이다.**
          형태는 이 앱의 폼 관례를 따랐다(`space-y-2` + `<Label>` — affiliates·webhooks 편집 폼).
          ⚠️ `aria-label` 은 남긴다. 시각 라벨(「상태」)보다 구체적이라 스크린리더에는 그쪽이 낫다.
             `htmlFor`/`id` 는 라벨 클릭으로 칸에 초점이 가게 하는 용도다.
        */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end lg:ml-auto" data-testid="orders-filters">
          <div className="space-y-2">
            <Label htmlFor="orders-status-filter">상태</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger id="orders-status-filter" className="w-full sm:w-[168px]" aria-label="주문 상태 필터">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">전체 상태</SelectItem>
                <SelectItem value="pending">결제 대기</SelectItem>
                <SelectItem value="completed">결제 완료</SelectItem>
                <SelectItem value="cancelled">취소됨</SelectItem>
                <SelectItem value="refunded">환불됨</SelectItem>
                <SelectItem value="partially_refunded">부분 환불</SelectItem>
                <SelectItem value="expired">만료됨</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/*
            🔴 초대권·수동발권은 **매출로 세면 안 되는 주문**이다. 실측: 확정 84건 중
               51건이 그쪽이다. 배지만 있으면 눈으로 세야 하고, 사람이 세면 틀린다.
            ⚠️ 자르는 것은 **서버**다 — 클라이언트에서 자르면 페이지네이션·총계가 어긋난다.
          */}
          <div className="space-y-2">
            <Label htmlFor="orders-source-filter">발권 경로</Label>
            <Select value={issueSource} onValueChange={setIssueSource}>
              <SelectTrigger id="orders-source-filter" className="w-full sm:w-[186px]" aria-label="발권 경로 필터">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">전체</SelectItem>
                <SelectItem value="sale">실판매만</SelectItem>
                <SelectItem value="issued">초대권·수동발권만</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {items.length === 0 && !loading ? (
        <EmptyState
          icon={Package}
          title="주문이 없습니다"
          description="첫 주문이 생성되면 이곳에서 결제 상태와 주문 내역을 확인할 수 있습니다."
        />
      ) : (
        <>
          {/*
            🔴 **이중 가드** — 서버가 필터를 실제로 적용했는지 확인한다.
               v2 가 파라미터를 무시하거나(구버전·롤백·이름 변경) 배포 순서가 어긋나면
               화면은 아무 말 없이 **전체**를 보여주고, 발주처는 그걸 「실판매 N건」으로 읽는다.
               대회 중에 이게 나면 되돌릴 수 없다.
            ⚠️ 여기서 목록을 자르지 않는다 — 자르면 총계와 페이지가 어긋난다.
               **안 잘렸다는 사실을 알릴 뿐**이다.
          */}
          {issueSource !== "all" && appliedSource !== issueSource ? (
            <div
              role="alert"
              data-testid="filter-not-applied"
              className="mb-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm"
            >
              <p className="font-semibold text-destructive">필터가 적용되지 않았습니다</p>
              <p className="mt-0.5 text-xs text-content-subtle">
                아래는 <strong>전체 주문</strong>입니다. 이 숫자를 판매 실적으로 읽지 마세요.
                각 행의 배지로 초대권·수동발권을 구분하실 수 있습니다.
              </p>
            </div>
          ) : null}

          <DataTable
            data={items}
            searchTerm=""
            loading={loading}
            columns={[
              {
                key: "orderNumber",
                label: "주문번호",
                render: (row) => {
                  // 🔴 실판매면 `null` — 아무것도 덧붙이지 않는다. 목록에서 눈에 띄어야 하는 것은
                  //    **매출로 세면 안 되는 주문**이지 정상 주문이 아니다.
                  const badge = issueSourceBadge(row);
                  return (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Link href={`/events/${eventId}/orders/${row.id}`} className="font-semibold text-foreground hover:text-primary">
                        {row.orderNumber}
                      </Link>
                      {badge ? (
                        <Badge variant="outline" data-testid="issue-source">
                          {badge}
                        </Badge>
                      ) : null}
                    </div>
                  );
                },
              },
              { key: "buyerName", label: "구매자" },
              {
                key: "paidAmount",
                label: "금액",
                render: (row) => formatKRW(row.paidAmount),
              },
              {
                key: "status",
                label: "상태",
                // 🔴 종전엔 `completed` 를 `<StatusBadge status="live">` 로 그렸다 —
                //    **결제 완료 주문에 「판매중」**, 대기 주문에 「초안」이 떴다(2026-07-31 prod 실측).
                //    배지 색을 재활용하려다 **이벤트 상태 라벨이 따라온** 것이다.
                //    주문 상태는 `ORDER_STATUS_LABELS` 하나만 쓴다.
                render: (row) => (
                  <Badge variant={ORDER_BADGE_VARIANT[row.status] ?? "outline"}>
                    {ORDER_STATUS_LABELS[row.status as keyof typeof ORDER_STATUS_LABELS] ?? row.status}
                  </Badge>
                ),
              },
              {
                key: "orderedAt",
                label: "날짜",
                render: (row) => formatDate(row.orderedAt),
              },
            ]}
          />
          <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
        </>
      )}
    </div>
  );
}
