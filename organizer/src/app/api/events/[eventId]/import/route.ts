import { withAuth } from "@/lib/auth/withAuth";
import { successResponse, errorResponse } from "@/lib/apiResponse";

export const POST = withAuth(async (request) => {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!file || !(file instanceof Blob)) return errorResponse("CSV 파일을 업로드해주세요", 400);

    const text = await file.text();
    const lines = text.split("\n").filter((l) => l.trim());
    if (lines.length < 2) return errorResponse("CSV 데이터가 부족합니다", 400);

    const headers = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
    const sampleRows = lines.slice(1, 4).map((line) =>
      line.split(",").map((c) => c.trim().replace(/^"|"$/g, "")),
    );

    // AI column mapping suggestion
    const knownMappings: Record<string, string> = {
      이름: "name", 성명: "name", name: "name",
      이메일: "email", email: "email", "e-mail": "email",
      전화: "phone", 전화번호: "phone", phone: "phone", 연락처: "phone",
      티켓: "productName", "티켓유형": "productName", ticket: "productName",
      수량: "quantity", quantity: "quantity",
    };

    const mapping = headers.map((header) => {
      const lower = header.toLowerCase();
      for (const [key, value] of Object.entries(knownMappings)) {
        if (lower.includes(key.toLowerCase())) return { header, field: value, confidence: 0.9 };
      }
      return { header, field: null, confidence: 0 };
    });

    return successResponse({
      headers,
      sampleRows,
      mapping,
      totalRows: lines.length - 1,
    });
  } catch (err: unknown) {
    return errorResponse(err instanceof Error ? err.message : "CSV 분석에 실패했습니다", 500);
  }
});
