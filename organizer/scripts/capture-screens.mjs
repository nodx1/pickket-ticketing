/**
 * 과업 증빙 화면 캡처 — 주최사 대시보드 새 화면 4종 + 웹 현장 단말.
 *
 *   node scripts/capture-screens.mjs <eventId> [baseUrl] [outDir] [terminalKey]
 *
 * 데모 주최사(demo@pickket.kr)로 로그인해 각 화면을 데스크톱·모바일 폭으로 찍는다.
 */
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const [eventId, baseUrl = "http://localhost:3033", outDir = "../docs/deliverables/evidence/screens", terminalKey = ""] = process.argv.slice(2);
if (!eventId) {
  console.error("eventId 가 필요합니다");
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: process.env.CAPTURE_CHANNEL ?? "chrome" });
const context = await browser.newContext({ baseURL: baseUrl, viewport: { width: 1440, height: 1000 }, locale: "ko-KR", timezoneId: "Asia/Seoul" });
const page = await context.newPage();
page.on("pageerror", (err) => console.warn("pageerror:", err.message));

await page.goto("/login");
await page.getByLabel("이메일").fill("demo@pickket.kr");
await page.getByLabel("비밀번호").fill(process.env.E2E_TEST_PASSWORD ?? "Test1234!");
await page.getByRole("button", { name: "로그인" }).click();
await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });

const shots = [
  { name: "01-lottery-policy", path: `/events/${eventId}/lottery-policy`, wait: "가중치 추첨 설정", action: async () => {
      await page.getByRole("button", { name: "계산" }).click();
      await page.waitForTimeout(2500);
    } },
  { name: "02-fairness", path: `/events/${eventId}/fairness`, wait: "공정성 증명서" },
  { name: "03-fairness-certificate", path: `/events/${eventId}/fairness`, wait: "공정성 증명서", action: async () => {
      await page.getByRole("button", { name: /증명서 PKT-FC/ }).first().click();
      await page.waitForTimeout(1500);
    } },
  { name: "04-fairness-results", path: `/events/${eventId}/fairness`, wait: "공정성 증명서", action: async () => {
      await page.getByRole("button", { name: "결과 보기" }).first().click();
      await page.waitForTimeout(1500);
    } },
  { name: "05-onsite", path: `/events/${eventId}/onsite`, wait: "현장 입장 관리", action: async () => page.waitForTimeout(2500) },
  { name: "06-settlement", path: `/events/${eventId}/settlement`, wait: "정산 방식" },
];

for (const shot of shots) {
  await page.goto(shot.path);
  await page.getByRole("heading", { name: shot.wait }).first().waitFor({ timeout: 30_000 });
  await page.waitForLoadState("networkidle").catch(() => undefined);
  if (shot.action) await shot.action();
  await page.screenshot({ path: path.join(outDir, `${shot.name}.png`), fullPage: true });
  console.log("captured", shot.name);
}

// 모바일 폭
await page.setViewportSize({ width: 390, height: 844 });
for (const shot of [shots[0], shots[4]]) {
  await page.goto(shot.path);
  await page.getByRole("heading", { name: shot.wait }).first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(outDir, `${shot.name}-mobile.png`), fullPage: true });
  console.log("captured", `${shot.name}-mobile`);
}

// 웹 현장 단말
if (terminalKey) {
  const term = await browser.newContext({ baseURL: baseUrl, viewport: { width: 1280, height: 800 }, locale: "ko-KR" });
  const tp = await term.newPage();
  await tp.goto("/terminal");
  await tp.getByLabel("단말 키").fill(terminalKey);
  await tp.getByRole("button", { name: "단말 시작" }).click();
  await tp.getByText("실시간 연결").waitFor({ timeout: 20_000 });
  await tp.screenshot({ path: path.join(outDir, "07-terminal-idle.png") });
  console.log("captured 07-terminal-idle");
  const payload = process.env.CAPTURE_SCAN_PAYLOAD;
  if (payload) {
    await tp.getByLabel(/스캐너 입력/).fill(payload);
    await tp.getByRole("button", { name: "확인" }).click();
    await tp.waitForTimeout(1200);
    await tp.screenshot({ path: path.join(outDir, process.env.CAPTURE_RESULT_NAME ?? "08-terminal-result.png") });
    console.log("captured 08-terminal-result");
  }
  await term.close();
}

await browser.close();
