"use client";

import { PackagePlus, Pencil, Trash2 } from "lucide-react";
import { useConfirmAction } from "@/lib/hooks/useConfirmAction";
import { PricingRules } from "./pricing-rules";
import { useEffect, useMemo, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { ProductForm, type ProductFormValue } from "@/components/forms/product-form";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatKRW } from "@/lib/format";
import { showError, showSuccess } from "@/lib/hooks/useToast";
import { fetchWithRefresh } from "@/lib/fetchWithAuth";

interface ProductItem {
  id: string;
  name: string;
  description: string | null;
  type: "ticket" | "addon" | "bundle" | "donation";
  price: number;
  stock: number | null;
  minPerOrder: number;
  maxPerOrder: number | null;
  taxIncluded: boolean;
  taxRate: number;
  saleStartsAt: string | null;
  saleEndsAt: string | null;
  soldCount: number;
  isActive: boolean;
  bundleItems: Array<{ productId: string; quantity: number; productName: string; price: number }>;
}

const emptyProduct: ProductFormValue = {
  name: "",
  description: "",
  type: "ticket",
  price: "0",
  isFree: false,
  stock: "",
  unlimitedStock: true,
  minPerOrder: "1",
  maxPerOrder: "",
  saleStartsAt: "",
  saleEndsAt: "",
  taxIncluded: true,
  taxRate: "10",
  bundleItems: [],
};

const TYPE_TABS = [
  { key: "all", label: "전체" },
  { key: "ticket", label: "티켓" },
  { key: "addon", label: "부가상품" },
  { key: "bundle", label: "번들" },
  { key: "donation", label: "후원" },
] as const;

export function EventProductsClient({ eventId }: { eventId: string }) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [items, setItems] = useState<ProductItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ProductItem | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string>(() => searchParams.get("type") ?? "all");

  function handleTypeChange(key: string) {
    setActiveTab(key);
    const params = new URLSearchParams(searchParams.toString());
    if (key === "all") {
      params.delete("type");
    } else {
      params.set("type", key);
    }
    const qs = params.toString();
    router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
  }

  useEffect(() => {
    let active = true;
    async function fetchProducts() {
      setLoading(true);
      try {
        const response = await fetchWithRefresh(`/api/events/${eventId}/products`, { credentials: "include" });
        const payload = (await response.json()) as { data?: ProductItem[] };
        if (active) {
          setItems(payload.data ?? []);
        }
      } finally {
        if (active) setLoading(false);
      }
    }
    void fetchProducts();
    return () => {
      active = false;
    };
  }, [eventId]);

  const currentValue = useMemo<ProductFormValue>(() => {
    if (!editing) {
      return emptyProduct;
    }

    return {
      id: editing.id,
      name: editing.name,
      description: editing.description ?? "",
      type: editing.type,
      price: String(editing.price),
      isFree: editing.price === 0,
      stock: editing.stock ? String(editing.stock) : "",
      unlimitedStock: editing.stock === null,
      minPerOrder: String(editing.minPerOrder),
      maxPerOrder: editing.maxPerOrder ? String(editing.maxPerOrder) : "",
      saleStartsAt: editing.saleStartsAt ? editing.saleStartsAt.slice(0, 16) : "",
      saleEndsAt: editing.saleEndsAt ? editing.saleEndsAt.slice(0, 16) : "",
      taxIncluded: editing.taxIncluded,
      taxRate: String(editing.taxRate),
      bundleItems: editing.bundleItems.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
      })),
    };
  }, [editing]);

  async function refreshProducts() {
    const response = await fetchWithRefresh(`/api/events/${eventId}/products`, { credentials: "include" });
    const payload = (await response.json()) as { data?: ProductItem[] };
    setItems(payload.data ?? []);
  }

  async function handleSubmit(value: ProductFormValue) {
    const url = editing ? `/api/events/${eventId}/products/${editing.id}` : `/api/events/${eventId}/products`;
    const method = editing ? "PATCH" : "POST";
    const response = await fetchWithRefresh(url, {
      method,
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });

    const payload = (await response.json()) as { error?: string };
    if (!response.ok) {
      throw new Error(payload.error ?? "상품 저장에 실패했습니다");
    }

    await refreshProducts();
    setEditing(null);
    setOpen(false);
    showSuccess(editing ? "상품이 수정되었습니다" : "상품이 추가되었습니다");
  }

  async function handleDelete() {
    if (!deletingId) {
      return;
    }
    const response = await fetchWithRefresh(`/api/events/${eventId}/products/${deletingId}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (response.ok) {
      await refreshProducts();
      showSuccess("상품이 삭제되었습니다");
    } else {
      showError("상품 삭제에 실패했습니다");
    }
    setDeletingId(null);
  }

  // 확인 버튼 잠금 + 재진입 차단 + 실패 시 해제 (S3). `handleDelete` 이 창을 닫는다.
  const deleteAction = useConfirmAction(() => handleDelete());

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-sm text-muted-foreground">판매 구성</p>
          <h2 className="mt-2 text-3xl font-black tracking-[-0.04em] text-foreground">상품 & 티켓</h2>
        </div>
        <Button onClick={() => { setEditing(null); setOpen(true); }}>
          <PackagePlus className="size-4" />
          상품 추가
        </Button>
      </div>

      {loading ? (
        <div className="grid gap-5 xl:grid-cols-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <Card key={`product-skeleton-${index}`} className="overflow-hidden border-border bg-card/95">
              <CardHeader className="space-y-3">
                <Skeleton className="h-6 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid gap-3 lg:grid-cols-2">
                  <Skeleton className="h-4" />
                  <Skeleton className="h-4" />
                  <Skeleton className="h-4" />
                  <Skeleton className="h-4" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState title="상품이 없습니다" description="무료 초대권, 얼리버드, 부가서비스 상품을 먼저 구성해보세요." actionLabel="상품 추가" onAction={() => setOpen(true)} />
      ) : (
        <>
          {/* 타입별 탭 필터 */}
          <div className="flex flex-wrap gap-2">
            {TYPE_TABS.filter((tab) => tab.key === "all" || items.some((item) => item.type === tab.key)).map((tab) => {
              const count = tab.key === "all" ? items.length : items.filter((item) => item.type === tab.key).length;
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => handleTypeChange(tab.key)}
                  className={`rounded-full border px-4 py-1.5 text-sm font-medium transition ${
                    activeTab === tab.key
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground"
                  }`}
                >
                  {tab.label} <span className="ml-1 text-xs opacity-70">{count}</span>
                </button>
              );
            })}
          </div>
        <div className="grid gap-5 xl:grid-cols-2">
          {items.filter((item) => activeTab === "all" || item.type === activeTab).map((item) => (
            <Card key={item.id} className="overflow-hidden border-border bg-card/95">
              <CardHeader className="flex-row items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-3">
                    <CardTitle className="truncate text-foreground">{item.name}</CardTitle>
                    <Badge variant={item.isActive ? "success" : "outline"}>{item.isActive ? "판매중" : "비활성"}</Badge>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">{item.description || "설명이 아직 등록되지 않았습니다."}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="icon" aria-label="상품 수정" onClick={() => { setEditing(item); setOpen(true); }}>
                    <Pencil className="size-4" />
                  </Button>
                  <Button variant="outline" size="icon" aria-label="상품 삭제" onClick={() => setDeletingId(item.id)}>
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-3 text-sm text-muted-foreground lg:grid-cols-2">
                  <p>가격: {formatKRW(item.price)}</p>
                  <p>판매 수량: {item.soldCount.toLocaleString("ko-KR")}개</p>
                  <p>총 수량: {item.stock === null ? "무제한" : `${item.stock.toLocaleString("ko-KR")}개`}</p>
                  <p>주문 수량: 최소 {item.minPerOrder} / 최대 {item.maxPerOrder ?? "제한 없음"}</p>
                  {item.type === "bundle" ? (
                    <p className="lg:col-span-2">
                      구성 상품: {item.bundleItems.map((bundleItem) => `${bundleItem.productName} x${bundleItem.quantity}`).join(", ") || "없음"}
                    </p>
                  ) : null}
                </div>
                <PricingRules eventId={eventId} productId={item.id} />
              </CardContent>
            </Card>
          ))}
        </div>
        </>
      )}

      <ProductForm
        open={open}
        value={currentValue}
        title={editing ? "상품 수정" : "상품 추가"}
        onOpenChange={setOpen}
        onSubmit={handleSubmit}
        availableProducts={items.filter((item) => item.id !== editing?.id).map((item) => ({
          id: item.id,
          name: item.name,
          price: item.price,
        }))}
      />

      <ConfirmDialog
        open={Boolean(deletingId)}
        title="상품을 삭제할까요?"
        description="삭제한 상품은 복구할 수 없습니다."
        confirmText="삭제하기"
        pending={deleteAction.pending}
        onConfirm={deleteAction.run}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            setDeletingId(null);
          }
        }}
      />
    </div>
  );
}
