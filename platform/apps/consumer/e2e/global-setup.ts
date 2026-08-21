import { chromium, type FullConfig } from "@playwright/test";
import fs from "fs";
import path from "path";

/**
 * 글로벌 셋업: 쿠키 동의를 사전 승인하여 CookieBanner가 E2E 테스트를 방해하지 않도록 함.
 * storageState에 localStorage를 저장하고 모든 테스트에서 재사용.
 */
export default async function globalSetup(_config: FullConfig) {
  const authDir = path.resolve(__dirname, ".auth");
  const storageFile = path.join(authDir, "cookie-consent.json");

  // 디렉토리 생성
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  // 홈페이지 방문하여 localStorage에 쿠키 동의 저장
  const baseURL =
    process.env.E2E_BASE_URL ?? process.env.BASE_URL ?? "http://localhost:3020";
  await page.goto(baseURL, { timeout: 60_000 });
  await page.evaluate(() => {
    localStorage.setItem(
      "pickket_cookie_consent",
      JSON.stringify({ essential: true, analytics: true, marketing: true }),
    );
  });

  // storageState 저장 (쿠키 + localStorage)
  await context.storageState({ path: storageFile });

  await browser.close();
}
