import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

/**
 * 🔴 현장업체 API 의 **경계** — 관계로 본다 (2026-08-10)
 *
 * 라우트 핸들러는 env·v2 클라이언트·rate limit HOF 가 딸려 와 단위 실행이 어렵다.
 * "키 검증이 있다" 가 아니라 *무엇을 부르고 **무엇을 안 부르는가*** 를 본다 —
 * 구멍은 그 관계가 깨지는 자리에 생긴다.
 */
async function source(rel: string): Promise<string> {
  const raw = await readFile(new URL(rel, import.meta.url), "utf8");
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
}

const ONSITE = "../../app/api/onsite/checkin/route.ts";
const DASHBOARD = "../../app/api/events/[eventId]/check-in/route.ts";

describe("🔴 인증 — 경로 자체가 권한이다", () => {
  it("🔴 전용 키를 **상수시간**으로 비교한다", async () => {
    const s = await source(ONSITE);
    expect(s).toMatch(/timingSafeEqual/);
    expect(s).toMatch(/ONSITE_CHECKIN_KEY/);
    // 키가 틀리면 401 — 그 분기가 실제로 있어야 한다
    expect(s).toMatch(/keyMatches\([\s\S]{0,120}?\)\s*\)\s*\{[\s\S]{0,200}?401/);
  });

  it("🔴 키가 없으면 **닫혀 있다** — 미설정이 곧 개방이 되면 안 된다", async () => {
    const s = await source(ONSITE);
    expect(s).toMatch(/if\s*\(!expected\s*\|\|\s*!eventId\)[\s\S]{0,300}?503/);
  });

  it("🔴 조직자 세션·내부 서비스 토큰을 재사용하지 않는다", async () => {
    const s = await source(ONSITE);
    expect(s, "업체에 우리 내부 신뢰 경계를 주면 안 된다").not.toMatch(
      /withRole|withAuth|X-Pickket-Service-Token|getServiceToken/i,
    );
  });

  it("🔴 이벤트가 env 로 고정된다 — 요청 값으로 행사를 고르지 않는다", async () => {
    const s = await source(ONSITE);
    expect(s).toMatch(/ONSITE_CHECKIN_EVENT_ID/);
    // 본문·쿼리에서 eventId 를 받지 않는다
    expect(s).not.toMatch(/body\.event|searchParams\.get\(\s*["']event/);
    // 소유 경계에 쓰는 accountId 는 **고정 행사에서** 끌어온다
    expect(s).toMatch(/resolvePublicEventById\(\s*eventId/);
  });
});

describe("🔴 응답 계약", () => {
  it("🔴 admitted 와 reentry_ok 를 구분해 내보낸다", async () => {
    const s = await source(ONSITE);
    expect(s).toMatch(/result:\s*admitted\.outcome/);
    // 성공을 하나로 뭉개는 **대입**이 없어야 한다(타입 선언의 유니온은 제외 — 쉼표로 가른다)
    expect(s).not.toMatch(/result:\s*["']admitted["']\s*,/);
  });

  it("업체 본문은 **평평하다** — {success,data} 봉투를 씌우지 않는다", async () => {
    const s = await source(ONSITE);
    expect(s).not.toMatch(/successResponse\(/);
    expect(s).toMatch(/Response\.json\(payload/);
  });

  it("거부는 result/reason/message 세 필드를 준다", async () => {
    expect(await source(ONSITE)).toMatch(
      /\{\s*result:\s*["']rejected["'],\s*reason,\s*message\s*\}/,
    );
  });
});

describe("🔴 Y4 — 두 경로가 같은 판정을 쓴다", () => {
  it("현장 API 와 대시보드가 **같은 공통 함수**를 쓴다", async () => {
    const onsite = await source(ONSITE);
    const dash = await source(DASHBOARD);
    expect(onsite).toMatch(/resolveScanPayload\(/);
    expect(dash, "대시보드가 공통 함수를 안 쓰면 규칙이 두 벌이 된다").toMatch(
      /resolveScanPayload\(/,
    );
  });

  it("🔴 대시보드가 QR 검증을 **자체 구현으로 되돌리지** 않았다", async () => {
    const dash = await source(DASHBOARD);
    expect(dash).not.toMatch(/verifyDynamicQRPayload\(/);
    expect(dash).not.toMatch(/startsWith\(["']PKT:["']\)/);
  });

  it("🔴 현장 API 가 입장 자격 판정을 새로 만들지 않았다", async () => {
    const s = await source(ONSITE);
    // v2 를 직접 부르지 않는다 — 공통 함수를 통해서만 간다
    expect(s).not.toMatch(/checkInTicket\(/);
    expect(s).toMatch(/admitTicketByNumber\(/);
  });
});

describe("🔴 오프라인 — 현장 시각을 그대로 넘긴다", () => {
  it("scanned_at 을 admit 에 넘긴다 (now 로 덮지 않는다)", async () => {
    const s = await source(ONSITE);
    expect(s).toMatch(/at:\s*scannedAt/);
    expect(s, "여기서 now 를 쓰면 입장일이 하루 밀린다").not.toMatch(
      /at:\s*new Date\(\)\.toISOString\(\)/,
    );
  });

  it("형식이 잘못된 scanned_at 은 거부한다", async () => {
    expect(await source(ONSITE)).toMatch(/Number\.isNaN\(Date\.parse\(scannedAt\)\)/);
  });
});


/**
 * 🔴 개인정보 — 이번 변경의 무게 (2026-08-10)
 *
 * 전화번호는 유출 시 파장이 이름과 다르다. 업체 스캐너 로그가 그대로
 * **관람객 연락처 명단**이 된다.
 */
describe("🔴 전화번호 노출 경계", () => {
  it("🔴 성공 응답에만 holder_phone 이 있다", async () => {
    const s = await source(ONSITE);
    // 성공 payload 에는 있다
    expect(s).toMatch(/holder_phone:\s*admitted\.holder\.phone/);
  });

  it("🔴 거부 응답에는 **없다** — QR 을 던져 번호를 긁어낼 수 없다", async () => {
    const s = await source(ONSITE);
    // reject/serverSide 는 고정 필드만 낸다. holder 를 참조하면 안 된다.
    const rejectFn = s.match(/function reject\([\s\S]*?\n\}/)?.[0] ?? "";
    const serverFn = s.match(/function serverSide\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(rejectFn).not.toMatch(/phone|holder/);
    expect(serverFn).not.toMatch(/phone|holder/);
    // 401 인라인 응답에도 없다
    expect(s).not.toMatch(/reason:\s*["']unauthorized["'][\s\S]{0,120}?phone/);
  });

  it("🔴 로그에 전화번호를 남기지 않는다", async () => {
    const s = await source(ONSITE);
    for (const m of s.matchAll(/logger\.\w+\(([\s\S]*?)\);/g)) {
      expect(m[1], `로그에 전화번호가 샌다: ${m[1]?.slice(0, 80)}`).not.toMatch(
        /phone|holder\.name|holder_name/,
      );
    }
  });

  it("🔴 참석자 이름이 **구매자로 되돌아가지** 않았다", async () => {
    const s = await source(ONSITE);
    expect(s).toMatch(/holder_name:\s*admitted\.holder\.name/);
    expect(s, "t.order.buyer 를 다시 읽으면 지인 표에 구매자 이름이 뜬다").not.toMatch(
      /holder_name:\s*t\.order\.buyer/,
    );
  });
});
