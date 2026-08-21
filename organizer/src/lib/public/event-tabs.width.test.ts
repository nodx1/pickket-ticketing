import { describe, expect, it } from "vitest";

import { resolveEventTabs } from "./event-tabs";

/**
 * 🔴 탭 라벨이 길어져 **모바일에서 잘리는 것**을 막는 폭 예산 (2026-07-31 실사고).
 *
 * ## 무슨 일이 있었나
 * 라벨 넷(`행사 소개 / 프로그램·일정 / 장소·주차 안내 / 문의·공유`)의 총폭이 **417px** 인데
 * 390px 기기의 탭 바는 **358px** 이었다. 마지막 탭이 화면 밖으로 잘렸다.
 * `overflow-x-auto` 는 걸려 있었지만 **스크롤바를 숨겨놨고 스냅도 없어서**
 * "옆에 더 있다"는 단서가 하나도 없었다 — 사용자는 그냥 잘린 줄 안다.
 *
 * 게다가 잘린 마지막 탭이 하필 **공유 버튼이 든 탭**이었다. 기능이 있는데 닿을 수가 없었다.
 *
 * ## 왜 단위 테스트로 폭을 재나
 * 진짜 폭은 브라우저만 안다. 하지만 **라벨을 늘리는 커밋**은 여기서 막을 수 있다 —
 * 그게 이 사고의 실제 원인이었다. Playwright 로 재는 건 배포 뒤에나 돌고,
 * 그때는 이미 대표가 먼저 본다.
 *
 * ## 추정치의 근거
 * 사고 당시 실측(417px)에 맞춰 글자폭을 역산했다. 추정은 **실측보다 크게** 나오도록
 * 잡았다(같은 입력에 436 추정 / 417 실측) — 예산 가드는 낙관적이면 쓸모가 없다.
 */

/** text-sm(14px) Pretendard 기준 근사폭. 실측 417px 에 맞춰 보정한 값. */
const HAN = 13; // 한글·전각
const MIDDOT = 6; // '·'
const SPACE = 4;
const LATIN = 8;

/** TabsTrigger `px-3`(모바일) 좌우 합. `sm:` 이상에서는 더 넓지만 화면도 넓다. */
const TRIGGER_PADDING = 24;
/** TabsList `p-1` + border 1px×2. */
const LIST_CHROME = 10;

function labelWidth(label: string): number {
  let px = 0;
  for (const ch of label) {
    if (ch === "·") px += MIDDOT;
    else if (ch === " ") px += SPACE;
    else if (ch.charCodeAt(0) < 128) px += LATIN;
    else px += HAN;
  }
  return px + TRIGGER_PADDING;
}

function tabBarWidth(labels: string[]): number {
  return labels.reduce((sum, l) => sum + labelWidth(l), 0) + LIST_CHROME;
}

/**
 * 지원 최소 실사용 폭. Galaxy S 계열 360px − 페이지 좌우 여백(`px-4` 32px).
 * (320px iPhone SE 는 스냅 스크롤이 받는다 — 거기까지 맞추면 라벨이 뜻을 잃는다)
 */
const BUDGET = 360 - 32;

describe("공개 상세 탭은 모바일 폭 안에 들어간다", () => {
  /** 탭 넷이 모두 켜지는 최대 구성 — 잘림은 항상 여기서 먼저 난다. */
  const fullLabels = resolveEventTabs({
    scheduleCount: 1,
    venueAddress: "제주특별자치도 서귀포시",
    parkingInfo: "P1",
  }).map((t) => t.label);

  it("탭 넷이 다 켜진 구성이 실제로 넷이다 — 아니면 이 예산은 헛돈다", () => {
    expect(fullLabels).toHaveLength(4);
  });

  it("🔴 360px 기기에서 마지막 탭이 잘리지 않는다", () => {
    const width = tabBarWidth(fullLabels);
    expect(
      width,
      `탭 총폭 ${width}px > 예산 ${BUDGET}px — 마지막 탭이 잘린다.\n` +
        `라벨: ${fullLabels.join(" / ")}\n` +
        `라벨을 늘리려면 상세 문구를 패널 안 제목으로 옮길 것(탭 라벨은 이름표지 설명이 아니다).`,
    ).toBeLessThanOrEqual(BUDGET);
  });

  it("사고 당시 라벨은 이 예산에서 걸린다 — 가드가 실제로 잡는지 확인", () => {
    const before = ["행사 소개", "프로그램·일정", "장소·주차 안내", "문의·공유"];
    expect(tabBarWidth(before)).toBeGreaterThan(BUDGET);
  });
});
