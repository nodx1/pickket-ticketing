"use client";

import { formatKRW } from "@/lib/format";

interface OrderItemRow {
  id: string;
  productName: string;
  quantity: number;
  totalAmount: number;
  cancelledAt: string | null;
}

interface OrderItemsManagerProps {
  items: OrderItemRow[];
}

/**
 * 주문 라인(상품 단위) 표시. 취소는 티켓(참석자) 단위로만 정확히 매핑되므로
 * "참석자 목록"의 티켓 취소로 이동했다(라인 아이템은 v2 상품 라인이라 개별 티켓 id 를 갖지 않음).
 */
export function OrderItemsManager({ items }: OrderItemsManagerProps) {
  return (
    <div className="space-y-3">
      {items.map((item) => (
        <div
          key={item.id}
          className="grid grid-cols-[1fr_auto_auto] items-center gap-4 rounded-lg border border-border bg-muted px-4 py-3 text-sm"
        >
          <p className="font-medium text-foreground">{item.productName}</p>
          <p className="text-muted-foreground">{item.quantity}개</p>
          <p className="text-foreground">
            {formatKRW(item.totalAmount)}
            {item.cancelledAt ? <span className="ml-2 text-xs text-warning">취소됨</span> : null}
          </p>
        </div>
      ))}
      <p className="text-xs text-muted-foreground">개별 티켓 취소·환불은 아래 &quot;참석자 목록&quot;에서 진행할 수 있습니다.</p>
    </div>
  );
}
