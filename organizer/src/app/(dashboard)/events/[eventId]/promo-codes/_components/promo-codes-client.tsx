"use client";

import { useEffect, useMemo, useState } from "react";
import { useConfirmAction } from "@/lib/hooks/useConfirmAction";
import { toDateTimeLocal } from "@/lib/date";
import { Pencil, Tag, Trash2 } from "lucide-react";
import { PromoCodeForm, type PromoCodeFormValue } from "@/components/forms/promo-code-form";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { DataTable } from "@/components/shared/data-table";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { showError, showSuccess } from "@/lib/hooks/useToast";
import { fetchWithRefresh } from "@/lib/fetchWithAuth";
import { formatDateShortKst } from "@/lib/format";

interface PromoRow extends Record<string, string | number | boolean | null> {
  id: string;
  code: string;
  promoType: "fixed" | "percentage";
  discountValue: number;
  usageLimit: number | null;
  usedCount: number;
  startsAt: string | null;
  endsAt: string | null;
  isActive: boolean;
}

const emptyValue: PromoCodeFormValue = {
  code: "",
  promoType: "fixed",
  discountValue: "0",
  usageLimit: "",
  unlimitedUsage: true,
  startsAt: "",
  endsAt: "",
};

// 🔴 여기 있던 자체 구현을 지웠다(2026-07-31). `getFullYear()`/`getHours()` 는 **서버 시간대**를
//    따르는데 organizer 컨테이너는 TZ 미설정 = UTC 라, 프로모코드 기간이 9시간 밀려 보였다.
//    변환은 `lib/datetime/kst-local.ts` 한 곳에서만 한다 — 복제본을 다시 만들지 말 것.
function rowToFormValue(row: PromoRow): PromoCodeFormValue {
  return {
    code: row.code,
    promoType: row.promoType,
    discountValue: String(row.discountValue),
    usageLimit: row.usageLimit != null ? String(row.usageLimit) : "",
    unlimitedUsage: row.usageLimit == null,
    startsAt: toDateTimeLocal(row.startsAt),
    endsAt: toDateTimeLocal(row.endsAt),
  };
}

export function PromoCodesClient({ eventId }: { eventId: string }) {
  const [items, setItems] = useState<PromoRow[]>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<PromoRow | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  async function refresh() {
    setError(false);
    try {
      const response = await fetchWithRefresh(`/api/events/${eventId}/promo-codes`, { credentials: "include" });
      const payload = (await response.json()) as { data?: PromoRow[] };
      setItems(payload.data ?? []);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  const value = useMemo(() => emptyValue, []);
  const editValue = useMemo(() => (editing ? rowToFormValue(editing) : emptyValue), [editing]);

  async function handleEdit(form: PromoCodeFormValue) {
    if (!editing) return;
    const response = await fetchWithRefresh(`/api/events/${eventId}/promo-codes/${editing.id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: form.code,
        promoType: form.promoType,
        discountValue: Number(form.discountValue),
        usageLimit: form.unlimitedUsage ? null : Number(form.usageLimit),
        // 🔴 `new Date(naive)` 는 **브라우저 시간대**로 해석한다 (2026-07-31 코덱스 감사).
        //    읽기는 KST 로 고쳤는데(3934ee99) 쓰기가 여기서 다시 로컬 시간대를 탔다.
        //    UTC 로 설정된 PC 에서 화면의 `2026-08-20T07:00` 을 저장하면 `07:00Z` 가 되고,
        //    서버는 **시간대가 이미 붙은 값**으로 보고 그대로 보존한다(`toIsoFromKstLocal` 의
        //    두 번째 분기) → 의도한 07:00 KST 보다 9시간 늦게 적용된다. 해외 스태프 PC 면
        //    또 다른 값이 된다.
        //    ⟹ 시간대 **없는** 문자열을 그대로 보내고 서버가 KST 로 해석하게 한다.
        startsAt: form.startsAt || null,
        endsAt: form.endsAt || null,
      }),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      showError(payload?.error ?? "프로모코드 수정에 실패했습니다");
      return;
    }
    setEditing(null);
    await refresh();
    showSuccess("프로모코드가 수정되었습니다");
  }

  async function handleSubmit(form: PromoCodeFormValue) {
    const response = await fetchWithRefresh(`/api/events/${eventId}/promo-codes`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: form.code,
        promoType: form.promoType,
        discountValue: Number(form.discountValue),
        usageLimit: form.unlimitedUsage ? null : Number(form.usageLimit),
        startsAt: form.startsAt || undefined,
        endsAt: form.endsAt || undefined,
      }),
    });
    if (!response.ok) {
      showError("프로모코드 생성에 실패했습니다");
      return;
    }
    setOpen(false);
    await refresh();
    showSuccess("프로모코드가 생성되었습니다");
  }

  async function deletePromoCode() {
    if (!deletingId) return;
    const response = await fetchWithRefresh(`/api/events/${eventId}/promo-codes/${deletingId}`, {
      method: "DELETE",
      credentials: "include",
    });
    setDeletingId(null);
    if (!response.ok) {
      showError("프로모코드 삭제에 실패했습니다");
      return;
    }
    await refresh();
    showSuccess("프로모코드가 삭제되었습니다");
  }

  async function toggleActive(item: PromoRow, isActive: boolean) {
    const response = await fetchWithRefresh(`/api/events/${eventId}/promo-codes/${item.id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive }),
    });
    if (!response.ok) {
      showError("프로모코드 상태 변경에 실패했습니다");
      return;
    }
    await refresh();
    showSuccess("프로모코드 상태가 변경되었습니다");
  }

  // 확인 버튼 잠금 + 재진입 차단 + 실패 시 해제 (S3). `deletePromoCode` 이 창을 닫는다.
  const deleteAction = useConfirmAction(() => deletePromoCode());

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-muted-foreground">마케팅</p>
          <h2 className="mt-2 text-3xl font-black tracking-[-0.04em] text-foreground">프로모코드</h2>
        </div>
        <Button onClick={() => setOpen(true)}>코드 생성</Button>
      </div>
      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-14 animate-pulse rounded-lg border border-border bg-bg-muted" />
          ))}
        </div>
      ) : error ? (
        <ErrorState description="프로모코드를 불러오지 못했습니다." onRetry={() => void refresh()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={Tag}
          title="프로모코드가 없습니다"
          description="조기예매 할인이나 파트너 제휴 코드를 만들어 전환율을 높여보세요."
          actionLabel="코드 생성"
          onAction={() => setOpen(true)}
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">코드 목록</CardTitle>
          </CardHeader>
          <CardContent>
            <DataTable
              data={items}
              columns={[
                { key: "code", label: "코드" },
                {
                  key: "promoType",
                  label: "유형",
                  render: (row) => <Badge>{row.promoType === "fixed" ? "정액" : "정률"}</Badge>,
                },
                {
                  key: "discountValue",
                  label: "할인값",
                  render: (row) => (row.promoType === "fixed" ? `${row.discountValue}원` : `${row.discountValue}%`),
                },
                {
                  key: "usedCount",
                  label: "사용횟수",
                  render: (row) => `${row.usedCount}/${row.usageLimit ?? "무제한"}`,
                },
                {
                  key: "startsAt",
                  label: "시작일",
                  render: (row) => row.startsAt ? formatDateShortKst(row.startsAt) : "-",
                },
                {
                  key: "endsAt",
                  label: "종료일",
                  render: (row) => row.endsAt ? formatDateShortKst(row.endsAt) : "-",
                },
                {
                  key: "isActive",
                  label: "상태",
                  render: (row) => <Switch checked={Boolean(row.isActive)} onCheckedChange={(checked) => void toggleActive(row, checked)} />,
                },
                {
                  key: "id",
                  label: "",
                  render: (row) => (
                    <div className="flex items-center gap-2">
                      <Button variant="outline" size="icon" aria-label="프로모코드 수정" onClick={() => setEditing(row)}>
                        <Pencil className="size-4" />
                      </Button>
                      <Button variant="outline" size="icon" aria-label="프로모코드 삭제" onClick={() => setDeletingId(row.id)}>
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  ),
                },
              ]}
            />
          </CardContent>
        </Card>
      )}
      <PromoCodeForm open={open} value={value} title="프로모코드 생성" onOpenChange={setOpen} onSubmit={handleSubmit} />
      <PromoCodeForm
        open={editing !== null}
        value={editValue}
        title="프로모코드 수정"
        onOpenChange={(isOpen) => { if (!isOpen) setEditing(null); }}
        onSubmit={handleEdit}
      />
      <ConfirmDialog
        open={deletingId !== null}
        title="프로모코드 삭제"
        description="이 프로모코드를 삭제하시겠습니까? 이미 사용된 주문에는 영향이 없습니다."
        confirmText="삭제"
        pending={deleteAction.pending}
        onConfirm={deleteAction.run}
        onOpenChange={() => setDeletingId(null)}
      />
    </div>
  );
}
