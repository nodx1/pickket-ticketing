/**
 * 🔴 폰에서 이미지와 카드의 좌우가 어긋나지 않는지 (2026-08-01, 대표 지적).
 *
 * 처음엔 **이미지에만** 풀블리드를 걸었다. 그랬더니 카드는 358px 인데 이미지가 390px 이라
 * **액자보다 그림이 커져** 카드 테두리가 이미지 옆에 그대로 남았다 — 더 이상해 보였다.
 *
 * 지금 구조(폰):
 *
 *     바깥 카드   화면 폭(390) · 좌우 테두리·모서리 없음 · **가로 여백은 유지**(p-5)
 *       글자      여백 안 (제목·설명·장소 블록이 화면 끝에 붙으면 안 된다)
 *       안쪽 상자  좌우 테두리 없음 · 가로 여백 유지(p-4)
 *         이미지   두 여백을 되돌려 화면 끝까지(-mx-9)
 *
 * ⚠️ **이 셋은 산술로 묶여 있다.** `p-5`(20) + `p-4`(16) = 36px = `mx-9`.
 *    어느 하나를 바꾸면 이미지가 다시 어긋난다 — 그 계산을 여기서 고정한다.
 *    (실측으로 확인한 값: 카드 0~390 · 이미지 0~390 · 제목 20px)
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = fs.readFileSync(
  path.join(__dirname, "..", "..", "app", "(public)", "e", "[eventSlug]", "_components", "detail-images.tsx"),
  "utf8",
);

/** Tailwind 여백 단위 → px (1 = 0.25rem = 4px) */
const px = (n: number) => n * 4;

function classesOf(marker: string): string {
  const i = SRC.indexOf(marker);
  expect(i, `${marker} 를 못 찾았다 — 테스트가 엉뚱한 곳을 보고 있다`).toBeGreaterThan(-1);
  const seg = SRC.slice(i, i + 900);
  return seg;
}

describe("상세 이미지 — 폰 레이아웃", () => {
  it("§0 대상 파일을 실제로 읽었다", () => {
    expect(SRC.length).toBeGreaterThan(2000);
    expect(SRC).toContain("DetailSectionCard");
    expect(SRC).toContain("DetailImageBox");
  });

  it("🔴 바깥 카드가 폰에서 화면 폭까지 펴진다 — 이미지만 커지면 액자 밖으로 삐져나온다", () => {
    const seg = classesOf("export function DetailSectionCard");
    for (const c of ["max-sm:w-screen", "max-sm:left-1/2", "max-sm:-translate-x-1/2", "max-sm:rounded-none", "max-sm:border-x-0"]) {
      expect(seg, `카드에 ${c} 가 없다`).toContain(c);
    }
  });

  it("🔴 카드의 가로 여백은 유지한다 — 제목·설명이 화면 끝에 붙으면 안 된다", () => {
    const seg = classesOf("export function DetailSectionCard");
    expect(seg, "px-0 를 걸면 「이벤트 안내」 제목과 설명문이 화면 끝에 달라붙는다").not.toContain("max-sm:px-0");
    expect(seg).toContain("p-5");
  });

  it("🔴 안쪽 상자도 좌우 테두리를 벗는다 (여기만 액자가 남으면 다시 어긋난다)", () => {
    const seg = classesOf("export function DetailImageBox");
    expect(seg).toContain("max-sm:border-x-0");
    expect(seg).toContain("max-sm:rounded-none");
    expect(seg).toContain("p-4");
  });

  /**
   * 🔴 산술 고정 — 이미지가 되돌리는 여백이 카드+상자 여백의 합과 같아야 한다.
   *    다르면 이미지가 화면 끝에 안 닿거나(부족) 밖으로 삐져나온다(초과).
   */
  it("🔴 이미지의 음수 마진 = 상자 여백 (그래야 카드 여백 선 = 글자 선에 정렬된다)", () => {
    const card = classesOf("export function DetailSectionCard").match(/\bp-(\d+)\b/);
    const box = classesOf("export function DetailImageBox").match(/\bp-(\d+)\b/);
    const img = SRC.match(/max-sm:-mx-(\d+)/);
    expect(card, "카드 여백을 못 읽었다").not.toBeNull();
    expect(box, "상자 여백을 못 읽었다").not.toBeNull();
    expect(img, "이미지가 여백을 되돌리지 않는다 — 카드 안에 갇힌다").not.toBeNull();

    const need = px(Number(box![1]));   // 상자 여백만 되돌린다
    const have = px(Number(img![1]));
    expect(
      have,
      `상자 p-${box![1]}(${need}px) 만 되돌려야 이미지가 카드 여백 선(=글자 선)에 선다. ` +
        `지금 -mx-${img![1]}(${have}px). 더 되돌리면 화면 끝에 붙고, 덜 되돌리면 글자보다 안쪽으로 들어간다.`,
    ).toBe(need);

    // 결과적으로 이미지 왼쪽 = 카드 여백 = 제목 왼쪽. 실측값 20px.
    const cardPad = px(Number(card![1]));
    expect(cardPad, "카드 여백이 곧 이미지가 서는 선이다").toBe(20);
  });

  it("🔴 이미지는 화면 끝에 붙지 않는다 — 모서리가 잘린 것처럼 보인다", () => {
    const imgBlock = SRC.slice(SRC.indexOf("export function DetailImages"));
    expect(imgBlock, "여백을 뒀으면 모서리를 살려야 한다").not.toContain("max-sm:rounded-none");
    expect(imgBlock).toContain("rounded-lg");
  });

  it("🔴 이미지 자체에는 풀블리드를 걸지 않는다 — 카드가 넓히는 주체다", () => {
    // 이미지에 w-screen 을 다시 걸면 카드보다 커져 처음 문제로 돌아간다.
    const imgBlock = SRC.slice(SRC.indexOf("export function DetailImages"));
    expect(imgBlock, "이미지가 스스로 화면 폭을 잡으면 카드와 어긋난다").not.toContain("max-sm:w-screen");
  });

  it("데스크톱은 종전 그대로 카드 안이다", () => {
    // `max-sm:` 접두가 붙지 않은 풀블리드 유틸이 없어야 한다.
    expect(SRC).not.toMatch(/(?<!max-sm:)\bw-screen\b/);
  });
});
