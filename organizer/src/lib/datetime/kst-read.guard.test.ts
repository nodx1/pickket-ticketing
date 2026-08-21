import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { toDateTimeLocal } from "@/lib/date";

/**
 * 🔴 저장된 시각을 **화면에 다시 그릴 때** 서버 시간대로 새지 않게 막는다 (2026-07-31 실사고).
 *
 * ## 무슨 일이 있었나 — 같은 결함을 하루에 두 번
 * 오전에 **쓰기 경로 19곳**을 `toIsoFromKstLocal` 로 고치고 가드까지 달았다
 * (`kst-write.guard.test.ts`). 그런데 **읽기 경로는 보지 않았다.**
 *
 *     DB          2026-08-19T22:00Z   (= KST 8/20 07:00, 정확함)
 *     설정 화면    8월 19일 22:00      ← UTC 그대로. 9시간 거짓말
 *
 * 원인은 `date.ts` 의 `getFullYear()`/`getHours()` — **코드가 도는 곳**의 시간대를 쓴다.
 * organizer 컨테이너는 `TZ` 미설정 = UTC 다.
 *
 * 🔴 이게 단순 표시 오류로 끝나지 않는 이유: 주최자가 **그 화면을 보고 저장**하면
 *    9시간 밀린 값이 그때 진짜로 DB 에 들어간다. 읽기 버그가 쓰기 버그를 낳는다.
 *
 * ## 왜 구조 가드인가
 * `toDateTimeLocal` 이 옳아도 **각 화면이 자기 버전을 다시 만들면** 소용없다.
 * 실제로 `promo-codes-client.tsx` 에 복제본이 있었고 같은 버그를 갖고 있었다.
 */
const DASHBOARD_ROOT = path.join(process.cwd(), "src/app/(dashboard)");

/** 로컬 시간대에 의존하는 날짜 조립 — `getFullYear()` 로 datetime-local 문자열을 만드는 패턴. */
const LOCAL_TZ_FORMAT = /getFullYear\(\)[\s\S]{0,400}?getMinutes\(\)/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name) && !name.includes(".test.")) out.push(full);
  }
  return out;
}

describe("toDateTimeLocal — KST 고정", () => {
  it("🔴 UTC 저장값을 KST 로 되돌린다 (사고 당시 실제 값)", () => {
    // 2026-08-19T22:00Z 는 한국시각 8월 20일 07:00 이다. 1R 시작시각과 같아야 한다.
    expect(toDateTimeLocal("2026-08-19T22:00:00.000Z")).toBe("2026-08-20T07:00");
  });

  it("자정 경계에서도 날짜가 밀리지 않는다", () => {
    // KST 8/20 00:00 = 전날 15:00Z. 환불 마감 기준시각이라 여기가 틀리면 하루가 통째로 어긋난다.
    expect(toDateTimeLocal("2026-08-19T15:00:00.000Z")).toBe("2026-08-20T00:00");
  });

  it("Date 객체도 같은 결과를 낸다", () => {
    expect(toDateTimeLocal(new Date("2026-08-19T22:00:00.000Z"))).toBe("2026-08-20T07:00");
  });

  it.each(["", "not-a-date"])("잘못된 입력(%o)은 빈 문자열", (v) => {
    expect(toDateTimeLocal(v)).toBe("");
  });
});

describe("대시보드 화면은 날짜 변환을 자체 구현하지 않는다", () => {
  const files = walk(DASHBOARD_ROOT);

  it("스캔 대상이 실제로 있다 — 경로가 틀리면 이 가드는 조용히 통과한다", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("🔴 `getFullYear()`…`getMinutes()` 로 datetime-local 을 조립하는 화면이 없다", () => {
    const bad = files
      .filter((f) => LOCAL_TZ_FORMAT.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(DASHBOARD_ROOT, f));

    expect(
      bad,
      "서버 시간대(UTC)로 조립돼 한국시각이 9시간 밀려 보인다. " +
        "`toDateTimeLocal`(= lib/datetime/kst-local) 을 쓸 것:\n  " +
        bad.join("\n  "),
    ).toEqual([]);
  });
});
