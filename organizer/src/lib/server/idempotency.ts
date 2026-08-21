export function requireIdempotencyKey(request: Request): string {
  const key = request.headers.get("idempotency-key")?.trim() ?? "";
  if (key.length < 16 || key.length > 200) {
    throw new Error("Idempotency-Key 헤더가 필요합니다");
  }
  return key;
}
