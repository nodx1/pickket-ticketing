"use client";

import { Download, Plus, UserCheck } from "lucide-react";
import { CsvImportDialog } from "./csv-import-dialog";
import { useEffect, useMemo, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { z } from "zod";
import { AttendeeDetailModal } from "./attendee-detail-modal";
import { AttendeeAddDialog } from "./attendee-add-dialog";
import { DataTable } from "@/components/shared/data-table";
import { EmptyState } from "@/components/shared/empty-state";
import { Pagination } from "@/components/shared/pagination";
import { SearchInput } from "@/components/shared/search-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDate } from "@/lib/format";
import { fetchWithAuth, fetchWithRefresh } from "@/lib/fetchWithAuth";
import { showError, showSuccess } from "@/lib/hooks/useToast";
import {
  clearDurableIdempotencyKey,
  getDurableIdempotencyKey,
} from "@/lib/client/idempotency";

interface AttendeeRow extends Record<string, string | number | boolean | null> {
  id: string;
  ticketNumber: string;
  name: string;
  email: string | null;
  phone: string | null;
  productName: string;
  status: "pending" | "confirmed" | "cancelled" | "checked_in";
  checkedInAt: string | null;
  createdAt: string;
}

interface ProductOption {
  id: string;
  name: string;
}

interface AttendeesResponse {
  data: AttendeeRow[];
  meta?: {
    total?: number;
    checkedInTotal?: number;
    cancelledTotal?: number;
  };
}

const formSchema = z.object({
  name: z.string().min(2, "이름을 입력해주세요"),
  email: z.string().optional(),
  phone: z.string().optional(),
  productId: z.string().uuid("상품을 선택해주세요"),
});

export function EventAttendeesClient({ eventId }: { eventId: string }) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [items, setItems] = useState<AttendeeRow[]>([]);
  const [status, setStatus] = useState(() => searchParams.get("status") ?? "all");
  const [search, setSearch] = useState(() => searchParams.get("q") ?? "");
  const [open, setOpen] = useState(false);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [page, setPage] = useState(() => {
    const p = Number(searchParams.get("page"));
    return p > 0 ? p : 1;
  });
  const [total, setTotal] = useState(0);
  // 서버 집계값 — 체크인 완료 수는 현재 페이지가 아니라 API 통계 전체에서 가져온다(#3 수정).
  const [checkedInTotal, setCheckedInTotal] = useState(0);
  const [cancelledTotal, setCancelledTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [selectedAttendeeId, setSelectedAttendeeId] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    email: "",
    phone: "",
    productId: "",
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPage(1);
  }, [search, status]);

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
    if (page > 1) {
      params.set("page", String(page));
    } else {
      params.delete("page");
    }
    const qs = params.toString();
    router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, search, page, pathname, router]);

  useEffect(() => {
    let isMounted = true;

    async function loadAttendees() {
      setLoading(true);
      try {
        const params = new URLSearchParams({ page: String(page), limit: "20" });
        if (status !== "all") {
          params.set("status", status);
        }
        if (search.trim()) {
          params.set("q", search.trim());
        }
        // 체크인/취소 집계는 별도 요청으로 전체 서버 집계값 조회(현재 페이지 한정 집계 방지 — #3 수정).
        const [payload, checkedInPayload, cancelledPayload] = await Promise.all([
          fetchWithAuth<AttendeesResponse>(`/api/events/${eventId}/attendees?${params.toString()}`),
          fetchWithAuth<AttendeesResponse>(`/api/events/${eventId}/attendees?status=checked_in&limit=1`),
          fetchWithAuth<AttendeesResponse>(`/api/events/${eventId}/attendees?status=cancelled&limit=1`),
        ]);
        if (isMounted) {
          setItems(payload.data ?? []);
          setTotal(payload.meta?.total ?? 0);
          setCheckedInTotal(checkedInPayload.meta?.total ?? 0);
          setCancelledTotal(cancelledPayload.meta?.total ?? 0);
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

    void loadAttendees();

    return () => {
      isMounted = false;
    };
  }, [eventId, page, search, status]);

  useEffect(() => {
    let isMounted = true;

    async function preloadOptions() {
      const productsResponse = await fetchWithRefresh(`/api/events/${eventId}/products`, { credentials: "include" });
      const productsPayload = (await productsResponse.json()) as { data?: Array<{ id: string; name: string }> };

      if (!isMounted) {
        return;
      }

      setProducts(productsPayload.data ?? []);
    }

    void preloadOptions();

    return () => {
      isMounted = false;
    };
  }, [eventId]);

  // 전체 서버 집계값 사용 — 현재 페이지(최대 20건) 한정 집계 방지 (#3 수정).
  const stats = useMemo(() => ({
    total,
    checkedIn: checkedInTotal,
    cancelled: cancelledTotal,
  }), [total, checkedInTotal, cancelledTotal]);

  async function refreshAttendees(nextPage = page) {
    const params = new URLSearchParams({ page: String(nextPage), limit: "20" });
    if (status !== "all") {
      params.set("status", status);
    }
    if (search.trim()) {
      params.set("q", search.trim());
    }
    const payload = await fetchWithAuth<AttendeesResponse>(`/api/events/${eventId}/attendees?${params.toString()}`);
    setItems(payload.data ?? []);
    setTotal(payload.meta?.total ?? 0);
  }

  async function handleCreate() {
    const parsed = formSchema.safeParse(form);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "입력값을 확인해주세요");
      return;
    }

    const scope = `attendee-create:${eventId}`;
    const fingerprint = JSON.stringify(form);
    const idempotencyKey = getDurableIdempotencyKey(scope, fingerprint);
    const response = await fetchWithRefresh(`/api/events/${eventId}/attendees`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(form),
    });

    const payload = (await response.json()) as { error?: string };
    if (!response.ok) {
      setError(payload.error ?? "참석자 추가에 실패했습니다");
      return;
    }

    clearDurableIdempotencyKey(scope, idempotencyKey);
    setOpen(false);
    setForm({ name: "", email: "", phone: "", productId: "" });
    setError(null);
    await refreshAttendees();
    showSuccess("참석자가 추가되었습니다");
  }

  async function handleExport() {
    try {
      const response = await fetchWithRefresh(`/api/events/${eventId}/attendees/export`, { credentials: "include" });
      if (!response.ok) {
        throw new Error("참석자 목록 다운로드에 실패했습니다");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `attendees-${eventId}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      showSuccess("참석자 목록이 다운로드되었습니다");
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "참석자 목록 다운로드에 실패했습니다");
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / 20));

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-sm text-muted-foreground">참석자 관리</p>
          <h2 className="mt-2 text-3xl font-black tracking-[-0.04em] text-foreground">참석자</h2>
        </div>
        <div className="flex gap-3">
          <Button variant="outline" onClick={handleExport}>
            <Download className="size-4" />
            CSV 내보내기
          </Button>
          <CsvImportDialog eventId={eventId} onImported={() => void refreshAttendees()} />
          <Button onClick={() => setOpen(true)}>
            <Plus className="size-4" />
            참석자 추가
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <StatCard label="전체 참석자" value={String(stats.total)} />
        <StatCard label="체크인 완료" value={String(stats.checkedIn)} />
        <StatCard label="취소됨" value={String(stats.cancelled)} />
      </div>

      <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4 lg:flex-row lg:items-center lg:justify-between">
        <SearchInput defaultValue={search} onSearch={setSearch} placeholder="이름, 이메일, 티켓번호 검색" />
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-[180px]" aria-label="참석자 상태 필터">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">전체</SelectItem>
            <SelectItem value="confirmed">확정</SelectItem>
            <SelectItem value="checked_in">체크인</SelectItem>
            <SelectItem value="cancelled">취소</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {items.length === 0 && !loading ? (
        <EmptyState
          icon={UserCheck}
          title="참석자가 없습니다"
          description="주문이 완료되거나 수동으로 참석자를 추가하면 여기서 바로 관리할 수 있습니다."
        />
      ) : (
        <>
          <DataTable
            data={items}
            loading={loading}
            onRowClick={(row) => setSelectedAttendeeId(row.id)}
            columns={[
              { key: "ticketNumber", label: "티켓번호" },
              { key: "name", label: "이름" },
              { key: "email", label: "이메일" },
              { key: "productName", label: "상품" },
              {
                key: "status",
                label: "상태",
                render: (row) => (
                  <Badge
                    variant={
                      row.status === "checked_in"
                        ? "success"
                        : row.status === "cancelled"
                          ? "outline"
                          : "secondary"
                    }
                  >
                    {row.status === "checked_in" ? "체크인" : row.status === "cancelled" ? "취소" : "확정"}
                  </Badge>
                ),
              },
              {
                key: "checkedInAt",
                label: "체크인시각",
                render: (row) => (row.checkedInAt ? formatDate(String(row.checkedInAt)) : "-"),
              },
            ]}
          />
          <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
        </>
      )}

      <AttendeeAddDialog
        open={open}
        onOpenChange={setOpen}
        form={form}
        setForm={setForm}
        products={products}
        error={error}
        onCreate={() => void handleCreate()}
      />

      <AttendeeDetailModal
        eventId={eventId}
        attendeeId={selectedAttendeeId}
        open={Boolean(selectedAttendeeId)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            setSelectedAttendeeId(null);
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
