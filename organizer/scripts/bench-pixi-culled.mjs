import { chromium } from "playwright";

const TESTS = [
  { count: 10000, zoom: 0.3 },
  { count: 30000, zoom: 0.3 },
  { count: 50000, zoom: 0.3 },
  { count: 80000, zoom: 0.3 },
  { count: 50000, zoom: 0.1 },
  { count: 80000, zoom: 0.1 },
];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
const page = await ctx.newPage();
await page.goto("about:blank");
await page.addScriptTag({ url: "https://cdn.jsdelivr.net/npm/pixi.js@7/dist/pixi.min.js" });
await page.waitForTimeout(2000);

console.log("=== PixiJS + Frustum Culling 실측 FPS ===\n");
console.log("N seats | zoom | visible | avg ms/frame | FPS    | verdict");
console.log("--------|------|---------|--------------|--------|--------");

for (const t of TESTS) {
  const result = await page.evaluate(async ({ count, zoom }) => {
    const app = new PIXI.Application({ width: 1200, height: 800, backgroundAlpha: 0, antialias: false });
    document.body.appendChild(app.view);
    const container = new PIXI.Container();
    app.stage.addChild(container);

    const cols = Math.ceil(Math.sqrt(count));
    const nodes = [];
    for (let i = 0; i < count; i++) {
      const g = new PIXI.Graphics();
      g.beginFill(i % 5 === 0 ? 0xf59e0b : 0x10b981);
      g.drawRect(0, 0, 22, 22);
      g.endFill();
      const px = (i % cols) * 28;
      const py = Math.floor(i / cols) * 28;
      g.x = px;
      g.y = py;
      container.addChild(g);
      nodes.push({ g, px, py });
    }
    container.scale.set(zoom, zoom);

    // Frustum culling 적용
    let visibleCount = 0;
    const screenW = 1200, screenH = 800, pad = 100;
    for (const n of nodes) {
      const wx = n.px * zoom;
      const wy = n.py * zoom;
      const screenSize = 22 * zoom;
      const vis = screenSize >= 1.5 && wx + screenSize >= -pad && wx <= screenW + pad && wy + screenSize >= -pad && wy <= screenH + pad;
      n.g.visible = vis;
      if (vis) visibleCount++;
    }

    const times = [];
    for (let f = 0; f < 60; f++) {
      const t0 = performance.now();
      app.renderer.render(app.stage);
      const t1 = performance.now();
      times.push(t1 - t0);
    }

    app.destroy(true, { children: true });
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    return { avgMs: Math.round(avg * 100) / 100, fps: Math.round(1000 / avg), visible: visibleCount };
  }, { count: t.count, zoom: t.zoom });

  const verdict = result.fps >= 55 ? "✅ PASS" : result.fps >= 30 ? "⚠️ OK" : "❌ FAIL";
  console.log(`${String(t.count).padStart(7)} | ${t.zoom.toFixed(1).padStart(4)} | ${String(result.visible).padStart(7)} | ${String(result.avgMs).padStart(12)}ms | ${String(result.fps).padStart(6)} | ${verdict}`);
}

await browser.close();
console.log("\nPixiJS 7 + frustum culling + LOD screenSize>=1.5px 적용 결과.");
