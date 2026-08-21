import { z } from "zod";
import { getPool } from "@/lib/db/pool";
import { withAuth } from "@/lib/auth/withAuth";
import { successResponse, errorResponse } from "@/lib/apiResponse";
import { logger } from "@/lib/logger";
import { createOrder, V2CommerceError } from "@/lib/server/orders";
import { ensureCompProduct } from "@/lib/server/rsvp-product";
import { requireIdempotencyKey } from "@/lib/server/idempotency";

const confirmSchema = z.object({
  rows: z.array(z.object({
    name: z.string().min(1),
    email: z.string().email(),
    phone: z.string().optional(),
    productName: z.string().optional(),
    quantity: z.number().int().positive().optional(),
  })),
});

/**
 * CSV 임포트 확정 — 감사 P1-8.
 *
 * 기존엔 orders/attendees 를 go DB 에 직접 INSERT 했으나(order_number 누락 + attendees.product_id
 * 미존재 컬럼 참조로 항상 실패하는 데드코드였다), 표준 createOrder(v2 SSOT) 경유로 통일한다.
 * 임포트 참석자는 0원 발권(원 결제는 외부/이전 플랫폼) 이므로 판매상품과 별개인 숨김 0원 "초대권"
 * tier 로 주문을 만든다. 원 상품명은 answers 메타로 기록. 행 단위로 처리하며, 일부 실패는 건너뛰고
 * 계속한다(배치 전체 실패 방지).
 */
export const POST = withAuth(async (request, { session, params }) => {
  const { eventId } = params as { eventId: string };
  let rawBody: unknown;
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    const file = formData.get("file");
    const mappingRaw = formData.get("mapping");
    if (!(file instanceof Blob) || typeof mappingRaw !== "string") {
      return errorResponse("CSV 파일과 컬럼 매핑이 필요합니다", 400);
    }
    const mapping = JSON.parse(mappingRaw) as Array<{
      header: string;
      field: string | null;
    }>;
    const lines = (await file.text()).split(/\r?\n/).filter((line) => line.trim());
    const headers = (lines.shift() ?? "")
      .split(",")
      .map((value) => value.trim().replace(/^"|"$/g, ""));
    const fieldByIndex = headers.map(
      (header) => mapping.find((item) => item.header === header)?.field ?? null,
    );
    rawBody = {
      rows: lines.map((line) => {
        const cells = line
          .split(",")
          .map((value) => value.trim().replace(/^"|"$/g, ""));
        const row: Record<string, string | number> = {};
        fieldByIndex.forEach((field, index) => {
          if (!field) return;
          row[field] =
            field === "quantity"
              ? Number(cells[index] || "1")
              : (cells[index] ?? "");
        });
        return row;
      }),
    };
  } else {
    rawBody = await request.json();
  }
  const body = confirmSchema.parse(rawBody);
  let batchIdempotencyKey: string;
  try {
    batchIdempotencyKey = requireIdempotencyKey(request);
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Idempotency-Key 헤더가 필요합니다", 400);
  }
  const pool = getPool();

  // 초대권(0원) 상품 보장 — v2 tier 앵커까지. 미연결 시 재시도 유도.
  let comp: { productId: string } | null;
  try {
    comp = await ensureCompProduct(pool, eventId, session.accountId);
  } catch {
    return errorResponse("임포트에 실패했습니다", 500);
  }
  if (!comp) {
    return errorResponse("이벤트가 커머스(v2)에 아직 연결되지 않았습니다. 잠시 후 다시 시도해주세요.", 503);
  }

  let imported = 0;
  const failures: Array<{ email: string; reason: string }> = [];

  for (const [rowIndex, row] of body.rows.entries()) {
    try {
      await createOrder({
        accountId: session.accountId,
        eventId,
        buyerName: row.name,
        buyerEmail: row.email.trim().toLowerCase(),
        buyerPhone: row.phone,
        items: [{ productId: comp.productId, quantity: row.quantity ?? 1 }],
        paymentMethod: "offline",
        status: "completed",
        paymentStatus: "paid",
        totalAmountOverride: 0,
        paidAmount: 0,
        source: "direct",
        answers: {
          _import: "true",
          ...(row.productName ? { _intendedProductName: row.productName } : {}),
        },
        idempotencyToken: `${batchIdempotencyKey}:row:${rowIndex}:${row.email.trim().toLowerCase()}`,
      });
      imported += 1;
    } catch (err: unknown) {
      // 행 단위 실패는 수집 후 계속(배치 전체를 깨뜨리지 않음).
      const reason = err instanceof V2CommerceError
        ? "커머스 동기화 실패(잠시 후 재시도)"
        : err instanceof Error ? err.message : "알 수 없는 오류";
      failures.push({ email: row.email, reason });
      logger.warn("CSV 임포트 행 실패", { eventId, email: row.email, reason });
    }
  }

  return successResponse({ imported, failed: failures.length, failures });
});
