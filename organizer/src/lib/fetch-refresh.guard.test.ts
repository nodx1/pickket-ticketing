/**
 * 대시보드 클라이언트 코드는 **생짜 `fetch(` 를 쓰지 않는다** — 기계로 지킨다.
 *
 * ── 왜 ──
 * access 쿠키가 5분(`max_age`)이라 브라우저가 지운다. 그런데 refresh(7일)·logged_in(7일)은
 * 남아 화면은 로그인 상태로 보이고, 이미 그려진 대시보드는 재검증되지 않는다.
 * ⟹ 사용자는 **저장 버튼을 누른 그 순간** 처음 만료를 알고, 그땐 입력이 날아간다.
 *
 * refresh 자체는 멀쩡했다. 갱신 트리거가 `fetchWithAuth` 하나뿐인데 대시보드 쓰기 대부분이
 * 생짜 `fetch` 였을 뿐이다 — **인증 버그가 아니라 배선 누락**이었다.
 *
 * ── 왜 주석이 아니라 테스트인가 ──
 * 래퍼는 처음부터 있었는데 아무도 안 썼고, 그래서 사고가 났다. 고쳐도 막지 않으면 내일 또 는다.
 * 이 검사는 안 읽어도 잡는다.
 *
 * ── 대상 ──
 * `src/app/(dashboard)` · `src/components` · `src/lib/seats` 의 **클라이언트 컴포넌트**만.
 *   · 서버 파일은 브라우저 쿠키가 없는 자리라 대상이 아니다(변환하면 오히려 깨진다).
 *   · 🔴 `src/app/(public)` 은 **제외**한다 — 게스트(비로그인) 경로라 401 이 "세션 만료"가
 *     아니라 원래 인증이 없는 것이다. 갱신을 붙이면 결제·환불 같은 부작용 경로에서
 *     불필요한 재시도가 생긴다. 게스트 세션 만료는 매직링크·주문토큰 설계의 몫이다.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = path.join(__dirname, "..");

const ROOTS = [path.join(SRC, "app", "(dashboard)"), path.join(SRC, "components"), path.join(SRC, "lib", "seats")];

/**
 * 허용 목록 — **우리 오리진이 아닌 호출**만. 사유 없이 늘리지 말 것.
 *
 * `fetchWithRefresh` 는 401 이면 우리 `/api/auth/refresh` 를 부르고 재시도한다.
 * 다른 오리진에는 의미가 없거나(다른 인증 체계) 해로울 수 있다.
 */
const ALLOWLIST: Array<{ rel: string; count: number; why: string }> = [
  // 2026-07-31 제거 — checkin 도 갱신 경로에 배선했다(`fetchWithRefresh` + 함수 init).
  //   "우리 refresh 로는 v2 가 안 갱신된다" 던 전제가 틀렸다: v2 access 쿠키는
  //   `Domain=.pickket.kr` 이라 `go.` 에서 갱신하면 `api.` 호출에도 실린다(설정 실측).
  {
    rel: "app/(dashboard)/events/[eventId]/seat-map/_components/seat-map-editor.tsx",
    count: 1,
    why: "외부 S3/MinIO 서명 URL(lib/storage/s3.ts:130). 쿠키를 보내지 않는 것이 의도",
  },
];

/** 멤버 호출(`x.fetch(`)·`fetchWithAuth(`·`fetchWithRefresh(` 는 제외하고 생짜 `fetch(` 만. */
const BARE_FETCH = /(?<![.\w])fetch\(/g;

function isClientComponent(src: string): boolean {
  return src.slice(0, 200).includes('"use client"');
}

function stripComments(raw: string): string {
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function tsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFiles(full));
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

function bareFetchCounts(): Map<string, number> {
  const out = new Map<string, number>();
  for (const root of ROOTS) {
    for (const file of tsFiles(root)) {
      const raw = fs.readFileSync(file, "utf8");
      if (!isClientComponent(raw)) continue;
      const hits = stripComments(raw).match(BARE_FETCH);
      if (hits) out.set(path.relative(SRC, file).split(path.sep).join("/"), hits.length);
    }
  }
  return out;
}

describe("대시보드 클라이언트 — 생짜 fetch 금지", () => {
  it("§0 대상 파일을 실제로 수집했다 (경로 오타로 조용히 통과 방지)", () => {
    const files = ROOTS.flatMap((r) => tsFiles(r));
    expect(files.length, "대상 루트에서 파일을 못 읽었다").toBeGreaterThan(50);
    const clients = files.filter((f) => isClientComponent(fs.readFileSync(f, "utf8")));
    expect(clients.length, "클라이언트 컴포넌트를 하나도 못 찾았다").toBeGreaterThan(20);
  });

  it("§0-A 판정 정규식이 동작한다 (합성 입력)", () => {
    const hits = (s: string) => (s.match(BARE_FETCH) ?? []).length;
    expect(hits("const r = await fetch('/api/x');")).toBe(1);
    expect(hits("await fetchWithRefresh('/api/x')"), "래퍼를 위반으로 세면 전건 빨개진다").toBe(0);
    expect(hits("await fetchWithAuth('/api/x')")).toBe(0);
    expect(hits("await page.fetch('/api/x')"), "멤버 호출은 대상이 아니다").toBe(0);
    expect(hits("void fetch('/api/metrics')"), "await 없는 형태도 잡는다").toBe(1);
    // 주석은 stripComments 가 걷어낸다
    expect(hits(stripComments("// await fetch('/api/x')\nconst a = 1;"))).toBe(0);
  });

  it("허용 목록에 없는 생짜 fetch 가 없다", () => {
    const actual = bareFetchCounts();
    const allowed = new Map(ALLOWLIST.map((a) => [a.rel, a.count]));
    const offenders: string[] = [];
    for (const [rel, n] of actual) {
      const cap = allowed.get(rel) ?? 0;
      if (n > cap) offenders.push(`${rel}: ${n}건 (허용 ${cap})`);
    }
    expect(
      offenders,
      "access 쿠키가 5분이라 생짜 fetch 는 저장 시점에 401 로 죽고 입력이 날아간다.\n" +
        "  `import { fetchWithRefresh } from \"@/lib/fetchWithAuth\"` 로 바꿀 것.\n" +
        "  우리 오리진이 아니면 이 파일의 ALLOWLIST 에 **사유와 함께** 추가할 것:\n  " +
        offenders.join("\n  "),
    ).toEqual([]);
  });

  it("허용 목록이 낡지 않았다 — 고쳤으면 목록도 줄여야 한다", () => {
    const actual = bareFetchCounts();
    const stale = ALLOWLIST.filter((a) => (actual.get(a.rel) ?? 0) < a.count).map(
      (a) => `${a.rel}: 실제 ${actual.get(a.rel) ?? 0}건 < 허용 ${a.count}건`,
    );
    expect(stale, stale.join("\n  ")).toEqual([]);
  });

  it("🔴 (public) 은 대상이 아니다 — 게스트 경로를 영원히 빨갛게 만들지 않는다", () => {
    const publicDir = path.join(SRC, "app", "(public)");
    expect(fs.existsSync(publicDir)).toBe(true);
    expect(
      ROOTS.some((r) => r.startsWith(publicDir)),
      "(public) 이 대상에 들어가면 게스트 경로가 전부 위반이 된다",
    ).toBe(false);
  });
});
