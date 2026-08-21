import { chromium } from "playwright";

const TESTS = [
  { count: 50000, zoom: 0.3 },
  { count: 80000, zoom: 0.3 },
  { count: 80000, zoom: 0.5 },
  { count: 100000, zoom: 0.3 },
];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
const page = await ctx.newPage();
await page.goto("about:blank");
await page.addScriptTag({ url: "https://cdn.jsdelivr.net/npm/pixi.js@7/dist/pixi.min.js" });
await page.waitForTimeout(2000);

console.log("=== PixiJS + Spatial Grid 실측 FPS ===\n");
console.log("N seats | zoom | grid iter | avg ms/frame | FPS    | verdict");
console.log("--------|------|-----------|--------------|--------|--------");

for (const t of TESTS) {
  const result = await page.evaluate(async ({ count, zoom }) => {
    const app = new PIXI.Application({ width: 1200, height: 800, backgroundAlpha: 0, antialias: false });
    document.body.appendChild(app.view);
    const container = new PIXI.Container();
    app.stage.addChild(container);

    const cols = Math.ceil(Math.sqrt(count));
    const SEAT_SIZE = 22, GAP = 6, CELL = SEAT_SIZE + GAP;
    const GRID_SIZE = 500;
    const nodes = [];
    const seatGrid = new Map();

    for (let i = 0; i < count; i++) {
      const g = new PIXI.Graphics();
      g.beginFill(i % 5 === 0 ? 0xf59e0b : 0x10b981);
      g.drawRect(0, 0, SEAT_SIZE, SEAT_SIZE);
      g.endFill();
      const px = (i % cols) * CELL;
      const py = Math.floor(i / cols) * CELL;
      g.x = px;
      g.y = py;
      g.visible = false;
      container.addChild(g);
      nodes.push({ g, px, py, id: i });

      // Spatial grid
      const gx = Math.floor(px / GRID_SIZE);
      const gy = Math.floor(py / GRID_SIZE);
      const key = `${gx},${gy}`;
      if (!seatGrid.has(key)) seatGrid.set(key, []);
      seatGrid.get(key).push(i);
    }

    container.scale.set(zoom, zoom);
    const s = zoom, pad = 100, screenW = 1200, screenH = 800;
    const screenSize = SEAT_SIZE * s;

    // Spatial grid 기반 visibility
    const vpMinGx = Math.floor((-0 / s - pad) / GRID_SIZE);
    const vpMaxGx = Math.floor(((screenW - 0) / s + pad) / GRID_SIZE);
    const vpMinGy = Math.floor((-0 / s - pad) / GRID_SIZE);
    const vpMaxGy = Math.floor(((screenH - 0) / s + pad) / GRID_SIZE);

    let gridIter = 0;
    for (let gx = vpMinGx; gx <= vpMaxGx; gx++) {
      for (let gy = vpMinGy; gy <= vpMaxGy; gy++) {
        const ids = seatGrid.get(`${gx},${gy}`);
        if (!ids) continue;
        for (const id of ids) {
          gridIter++;
          const n = nodes[id];
          const wx = n.px * s;
          const wy = n.py * s;
          const vis = screenSize >= 4 && wx + screenSize >= -pad && wx <= screenW + pad && wy + screenSize >= -pad && wy <= screenH + pad;
          n.g.visible = vis;
        }
      }
    }

    const times = [];
    for (let f = 0; f < 60; f++) {
      const t0 = performance.now();
      // Spatial grid 재순회 (transform 변경 시뮬)
      for (let gx = vpMinGx; gx <= vpMaxGx; gx++) {
        for (let gy = vpMinGy; gy <= vpMaxGy; gy++) {
          const ids = seatGrid.get(`${gx},${gy}`);
          if (!ids) continue;
          for (const id of ids) {
            const n = nodes[id];
            const wx = n.px * s;
            const wy = n.py * s;
            n.g.visible = screenSize >= 4 && wx + screenSize >= -pad && wx <= screenW + pad && wy + screenSize >= -pad && wy <= screenH + pad;
          }
        }
      }
      app.renderer.render(app.stage);
      const t1 = performance.now();
      times.push(t1 - t0);
    }

    app.destroy(true, { children: true });
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    return { avgMs: Math.round(avg * 100) / 100, fps: Math.round(1000 / avg), gridIter };
  }, { count: t.count, zoom: t.zoom });

  const verdict = result.fps >= 55 ? "✅ PASS" : result.fps >= 30 ? "⚠️ OK" : "❌ FAIL";
  console.log(`${String(t.count).padStart(7)} | ${t.zoom.toFixed(1).padStart(4)} | ${String(result.gridIter).padStart(9)} | ${String(result.avgMs).padStart(12)}ms | ${String(result.fps).padStart(6)} | ${verdict}`);
}

await browser.close();
console.log("\nPixiJS 7 + spatial grid (GRID_SIZE=500px) + frustum + LOD screenSize>=4px.");
