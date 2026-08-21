/**
 * 🔴 일정 안내 이미지 — v2 JSONB 왕복 (2026-08-19 대표 요청)
 *
 * ## 왜 이 층에 테스트가 필요한가
 * `image_url` 은 **1-S 계약(time·title·description)에 없는 go 확장 키**다. v2 는 이 키를
 * 알지 못하고 JSONB 를 통째로 받아 통째로 돌려준다. 즉 **보존은 우리 어댑터가 책임진다** —
 * `toV2Schedules` 가 안 실으면 저장한 이미지는 다음 수정 때 조용히 사라진다.
 * (같은 방식으로 `ends_at`·`venue_name`·`sort_order` 가 이미 실려 있다.)
 *
 * ## 🔴 「모름」과 「없음」
 * 옛 일정 행에는 `image_url` 키 자체가 없다. 그건 **오류가 아니라 없음**이고, `null` 로
 * 복원해야 화면이 "이미지 없는 일정" 으로 그린다.
 */
import { describe, expect, it } from "vitest";
import { parseV2Schedules, toV2Schedules } from "./event-schedules";

const IMG = "https://cdn.pickket.kr/uploads/general/round1.png";

const base = {
  id: "s1",
  time: "2026-08-20T01:00:00.000Z",
  title: "1라운드",
  description: "조편성",
  ends_at: null,
  venue_name: "포천힐스CC",
  sort_order: 0,
};

describe("event_schedules 어댑터 — 안내 이미지", () => {
  it("저장된 image_url 을 imageUrl 로 복원한다", () => {
    const [item] = parseV2Schedules([{ ...base, image_url: IMG }]);
    expect(item.imageUrl).toBe(IMG);
  });

  it("🔴 키가 없으면 null — 옛 일정 행은 오류가 아니라 이미지가 없는 것이다", () => {
    const [item] = parseV2Schedules([base]);
    expect(item.imageUrl).toBeNull();
  });

  it("🔴 문자열이 아니면 null — 숫자·객체가 화면에 src 로 들어가지 않는다", () => {
    expect(parseV2Schedules([{ ...base, image_url: 12 }])[0].imageUrl).toBeNull();
    expect(parseV2Schedules([{ ...base, image_url: { url: IMG } }])[0].imageUrl).toBeNull();
  });

  it("🔴 다시 저장할 때 image_url 을 싣는다 — 안 실으면 다음 수정에 이미지가 사라진다", () => {
    const restored = parseV2Schedules([{ ...base, image_url: IMG }]);
    const sent = toV2Schedules(restored) as unknown as Array<Record<string, unknown>>;
    expect(sent[0].image_url).toBe(IMG);
    // 왕복 무손실: 기존 확장 키도 같이 살아 있어야 한다.
    expect(sent[0]).toMatchObject({ id: "s1", venue_name: "포천힐스CC", sort_order: 0 });
  });

  it("이미지를 뗀 항목은 null 로 나간다 — 키를 빼면 v2 에 옛 값이 남는다", () => {
    const [item] = parseV2Schedules([{ ...base, image_url: IMG }]);
    const sent = toV2Schedules([{ ...item, imageUrl: null }]) as unknown as Array<Record<string, unknown>>;
    expect(sent[0]).toHaveProperty("image_url");
    expect(sent[0].image_url).toBeNull();
  });
});
