import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { getPool } from "@/lib/db/pool";
import { ERR } from "@/lib/errors";
import { issueCashReceipt } from "@/lib/tax/cashReceipt";
import { issueTaxInvoice } from "@/lib/tax/invoice";
import { getOrder, recordTaxInvoice, V2CommerceError } from "@/lib/v2/commerce-client";

type Params = { eventId: string; orderId: string };

const receiptSchema = z.object({
  type: z.enum(["tax_invoice", "cash_receipt"]),
  businessNumber: z.string().optional(),
  companyName: z.string().optional(),
  identityNumber: z.string().optional(),
});

export const POST = withRole<Params>("organizer", async (request, { session, params }) => {
  try {
    const body = receiptSchema.parse(await request.json());
    const pool = getPool();
    // 소유 검증은 go orders(account 스코프) — v2_order_id 앵커만 조회.
    const orderResult = await pool.query<{ v2_order_id: string | null }>(
      `
        SELECT v2_order_id
        FROM orders
        WHERE account_id = $1 AND event_id = $2 AND id = $3
        LIMIT 1
      `,
      [session.accountId, params.eventId, params.orderId],
    );

    if (orderResult.rows.length === 0) {
      return errorResponse(ERR.NOT_FOUND, 404);
    }

    const v2OrderId = orderResult.rows[0]?.v2_order_id;
    if (!v2OrderId) {
      return errorResponse("주문이 v2 와 연결되지 않아 영수증을 발행할 수 없습니다 (v2_order_id 누락)", 409);
    }

    // 금액 SoT = v2 단건 주문 read(total_amount). go-local 표시 금액 대신 canonical 사용.
    const orderDetail = await getOrder(v2OrderId, { idempotencyKey: `go-receipt:${params.orderId}` });
    const amount = Number(orderDetail.total_amount ?? 0);

    if (body.type === "tax_invoice") {
      if (!body.businessNumber || !body.companyName) {
        return errorResponse("사업자등록번호와 회사명을 입력해주세요", 400);
      }

      const taxAmount = Math.round(amount / 11);
      // 발행 대행 호출이 먼저 — 성공한 것만 원장에 남긴다. 여기서 crash 하면 원장은 비어
      // 있으므로 재시도가 같은 (주문, 종류) 로 1건만 만든다(v2 부분 유니크가 보증).
      const issued = await issueTaxInvoice({
        orderId: params.orderId,
        businessNumber: body.businessNumber,
        companyName: body.companyName,
        amount,
        taxAmount,
      });

      // 원장 = v2 정본(T2-REST 이관). go tax_invoices 직접 INSERT 폐기.
      const { created } = await recordTaxInvoice(v2OrderId, session.accountId, {
        receipt_type: "tax_invoice",
        amount,
        tax_amount: taxAmount,
        business_number: body.businessNumber,
        company_name: body.companyName,
        provider: "popbill",
        status: "requested",
        meta: issued as unknown as Record<string, unknown>,
      });

      // created=false = 이미 발행된 주문(동시요청/재시도) → 201 이 아니라 200 으로 구분.
      return successResponse(issued, created ? 201 : 200);
    }

    if (!body.identityNumber) {
      return errorResponse("현금영수증 식별번호를 입력해주세요", 400);
    }

    const issued = await issueCashReceipt({
      orderId: params.orderId,
      identityNumber: body.identityNumber,
      amount,
      type: "income",
    });

    // 식별번호 원문은 원장에 남기지 않는다(개인정보) — 꼬리 4자리만 보관.
    const { created } = await recordTaxInvoice(v2OrderId, session.accountId, {
      receipt_type: "cash_receipt",
      amount,
      tax_amount: 0,
      company_name: "현금영수증",
      identity_tail: body.identityNumber.slice(-4),
      provider: "popbill",
      status: "requested",
      meta: issued as unknown as Record<string, unknown>,
    });

    return successResponse(issued, created ? 201 : 200);
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    }
    if (err instanceof V2CommerceError) {
      // v2 4xx(주문 미존재 등)는 그대로 전파, 5xx/네트워크는 502.
      const status = err.status >= 400 && err.status < 500 ? err.status : 502;
      return errorResponse(err.message, status);
    }
    return errorResponse(ERR.SERVER, 500);
  }
});
