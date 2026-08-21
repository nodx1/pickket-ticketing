import { expect, type Locator, type Page } from "@playwright/test";

/**
 * 이름으로 특정한 다이얼로그 로케이터.
 *
 * ── 왜 헬퍼로 강제하나 ──
 * 이름 없는 `getByRole("dialog")` 는 **열려 있는 아무 다이얼로그**나 문다. 메시지 작성창이
 * 그 자체로 `role=dialog` 라, 확인창을 잡으려던 단언이 작성창을 물어 전건 실패한 적이 있다.
 * 그때는 그 자리에만 이름을 붙여 고쳤는데, **다음 자리에서 또 빠졌다.** 이식을 기억해야 하는
 * 구조가 원인이므로, 이름을 **필수 인자**로 받는 통로 하나만 남긴다.
 *
 * 안전한 이유: `ConfirmDialog` 는 항상 `DialogTitle` 을 렌더하고(`confirm-dialog.tsx`),
 * `DialogContent` 는 Radix `Dialog.Content` 라 `aria-labelledby` 가 자동 연결된다.
 * 즉 모든 확인창에 접근성 이름이 이미 붙어 있어 이름 조회가 항상 동작한다.
 *
 * ⚠️ 이 통로를 우회해 raw `getByRole("dialog")` 를 쓰면 `specs/e2e/helpers/dialog.guard.test.ts`
 *    가 잡는다.
 */
export function dialogByName(page: Page, name: string | RegExp): Locator {
  return page.getByRole("dialog", { name });
}

/** 이름으로 특정한 다이얼로그가 보일 때까지 기다리고 그 로케이터를 돌려준다. */
export async function expectDialog(
  page: Page,
  name: string | RegExp,
  options?: { timeout?: number },
): Promise<Locator> {
  const dialog = dialogByName(page, name);
  await expect(dialog, `다이얼로그를 찾지 못했다: ${String(name)}`).toBeVisible(options);
  return dialog;
}

/** 이름으로 특정한 다이얼로그가 **떠 있지 않음**을 단언한다(아직 열리면 안 되는 경우). */
export async function expectNoDialog(
  page: Page,
  name: string | RegExp,
  message?: string,
): Promise<void> {
  await expect(dialogByName(page, name), message).toBeHidden();
}
