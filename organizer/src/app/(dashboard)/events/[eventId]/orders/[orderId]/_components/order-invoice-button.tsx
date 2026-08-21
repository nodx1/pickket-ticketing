"use client";

import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";

interface OrderInvoiceButtonProps {
  eventId: string;
  orderId: string;
}

export function OrderInvoiceButton({ eventId, orderId }: OrderInvoiceButtonProps) {
  return (
    <Button variant="outline" onClick={() => window.open(`/api/events/${eventId}/orders/${orderId}/invoice`, "_blank", "noopener,noreferrer")}>
      <Download className="size-4" />
      영수증 다운로드
    </Button>
  );
}
