import { NextResponse } from "next/server";

export function successResponse<T>(data: T, status = 200) {
  return NextResponse.json(
    {
      success: true,
      data,
    },
    { status },
  );
}

export function errorResponse(message: string, status = 400, code?: string) {
  return NextResponse.json(
    {
      success: false,
      error: message,
      // 🔴 기계가 읽을 오류코드(가산). 화면이 **문구를 파싱하게 두면 문구를 못 고친다**.
      //    안 주면 필드 자체가 없다 — 기존 소비자 계약 무변.
      ...(code ? { code } : {}),
    },
    { status },
  );
}

export function listResponse<T>(
  items: T[],
  total: number,
  page?: number,
  limit?: number,
  /**
   * 목록별 가산 메타.
   *
   * 🔴 필터를 **서버가 실제로 적용했는지**를 화면에 알려주는 용도로 쓴다(주문 목록).
   *    없으면 화면은 "요청했으니 됐겠지" 로 가정하고, 원천이 무시하면 **조용히 전체**를
   *    보여준다 — 그걸 발주처가 「실판매 N건」으로 읽는다.
   */
  extraMeta?: Record<string, unknown>,
) {
  return NextResponse.json({
    success: true,
    data: items,
    meta: {
      total,
      ...(typeof page === "number" ? { page } : {}),
      ...(typeof limit === "number" ? { limit } : {}),
      ...(extraMeta ?? {}),
    },
  });
}
