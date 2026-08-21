/**
 * 공개·인증 페이지의 `<title>` 실측 (S5).
 *
 * ── 왜 E2E 인가 ──
 * 소스에 `export const metadata` 가 있는지 보는 것으로는 부족하다. 세 페이지는 `"use client"`
 * 라 metadata 를 export 할 수 없어 **형제 `layout.tsx`** 로 넣었고, 그게 실제로 적용되는지는
 * 렌더된 문서를 봐야 안다. 루트 `title.template` 이 붙는 것도 여기서만 보인다.
 *
 * ⚠️ 프로덕션 빌드로 확인할 것 — dev 서버는 신뢰하지 않는다(KNOWN-DEBT D-3).
 */
import { expect, test } from "@playwright/test";

/** 루트 layout 의 `title.template` = `"%s — PICKKET.GO"`. 문구에 브랜드명을 다시 쓰면 중복된다. */
const SUFFIX = " — PICKKET.GO";

const PAGES: Array<[url: string, title: string]> = [
  ["/login", "로그인"],
  ["/register", "회원가입"],
  ["/my-tickets", "내 티켓"],
  ["/about", "회사 소개"],
  ["/refund-policy", "환불 정책"],
  ["/terms", "이용약관"],
  ["/privacy", "개인정보처리방침"],
];

for (const [url, title] of PAGES) {
  test(`${url} — <title> 이 "${title}${SUFFIX}"`, async ({ page }) => {
    await page.goto(url);
    await expect(page).toHaveTitle(`${title}${SUFFIX}`);
  });
}

test("루트는 기본 title 을 유지한다 (template 이 아니라 default)", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("PICKKET.GO — 이벤트를 여는 모든 사람을 위해");
});

test("브랜드명이 두 번 붙지 않는다", async ({ page }) => {
  for (const [url] of PAGES) {
    await page.goto(url);
    const t = await page.title();
    expect(t.match(/PICKKET\.GO/g)?.length ?? 0, `${url}: "${t}" — 브랜드명 중복`).toBe(1);
  }
});
