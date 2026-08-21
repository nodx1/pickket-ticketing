import { chromium } from "playwright";

const TESTS = [
  { count: 1000 },
  { count: 5000 },
  { count: 10000 },
  { count: 30000 },
  { count: 50000 },
];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
const page = await ctx.newPage();
await page.goto("about:blank");

// PixiJS 8 UMD bundle — 글로벌 PIXI 노출
await page.addScriptTag({ url: "https://cdn.jsdelivr.net/npm/pixi.js@7/dist/pixi.min.js" });
await page.waitForTimeout(2000);

const hasPixi = await page.evaluate(() => typeof PIXI !== "undefined");
if (!hasPixi) {
  console.log("❌ PIXI 로드 실패 — CDN 접근 불가. Canvas2D 결과만 사용.");
  await browser.close();
  process.exit(0);
}

console.log("=== PixiJS 7 실측 FPS (headless Chromium) ===\n");
console.log("N seats | avg ms/frame | FPS    | verdict");
console.log("--------|--------------|--------|--------");

for (const t of TESTS) {
  const result = await page.evaluate(async (count) => {
    const app = new PIXI.Application({ width: 1200, height: 800, backgroundAlpha: 0, antialias: false });
    document.body.appendChild(app.view);

    const container = new PIXI.Container();
    app.stage.addChild(container);

    const cols = Math.ceil(Math.sqrt(count));
    for (let i = 0; i < count; i++) {
      const g = new PIXI.Graphics();
      g.beginFill(i % 5 === 0 ? 0xf59e0b : 0x10b981);
      g.drawRect(0, 0, 22, 22);
      g.endFill();
      g.x = (i % cols) * 28;
      g.y = Math.floor(i / cols) * 28;
      container.addChild(g);
    }
    container.scale.set(0.3, 0.3);

    const times = [];
    for (let f = 0; f < 60; f++) {
      const t0 = performance.now();
      app.renderer.render(app.stage);
      const t1 = performance.now();
      times.push(t1 - t0);
    }

    app.destroy(true, { children: true });
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    return { avgMs: Math.round(avg * 100) / 100, fps: Math.round(1000 / avg) };
  }, t.count);

  const verdict = result.fps >= 55 ? "✅ PASS" : result.fps >= 30 ? "⚠️ OK" : "❌ FAIL";
  console.log(`${String(t.count).padStart(7)} | ${String(result.avgMs).padStart(12)}ms | ${String(result.fps).padStart(6)} | ${verdict}`);
}

await browser.close();
console.log("\nPixiJS 7 UMD + headless Chromium + PIXI.Graphics drawRect 기준.");
