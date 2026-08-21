"use client";

import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ImageUpload } from "@/components/shared/image-upload";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { PRODUCT_TYPE_LABELS } from "@/lib/constants";
import { formatKRW } from "@/lib/format";

const productSchema = z.object({
  name: z.string().min(2, "상품명은 2자 이상이어야 합니다"),
  description: z.string().optional(),
  type: z.enum(["ticket", "addon", "bundle", "donation"]),
  price: z.string().optional(),
  stock: z.string().optional(),
  minPerOrder: z.string().min(1, "최소 주문 수량을 입력해주세요"),
  maxPerOrder: z.string().optional(),
  saleStartsAt: z.string().optional(),
  saleEndsAt: z.string().optional(),
  taxRate: z.string().optional(),
});

export interface ProductFormValue {
  id?: string;
  name: string;
  description: string;
  type: "ticket" | "addon" | "bundle" | "donation";
  price: string;
  isFree: boolean;
  stock: string;
  unlimitedStock: boolean;
  minPerOrder: string;
  maxPerOrder: string;
  saleStartsAt: string;
  saleEndsAt: string;
  taxIncluded: boolean;
  taxRate: string;
  bundleItems: Array<{ productId: string; quantity: number }>;
  imageUrl?: string;
}

interface ProductFormProps {
  open: boolean;
  value: ProductFormValue;
  title: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (value: ProductFormValue) => Promise<void>;
  availableProducts?: Array<{ id: string; name: string; price: number }>;
}

export function ProductForm({
  open,
  value,
  title,
  onOpenChange,
  onSubmit,
  availableProducts = [],
}: ProductFormProps) {
  const [form, setForm] = useState<ProductFormValue>(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setForm(value);
  }, [value]);

  const includedTotal = useMemo(
    () =>
      form.bundleItems.reduce((sum, item) => {
        const matched = availableProducts.find((product) => product.id === item.productId);
        return sum + (matched ? matched.price * item.quantity : 0);
      }, 0),
    [availableProducts, form.bundleItems],
  );

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);

    const parsed = productSchema.safeParse(form);
    if (!parsed.success) {
      setSaving(false);
      setError(parsed.error.issues[0]?.message ?? "입력값을 확인해주세요");
      return;
    }

    try {
      await onSubmit(form);
      onOpenChange(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "상품 저장에 실패했습니다");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form className="space-y-5" onSubmit={handleSubmit}>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="product-name">상품명</Label>
              <Input id="product-name" value={form.name} onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label>유형</Label>
              <Select value={form.type} onValueChange={(value: ProductFormValue["type"]) => setForm((prev) => ({ ...prev, type: value }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(PRODUCT_TYPE_LABELS).map(([entryValue, label]) => (
                    <SelectItem key={entryValue} value={entryValue}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>상품 이미지</Label>
            <ImageUpload
              value={form.imageUrl ?? ""}
              onChange={(url) => setForm((prev) => ({ ...prev, imageUrl: url }))}
              label="상품 이미지"
            />
            <Label htmlFor="product-description">설명</Label>
            <Textarea id="product-description" rows={5} value={form.description} onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))} />
          </div>

          {form.type === "bundle" ? (
            <div className="space-y-4 rounded-lg border border-primary/20 bg-primary/10 px-4 py-4">
              <div>
                <p className="text-sm font-semibold text-foreground">구성 상품 선택</p>
                <p className="mt-1 text-sm text-muted-foreground">기존 상품을 선택하고 수량을 설정하면 번들 구성으로 저장됩니다.</p>
              </div>
              <div className="space-y-3">
                {availableProducts.length === 0 ? (
                  <p className="text-sm text-muted-foreground">선택 가능한 기존 상품이 없습니다.</p>
                ) : availableProducts.map((product) => {
                  const selectedItem = form.bundleItems.find((item) => item.productId === product.id);
                  return (
                    <div key={product.id} className="rounded-lg border border-border bg-background/60 px-4 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <label className="flex items-center gap-3 text-sm text-foreground">
                          <Checkbox
                            checked={Boolean(selectedItem)}
                            onCheckedChange={(checked) =>
                              setForm((prev) => ({
                                ...prev,
                                bundleItems: checked === true
                                  ? [...prev.bundleItems, { productId: product.id, quantity: 1 }]
                                  : prev.bundleItems.filter((item) => item.productId !== product.id),
                              }))
                            }
                          />
                          {product.name}
                        </label>
                        <span className="text-sm text-muted-foreground">{formatKRW(product.price)}</span>
                      </div>
                      {selectedItem ? (
                        <div className="mt-3 flex items-center gap-3">
                          <Label className="text-sm text-muted-foreground">수량</Label>
                          <Input
                            type="number"
                            min="1"
                            value={String(selectedItem.quantity)}
                            onChange={(event) => {
                              const quantity = Math.max(1, Number(event.target.value) || 1);
                              setForm((prev) => ({
                                ...prev,
                                bundleItems: prev.bundleItems.map((item) => item.productId === product.id ? { ...item, quantity } : item),
                              }));
                            }}
                          />
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              <div className="rounded-lg border border-border bg-background/60 px-4 py-3 text-sm text-muted-foreground">
                구성 상품 합계: {formatKRW(includedTotal)} · 번들 가격: {formatKRW(Number(form.price || "0"))} · 할인액: {formatKRW(Math.max(includedTotal - Number(form.price || "0"), 0))}
              </div>
            </div>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="product-price">가격 (원)</Label>
              <Input id="product-price" type="number" min="0" value={form.price} disabled={form.isFree} onChange={(event) => setForm((prev) => ({ ...prev, price: event.target.value }))} />
              <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2">
                <Checkbox
                  id="product-free"
                  checked={form.isFree}
                  onCheckedChange={(checked) =>
                    setForm((prev) => ({
                      ...prev,
                      isFree: checked === true,
                      price: checked === true ? "0" : prev.price,
                    }))
                  }
                />
                <Label htmlFor="product-free" className="cursor-pointer">무료 상품</Label>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="product-stock">수량</Label>
              <Input id="product-stock" type="number" min="1" value={form.stock} disabled={form.unlimitedStock} onChange={(event) => setForm((prev) => ({ ...prev, stock: event.target.value }))} />
              <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2">
                <Checkbox
                  id="product-unlimited"
                  checked={form.unlimitedStock}
                  onCheckedChange={(checked) =>
                    setForm((prev) => ({
                      ...prev,
                      unlimitedStock: checked === true,
                      stock: checked === true ? "" : prev.stock,
                    }))
                  }
                />
                <Label htmlFor="product-unlimited" className="cursor-pointer">수량 무제한</Label>
              </div>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="product-min-order">최소 주문 수량</Label>
              <Input id="product-min-order" type="number" min="1" value={form.minPerOrder} onChange={(event) => setForm((prev) => ({ ...prev, minPerOrder: event.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="product-max-order">최대 주문 수량</Label>
              <Input id="product-max-order" type="number" min="1" value={form.maxPerOrder} onChange={(event) => setForm((prev) => ({ ...prev, maxPerOrder: event.target.value }))} />
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="product-sale-start">판매 시작일</Label>
              <Input id="product-sale-start" type="datetime-local" value={form.saleStartsAt} onChange={(event) => setForm((prev) => ({ ...prev, saleStartsAt: event.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="product-sale-end">판매 종료일</Label>
              <Input id="product-sale-end" type="datetime-local" value={form.saleEndsAt} onChange={(event) => setForm((prev) => ({ ...prev, saleEndsAt: event.target.value }))} />
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 px-3 py-3">
              <Checkbox id="product-tax-included" checked={form.taxIncluded} onCheckedChange={(checked) => setForm((prev) => ({ ...prev, taxIncluded: checked === true }))} />
              <Label htmlFor="product-tax-included" className="cursor-pointer">세금 포함 금액입니다</Label>
            </div>
            <div className="space-y-2">
              <Label htmlFor="product-tax-rate">세율</Label>
              <Input id="product-tax-rate" type="number" min="0" max="100" value={form.taxRate} onChange={(event) => setForm((prev) => ({ ...prev, taxRate: event.target.value }))} />
            </div>
          </div>

          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>취소</Button>
            <Button type="submit" disabled={saving}>{saving ? "저장 중..." : "저장하기"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
