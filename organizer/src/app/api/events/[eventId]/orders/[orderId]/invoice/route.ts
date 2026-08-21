import React from "react";
import { renderToBuffer, type DocumentProps } from "@react-pdf/renderer";
import { errorResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { formatDate } from "@/lib/format";
import { InvoicePDF } from "@/lib/pdf/invoice-template";
import { getOrderDetail } from "@/lib/server/orders";
import { V2CommerceError } from "@/lib/v2/commerce-client";
import { EventAccessError, getOwnedEvent } from "@/lib/v2/event-access";

type Params = { eventId: string; orderId: string };

/**
 * 거래명세서(인보이스) PDF.
 *
 * W2-ORD: 이벤트 제목을 go `SELECT title FROM events WHERE account_id=$1 AND id=$2` 로 읽던 것을
 * v2 소유검증 조회(`getOwnedEvent`)로 대체했다. 그 SQL 은 제목뿐 아니라 **테넌트 경계**도
 * 겸하고 있었으므로 단순 삭제가 아니라 동일 경계를 가진 v2 조회로 치환해야 한다.
 *
 * 🔴 fail-closed: 예전엔 `getOrderDetail` 이 던지는 V2CommerceError 가 잡히지 않아 v2 장애가
 * 500(원인 불명)으로 나갔고, 이벤트 조회 실패는 주문 404 와 뭉뚱그려졌다.
 * 이제 없음/미소유 = 404, v2 장애 = 503(재시도 가능)으로 분리한다.
 *
 * 멱등: 이 라우트는 순수 GET(렌더만) — 발행 원장을 만들지 않으므로 재요청이 문서를 2건
 * 만들지 않는다. 부수효과가 생기면 그때는 안정 멱등키가 필요하다.
 */
export const GET = withRole<Params>("organizer", async (_request, { session, params }) => {
  let detail: Awaited<ReturnType<typeof getOrderDetail>>;
  let event: Awaited<ReturnType<typeof getOwnedEvent>>;
  try {
    [detail, event] = await Promise.all([
      getOrderDetail(session.accountId, params.eventId, params.orderId),
      getOwnedEvent(params.eventId, session.accountId),
    ]);
  } catch (err: unknown) {
    if (err instanceof EventAccessError) {
      return err.reason === "not_found"
        ? errorResponse("주문을 찾을 수 없습니다", 404)
        : errorResponse("거래명세서를 발급하지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    if (err instanceof V2CommerceError) {
      if (err.status === 404) return errorResponse("주문을 찾을 수 없습니다", 404);
      return errorResponse("거래명세서를 발급하지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    throw err;
  }

  if (!detail || !event) {
    return errorResponse("주문을 찾을 수 없습니다", 404);
  }

  const document = InvoicePDF({
    order: {
      orderNumber: String(detail.orderNumber),
      buyerName: String(detail.buyerName),
      orderedAt: formatDate(String(detail.orderedAt)),
      totalAmount: Number(detail.totalAmount ?? 0),
      paidAmount: Number(detail.paidAmount ?? 0),
      // platformFee: v2 단건 read SoT(fee 동결 전이면 null → 0). 별도 go-local 쿼리 제거.
      platformFee: Number(detail.platformFee ?? 0),
    },
    event: { title: event.title ?? "" },
    items: (detail.items as Array<Record<string, unknown>>).map((item) => ({
      productName: String(item.productName ?? ""),
      quantity: Number(item.quantity ?? 0),
      unitPrice: Number(item.unitPrice ?? 0),
      totalAmount: Number(item.totalAmount ?? 0),
    })),
  }) as React.ReactElement<DocumentProps>;

  const buffer = await renderToBuffer(document);

  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="invoice-${String(detail.orderNumber)}.pdf"`,
    },
  });
});
