"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface PromoCodeFormValue {
  code: string;
  promoType: "fixed" | "percentage";
  discountValue: string;
  usageLimit: string;
  unlimitedUsage: boolean;
  startsAt: string;
  endsAt: string;
}

interface PromoCodeFormProps {
  open: boolean;
  value: PromoCodeFormValue;
  title: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (value: PromoCodeFormValue) => Promise<void>;
}

export function PromoCodeForm({ open, value, title, onOpenChange, onSubmit }: PromoCodeFormProps) {
  const [form, setForm] = useState<PromoCodeFormValue>(value);

  useEffect(() => {
    setForm(value);
  }, [value]);

  function generateCode() {
    setForm((prev) => ({
      ...prev,
      code: Math.random().toString(36).slice(2, 10).toUpperCase(),
    }));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-[1fr_auto]">
            <div className="space-y-2">
              <Label htmlFor="promo-code">코드</Label>
              <Input
                id="promo-code"
                value={form.code}
                onChange={(event) => setForm((prev) => ({ ...prev, code: event.target.value.toUpperCase() }))}
              />
            </div>
            <Button variant="outline" className="self-end" onClick={generateCode}>
              자동 생성
            </Button>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-2">
              <Label>할인 유형</Label>
              <Select
                value={form.promoType}
                onValueChange={(value: "fixed" | "percentage") => setForm((prev) => ({ ...prev, promoType: value }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="fixed">정액</SelectItem>
                  <SelectItem value="percentage">정률</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="discount-value">할인값</Label>
              <Input
                id="discount-value"
                type="number"
                value={form.discountValue}
                onChange={(event) => setForm((prev) => ({ ...prev, discountValue: event.target.value }))}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="usage-limit">사용 한도</Label>
            <Input
              id="usage-limit"
              type="number"
              disabled={form.unlimitedUsage}
              value={form.usageLimit}
              onChange={(event) => setForm((prev) => ({ ...prev, usageLimit: event.target.value }))}
            />
            <div className="flex items-center gap-3 rounded-lg border border-border bg-muted px-3 py-2">
              <Checkbox
                id="unlimited-usage"
                checked={form.unlimitedUsage}
                onCheckedChange={(checked) =>
                  setForm((prev) => ({
                    ...prev,
                    unlimitedUsage: checked === true,
                    usageLimit: checked === true ? "" : prev.usageLimit,
                  }))
                }
              />
              <Label htmlFor="unlimited-usage">무제한 사용</Label>
            </div>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="promo-start">시작일</Label>
              <Input
                id="promo-start"
                type="datetime-local"
                value={form.startsAt}
                onChange={(event) => setForm((prev) => ({ ...prev, startsAt: event.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="promo-end">종료일</Label>
              <Input
                id="promo-end"
                type="datetime-local"
                value={form.endsAt}
                onChange={(event) => setForm((prev) => ({ ...prev, endsAt: event.target.value }))}
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            취소
          </Button>
          <Button onClick={() => void onSubmit(form)}>저장</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
