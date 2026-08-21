"use client";

import type { Dispatch, SetStateAction } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface ProductOption {
  id: string;
  name: string;
}
export interface AttendeeAddForm {
  name: string;
  email: string;
  phone: string;
  productId: string;
}

interface AttendeeAddDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  form: AttendeeAddForm;
  setForm: Dispatch<SetStateAction<AttendeeAddForm>>;
  products: ProductOption[];
  error: string | null;
  onCreate: () => void;
}

export function AttendeeAddDialog({ open, onOpenChange, form, setForm, products, error, onCreate }: AttendeeAddDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>참석자 추가</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="attendee-name">이름</Label>
            <Input id="attendee-name" value={form.name} onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="attendee-email">이메일</Label>
              <Input id="attendee-email" value={form.email} onChange={(event) => setForm((prev) => ({ ...prev, email: event.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="attendee-phone">전화번호</Label>
              <Input id="attendee-phone" value={form.phone} onChange={(event) => setForm((prev) => ({ ...prev, phone: event.target.value }))} />
            </div>
          </div>
          <div className="space-y-2">
            <Label>상품</Label>
            <Select value={form.productId} onValueChange={(value) => setForm((prev) => ({ ...prev, productId: value }))}>
              <SelectTrigger aria-label="상품 선택">
                <SelectValue placeholder="상품을 선택해주세요" />
              </SelectTrigger>
              <SelectContent>
                {products.map((product) => (
                  <SelectItem key={product.id} value={product.id}>
                    {product.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            취소
          </Button>
          <Button onClick={onCreate}>추가</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
