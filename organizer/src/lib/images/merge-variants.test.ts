/**
 * 🔴 대표 이미지를 바꿔도 **직접 올린 세로는 남는가**.
 *
 * 2026-08-04 대표 지적: 메인 히어로만 교체했는데 세로(모바일)까지 같이 바뀌었다.
 * 원인은 `imageVariants` 통째 대입 — 새 대표의 자동 렌디션(`-portrait`)이
 * 손으로 올린 세로를 밀어냈다.
 *
 * ⚠️ 세로를 따로 올리게 만든 이유가 그 자동 중앙크롭이었다. 대표를 한 번 갈아끼우면
 *    원상복구되니, 주최자는 **왜 되돌아가는지 모른 채** 매번 다시 올려야 했다.
 */
import { describe, expect, it } from "vitest";
import { isAutoPortrait, mergeKeepingManualPortrait } from "./merge-variants";

const CDN = "https://cdn.pickket.kr/pickket-uploads/go/event/20260804";
const NEW = {
  wide: `${CDN}/newbase-wide.webp`,
  portrait: `${CDN}/newbase-portrait.webp`,
  thumb: `${CDN}/newbase-thumb.webp`,
  og: `${CDN}/newbase-og.jpg`,
};

describe("자동 렌디션 판별", () => {
  it("-portrait 접미사가 있으면 자동", () => {
    expect(isAutoPortrait(`${CDN}/abc-portrait.webp`)).toBe(true);
  });

  it("마스터 URL(접미사 없음)은 직접 올린 것", () => {
    expect(isAutoPortrait(`${CDN}/abc.webp`)).toBe(false);
  });

  it("쿼리·해시가 붙어도 판별한다 — CDN 이 ?v= 를 붙일 수 있다", () => {
    expect(isAutoPortrait(`${CDN}/abc-portrait.webp?v=2`)).toBe(true);
    expect(isAutoPortrait(`${CDN}/abc.webp?v=2`)).toBe(false);
  });

  it("빈 값은 자동이 아니다", () => {
    expect(isAutoPortrait("")).toBe(false);
    expect(isAutoPortrait(null)).toBe(false);
    expect(isAutoPortrait(undefined)).toBe(false);
  });

  /** ⚠️ og 는 jpg 다. 확장자를 고정하면 판정이 깨진다. */
  it("확장자에 의존하지 않는다", () => {
    expect(isAutoPortrait(`${CDN}/abc-portrait.jpg`)).toBe(true);
    expect(isAutoPortrait(`${CDN}/abc-portrait.avif`)).toBe(true);
  });

  it("이름에 portrait 이 들어간 마스터는 자동이 아니다", () => {
    // `portrait-shot.webp` 처럼 사용자가 지은 이름에 걸리면 안 된다.
    expect(isAutoPortrait(`${CDN}/portrait-shot.webp`)).toBe(false);
  });
});

describe("🔴 직접 올린 세로는 지킨다", () => {
  it("대표를 새로 올려도 손으로 올린 세로가 남는다", () => {
    const manual = `${CDN}/myposter.webp`;
    const out = mergeKeepingManualPortrait({ portrait: manual }, NEW);
    expect(out?.portrait, "직접 올린 세로가 자동 크롭본으로 바뀌었다").toBe(manual);
    // 나머지 렌디션은 새 대표 것으로 갱신돼야 한다.
    expect(out?.wide).toBe(NEW.wide);
    expect(out?.og).toBe(NEW.og);
  });

  it("세로가 자동본이었으면 새 자동본으로 갱신된다", () => {
    const out = mergeKeepingManualPortrait({ portrait: `${CDN}/oldbase-portrait.webp` }, NEW);
    expect(out?.portrait, "옛 대표에서 나온 크롭본이 남았다").toBe(NEW.portrait);
  });

  it("세로가 아예 없었으면 새 자동본을 쓴다", () => {
    const out = mergeKeepingManualPortrait({}, NEW);
    expect(out?.portrait).toBe(NEW.portrait);
  });

  it("기존 맵이 없어도 동작한다", () => {
    expect(mergeKeepingManualPortrait(null, NEW)?.portrait).toBe(NEW.portrait);
    expect(mergeKeepingManualPortrait(undefined, NEW)?.wide).toBe(NEW.wide);
  });
});

describe("대표를 지웠을 때", () => {
  it("🔴 자동 렌디션은 전부 버린다 — stale 전파 방지", () => {
    const out = mergeKeepingManualPortrait({ ...NEW }, null);
    expect(out, "옛 대표의 렌디션이 남았다").toBeNull();
  });

  it("직접 올린 세로는 남긴다 — 그 대표에서 나온 것이 아니다", () => {
    const manual = `${CDN}/myposter.webp`;
    const out = mergeKeepingManualPortrait({ ...NEW, portrait: manual }, null);
    expect(out).toEqual({ portrait: manual });
  });
});
