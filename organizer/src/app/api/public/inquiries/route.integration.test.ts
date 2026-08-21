// ⚠️ W5-SUPPORT: 문의 원장이 go `event_inquiries` → v2 로 이관됐다(go 마이그 253 DROP).
//    이 테스트는 **레이트리밋(Redis) 검증**이 목적이라 원장 위치와 무관하지만, 옛 go DB
//    정리 쿼리는 테이블이 사라져 실패하므로 제거했다. 남는 행은 v2 쪽에서 정리한다.
import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/public/inquiries/route";

const describeIntegration = describe.skipIf(process.env.RUN_INTEGRATION !== "1");
const slug = "audit-event";
const prefix = `rate-audit-${Date.now()}`;

/**
 * @param cfIp        `CF-Connecting-IP` — 프로덕션에서 버킷을 가르는 **정본** 값.
 * @param forwardedFor 선택. 스푸핑 시도를 재현하기 위한 XFF 체인.
 */
function inquiry(question: string, cfIp: string | null, forwardedFor?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfIp) headers["cf-connecting-ip"] = cfIp;
  if (forwardedFor) headers["x-forwarded-for"] = forwardedFor;
  return new Request("http://localhost/api/public/inquiries", {
    method: "POST",
    headers,
    body: JSON.stringify({ slug, question }),
  });
}

describeIntegration("public inquiry rate limits against isolated Redis", () => {
  it("CF-Connecting-IP 로 버킷이 갈린다 — 한 IP 는 5회에서 막히고 다른 IP 는 통과", async () => {
    const firstFive = await Promise.all(
      Array.from({ length: 5 }, (_, index) => POST(inquiry(`${prefix}-unique-${index}`, "198.51.100.10"))),
    );
    expect(firstFive.every((response) => response.status === 201)).toBe(true);
    const sixth = await POST(inquiry(`${prefix}-unique-5`, "198.51.100.10"));
    expect(sixth.status).toBe(429);

    const otherIp = await POST(inquiry(`${prefix}-other-ip`, "198.51.100.11"));
    expect(otherIp.status).toBe(201);

    const duplicateFirst = await POST(inquiry(`${prefix}-duplicate`, "198.51.100.12"));
    const duplicateSecond = await POST(inquiry(`${prefix}-duplicate`, "198.51.100.12"));
    expect(duplicateFirst.status).toBe(201);
    expect(duplicateSecond.status).toBe(429);
  });

  /**
   * 🔴 종전 이 테스트는 `TRUSTED_PROXY` 를 지워 "전부 한 버킷"을 확인했다. 그 env 가
   *    prod 에 없어서 **상시 그 상태**였다는 것이 이 배치의 발견이라, env 조작을 걷어내고
   *    실제 방어 대상으로 바꿨다: XFF 앞머리를 매 요청 바꿔도 버킷이 갈리지 않아야 한다.
   *    (CF 는 XFF 에 append 하므로 앞머리는 클라이언트가 정한다)
   */
  it("XFF 앞머리를 바꿔도 새 버킷이 생기지 않는다 — 한도가 무한이 되면 안 된다", async () => {
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        POST(inquiry(`${prefix}-spoof-${index}`, "198.51.100.20", `203.0.113.${index + 1}, 198.51.100.20`)),
      ),
    );
    expect(responses.filter((response) => response.status === 429).length).toBeGreaterThanOrEqual(1);
  });
});
