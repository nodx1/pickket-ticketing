/**
 * 🔴 프로그램 탭 자유문구 배선 (2026-08-02).
 *
 * ## 왜 「반쪽」으로 멈춰 있었나
 * `event-tabs.ts` 는 처음부터 `programNotes`·`stageInfo` 를 **입력으로 선언**하고
 * `hasProgramTab()` 이 그걸 본다. 그런데 **아무도 공급하지 않았다** —
 * 공개 상세가 `resolveEventTabs` 에 안 넘겼고, 저장할 화면도 없었다.
 * 그래서 프로그램 탭이 **일정(scheduleCount)으로만** 켜졌다.
 *
 * ⚠️ **v2 노출 2줄이 선행이다**(`internal_commerce.py` `_event_detail_dict`).
 *    v2 는 컬럼도 있고 `EventUpdate` 로 받기도 하는데 **상세 read 에 노출이 없다**.
 *    그 전까지 이 값들은 `null` 로 오고, 화면은 **값 없는 경우로 정상 동작**해야 한다 —
 *    아래 "값이 없어도" 검사가 그것을 고정한다.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hasProgramTab, resolveEventTabs } from "./event-tabs";

const SRC = path.join(__dirname, "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), "utf8");

describe("프로그램 탭 판정", () => {
  it("🔴 자유문구만 있어도 탭이 켜진다 (종전엔 일정이 있어야만 켜졌다)", () => {
    expect(hasProgramTab({ programNotes: "1부 오프닝\n2부 본선" })).toBe(true);
    expect(hasProgramTab({ stageInfo: "A구역은 무대 정면" })).toBe(true);
  });

  it("일정만 있어도 켜진다 (종전 동작 보존)", () => {
    expect(hasProgramTab({ scheduleCount: 2 })).toBe(true);
  });

  it("🔴 둘 다 없으면 안 켜진다 — 빈 탭을 만들지 않는다", () => {
    expect(hasProgramTab({})).toBe(false);
    expect(hasProgramTab({ programNotes: "   ", stageInfo: "", scheduleCount: 0 })).toBe(false);
  });

  it("🔴 v2 노출 전(null)에도 터지지 않고 그냥 안 켜진다", () => {
    // 이게 배포 순서를 지키지 못했을 때의 상태다. 화면이 깨지면 안 된다.
    expect(() => resolveEventTabs({ programNotes: null, stageInfo: null })).not.toThrow();
    expect(hasProgramTab({ programNotes: null, stageInfo: null })).toBe(false);
  });

  it("탭 목록에 program 이 들어간다", () => {
    const ids = resolveEventTabs({ description: "소개", programNotes: "1부" }).map((t) => t.id);
    expect(ids).toContain("program");
  });
});

/**
 * 배선 가드 — 네 층이 **모두** 있어야 값이 오간다. 하나만 빠져도 「반쪽」이 된다.
 * ⚠️ 이름이 파일에 있는지가 아니라 **어느 자리에 쓰였는지**를 본다
 *    (오늘만 세 번, import 만 남기고 통과하는 가드를 만들었다).
 */
describe("네 층 배선", () => {
  it("② PATCH 가 v2 로 보낸다 — 빈 문자열은 null 로", () => {
    const route = read("app/api/events/[eventId]/route.ts");
    expect(route).toMatch(/programNotes:\s*z\.string\(\)\.optional\(\)/);
    expect(route, "빈 문자열을 그대로 보내면 '값은 있는데 안 보이는' 상태가 된다").toMatch(
      /patch\.program_notes\s*=\s*body\.programNotes\s*\|\|\s*null/,
    );
    expect(route).toMatch(/patch\.stage_info\s*=\s*body\.stageInfo\s*\|\|\s*null/);
  });

  it("③ v2 응답 → 뷰 매핑", () => {
    const view = read("lib/v2/event-view.ts");
    expect(view).toMatch(/programNotes:\s*str\(content\.program_notes\)/);
    expect(view).toMatch(/stageInfo:\s*str\(content\.stage_info\)/);
  });

  it("🔴 ④ 공개 상세가 탭 판정에 실제로 넘긴다 (여기가 비어 있어서 반쪽이었다)", () => {
    const page = read("app/(public)/e/[eventSlug]/page.tsx");
    const call = page.slice(page.indexOf("resolveEventTabs({"), page.indexOf("resolveEventTabs({") + 700);
    // ⚠️ `programNotes:` 가 있는지만 보면 `programNotes: null` 로 바꿔도 통과한다
    //    (실측: 그 뮤테이션이 생존했다). **실제 값을 넘기는지**를 본다.
    expect(call, "resolveEventTabs 에 실제 값이 아니라 상수를 넘기고 있다").toMatch(
      /programNotes:\s*introPrograms\.programNotes/,
    );
    expect(call).toMatch(/stageInfo:\s*introPrograms\.stageInfo/);
  });

  /**
   * 🔴 이 검사가 이 파일의 핵심이다.
   *
   * `event-tabs.ts` 가 못박아 둔 원칙: **"렌더가 생길 때 조건을 함께 넣는다.
   * 그 반대 순서는 항상 빈 탭을 만든다."** 실제로 2026-07-28 자체검수에서
   * 조건만 있고 렌더가 없던 두 건(`isOnline`·`stageInfo`)이 제거된 적이 있다.
   *
   * 조건을 넓히면서 렌더를 안 넣으면 손님은 **제목만 있고 내용이 없는 탭**을 본다.
   */
  it("🔴 탭 판정에 쓰는 필드는 패널에 렌더 블록이 있다 (빈 탭 방지)", () => {
    const tabs = read("lib/public/event-tabs.ts");
    const page = read("app/(public)/e/[eventSlug]/page.tsx");
    const cond = tabs.slice(tabs.indexOf("export function hasProgramTab"), tabs.indexOf("export function hasVenueTab"));

    // ⚠️ "그 이름이 파일에 있다" 로는 부족하다 — `{false ? (` 로 바꿔 렌더를 죽여도
    //    이름은 다른 줄(resolveEventTabs 인자)에 남아 통과한다(실측: 생존했다).
    //    **조건부 렌더의 형태 자체**를 단언한다.
    for (const [field, guard] of [
      ["programNotes", /\{introPrograms\.programNotes \? \(/],
      ["stageInfo", /\{introPrograms\.stageInfo \? \(/],
    ] as Array<[string, RegExp]>) {
      if (!cond.includes(field)) continue; // 조건에 없으면 렌더도 필요 없다
      expect(page, `hasProgramTab 이 ${field} 를 보는데 패널에 렌더 블록이 없다 — 빈 탭이 된다`).toMatch(guard);
    }
  });

  it("⑤ 주최자가 입력할 칸이 있고 제출에 실린다", () => {
    const form = read("components/forms/event-form.tsx");
    expect(form, "입력 칸이 없으면 주최자는 이미지로 때울 수밖에 없다").toMatch(
      /id="event-program-notes"/,
    );
    expect(form).toMatch(/id="event-stage-info"/);
    expect(form, "폼에 값만 있고 제출에 안 실리면 저장되지 않는다").toMatch(
      /programNotes:\s*form\.programNotes/,
    );
    const settings = read("app/(dashboard)/events/[eventId]/settings/page.tsx");
    expect(settings, "기존 값을 안 채우면 편집할 때마다 지워진다").toMatch(
      /programNotes:\s*event\.programNotes/,
    );
  });
});
