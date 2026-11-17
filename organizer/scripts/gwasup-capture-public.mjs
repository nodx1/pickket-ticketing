/**
 * 과업 증빙 — 소비자 공개 증명서 검증 페이지 캡처(브라우저가 직접 검증한 결과 화면).
 *   node scripts/gwasup-capture-public.mjs <certNo> [consumerBase] [outDir] [email] [password]
 * email/password 를 주면 그 응모자로 로그인해 '내 응모 확인'까지 찍는다.
 */
import { chromium } from "@playwright/test";
import path from "node:path";

const [certNo, base = "http://localhost:3020", outDir = "../docs/gwasup/evidence/screens", email, password] = process.argv.slice(2);
const browser = await chromium.launch({ channel: process.env.CAPTURE_CHANNEL ?? "chrome" });

for (const [name, viewport] of [["10-public-certificate", { width: 1280, height: 900 }], ["10-public-certificate-mobile", { width: 390, height: 844 }]]) {
  const ctx = await browser.newContext({ viewport, locale: "ko-KR", timezoneId: "Asia/Seoul" });
  const page = await ctx.newPage();
  if (email && password && name === "10-public-certificate") {
    const api = process.env.API_BASE ?? "http://localhost:8021/api/v1";
    const res = await page.request.post(`${api}/auth/login`, { data: { email, password } });
    const token = (await res.json()).access_token;
    await page.addInitScript((t) => {
      try {
        localStorage.setItem("access_token", t);
      } catch {}
    }, token);
    await ctx.setExtraHTTPHeaders({});
  }
  await page.goto(`${base}/fairness/certificates/${certNo}`);
  await page.addStyleTag({ content: "header, nav[class*=sticky], [class*=sticky] { position: static !important; }" });
  await page.getByText(/모두 일치|맞지 않습니다/).waitFor({ timeout: 90_000 }).catch(async (e) => { await page.screenshot({ path: path.join(outDir, `${name}-debug.png`), fullPage: true }); throw e; });
  if (email && name === "10-public-certificate") {
    await page.getByRole("button", { name: "내 응모 확인" }).click();
    await page.waitForTimeout(2500);
  }
  await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: true });
  console.log("captured", name);
  await ctx.close();
}
await browser.close();
