/**
 * 사이드바 환경설정 회귀 — 「자주 사용」 제거 후에도 접힘 설정이 살아남는가 (2026-08-01).
 *
 * ── 왜 브라우저로 보나 ──
 * 단위 테스트는 `readStoredPrefs` 의 판정만 본다. **앱이 그 결과를 실제로 적용하는지**는
 * 렌더된 DOM 을 봐야 안다. 기능 하나 걷어내면서 사용자 설정을 리셋하는 사고가 이 자리다.
 *
 * ── 이 파일을 고칠 때 주의(둘 다 실측으로 데였다) ──
 *  ① `localStorage` 를 읽어 판정하지 말 것 — 앱은 **로드 시점에 저장하지 않는다**.
 *     내가 심은 씨앗을 그대로 다시 읽게 되어, 리셋이 나도 통과한다.
 *  ② `toBeHidden()` 으로 판정하지 말 것 — 접힘은 부모의 `max-h-0` 클리핑이라
 *     자식 링크는 자기 박스를 그대로 갖는다. **그룹 컨테이너의 실제 높이**를 재야 한다.
 */
import { expect, test } from "@playwright/test";
import { loginAsDemoApi } from "../helpers/auth";

const KEY = "pickket-ui-prefs";

test.use({ viewport: { width: 1440, height: 1200 } });

test("「자주 사용」이 사라지고, 기존 사용자의 접힘 설정은 살아남는다", async ({ page }) => {
  await loginAsDemoApi(page.request);
  const evs = (await (await page.request.get("/api/events?limit=1")).json()).data ?? [];
  test.skip(!evs.length, "이벤트 없음");
  const id = evs[0].id as string;

  // ── 기존 사용자 재현 ──
  // 「자주 사용」을 쓰던 사람의 저장값에는 itemUsageCount 가 남아 있고, 접힘도 기본값과 다르다.
  await page.goto(`/events/${id}/dashboard`);
  await page.evaluate(
    ([k, v]) => window.localStorage.setItem(k, v),
    [KEY, JSON.stringify({ v: 2, collapsedGroups: ["sell"], itemUsageCount: { [`/events/x/orders`]: 42 } })] as const,
  );
  await page.reload();
  await page.waitForTimeout(1200);

  // ① 「자주 사용」이 안 보인다
  await expect(page.getByText("자주 사용", { exact: true })).toHaveCount(0);

  // ② 대조군 — 사이드바 자체는 떠 있다(안 뜨는데 ①이 통과하면 아무 의미 없다)
  const groups = ["준비", "판매·발권", "현장", "소통", "고급 설정"];
  let seen = 0;
  for (const g of groups) if (await page.getByRole("button", { name: g }).count()) seen += 1;
  expect(seen, "사이드바 그룹이 하나도 안 보인다 — 렌더 실패").toBeGreaterThan(2);

  // ③ 🔴 접힘 설정이 리셋되지 않았다.
  //    ⚠️ localStorage 를 읽으면 안 된다 — 앱은 로드 시점에 저장하지 않으므로 **내가 심은
  //       값을 그대로 다시 읽게** 되고, 리셋이 나도 통과한다(실측: 뮤테이션 생존).
  //    ⚠️ `toBeHidden()` 도 안 된다 — 접힘은 부모의 `max-h-0` 클리핑이라 자식 링크는
  //       자기 박스를 그대로 갖는다(실측: 그래서 오탐이 났다).
  //    ⟹ 그룹 컨테이너의 **실제 높이**를 잰다. 접히면 0 이다.
  const groupHeight = (label: string) =>
    page.evaluate((lb) => {
      const btn = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim().startsWith(lb));
      const box = btn?.parentElement?.querySelector("div");
      return box ? Math.round(box.getBoundingClientRect().height) : -1;
    }, label);

  const sellH = await groupHeight("판매·발권");
  const onsiteH = await groupHeight("현장");
  console.log(`  판매·발권 높이=${sellH}  현장 높이=${onsiteH}`);
  // 씨앗은 sell 만 접힘. 리셋되면 기본값(comms·advanced 접힘)이라 판매·발권이 펼쳐진다.
  expect(sellH, "판매·발권이 펼쳐져 있다 — 접힘 설정이 리셋됐다").toBe(0);
  expect(onsiteH, "현장까지 접혀 있다 — 기본값으로 리셋된 것").toBeGreaterThan(0);

  // ④ 접기/펼치기가 여전히 동작하고 저장된다
  const target = page.getByRole("button", { name: "현장" }).first();
  await target.click();
  await page.waitForTimeout(500);
  const after = JSON.parse((await page.evaluate((k) => window.localStorage.getItem(k), KEY)) ?? "{}") as {
    collapsedGroups?: string[]; itemUsageCount?: unknown;
  };
  console.log("  토글 후 저장값:", JSON.stringify(after));
  expect(after.collapsedGroups, "토글이 저장되지 않았다").toContain("onsite");
  // ⑤ 죽은 키가 다시 쓰이지 않는다
  expect(after.itemUsageCount, "제거한 itemUsageCount 가 다시 저장됐다").toBeUndefined();
});
