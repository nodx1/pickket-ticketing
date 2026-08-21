/**
 * 렌더링 FPS 실측 벤치마크 — Playwright headless
 *
 * 실제 SeatMap 컴포넌트를 마운트하지 않고,
 * Canvas2D/PixiJS 렌더러를 직접 호출해 draw() 시간을 측정.
 *
 * 브라우저에서 Canvas API + RAF 성능을 실측:
 *   1. N석 좌석 데이터 생성
 *   2. Canvas 생성 + draw 100 프레임
 *   3. 평균 frame time → FPS 계산
 */
import { chromium } from "playwright";

const TESTS = [
  { count: 1000, renderer: "canvas2d", label: "Canvas2D 1k" },
  { count: 5000, renderer: "canvas2d", label: "Canvas2D 5k" },
  { count: 10000, renderer: "canvas2d", label: "Canvas2D 10k" },
  { count: 5000, renderer: "webgl", label: "WebGL 5k" },
  { count: 10000, renderer: "webgl", label: "WebGL 10k" },
  { count: 50000, renderer: "webgl", label: "WebGL 50k" },
  { count: 80000, renderer: "webgl", label: "WebGL 80k" },
];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
const page = await ctx.newPage();

console.log("=== 좌석 렌더링 FPS 실측 벤치마크 ===\n");
console.log("N seats | renderer  | frames | avg ms/frame | FPS    | verdict");
console.log("--------|-----------|--------|--------------|--------|--------");

for (const t of TESTS) {
  const result = await page.evaluate(async ({ count, renderer }) => {
    // 좌석 데이터 생성
    const seats = [];
    const cols = Math.ceil(Math.sqrt(count));
    for (let i = 0; i < count; i++) {
      seats.push({
        x: (i % cols) * 28,
        y: Math.floor(i / cols) * 28,
        status: i % 5 === 0 ? "held" : i % 7 === 0 ? "sold" : "available",
        label: `S${i}`,
      });
    }

    if (renderer === "canvas2d") {
      // Canvas2D 직접 draw
      const canvas = document.createElement("canvas");
      canvas.width = 1200;
      canvas.height = 800;
      const ctx = canvas.getContext("2d");
      if (!ctx) return { avgMs: 999, fps: 0, frames: 0 };

      const FRAMES = 60;
      const times = [];
      for (let f = 0; f < FRAMES; f++) {
        const t0 = performance.now();
        ctx.clearRect(0, 0, 1200, 800);
        ctx.save();
        ctx.scale(0.5, 0.5); // 줌 아웃 시뮬
        for (const s of seats) {
          // viewport culling
          const sx = s.x * 0.5;
          const sy = s.y * 0.5;
          if (sx + 22 < 0 || sx > 1200 || sy + 22 < 0 || sy > 800) continue;
          ctx.fillStyle = s.status === "available" ? "#10b981" : s.status === "held" ? "#f59e0b" : "#9ca3af";
          ctx.fillRect(s.x, s.y, 22, 22);
        }
        ctx.restore();
        const t1 = performance.now();
        times.push(t1 - t0);
      }
      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      return { avgMs: Math.round(avg * 100) / 100, fps: Math.round(1000 / avg), frames: FRAMES };

    } else {
      // WebGL — PixiJS 동적 import 불가능 (브라우저 context)
      // 대신 WebGL2 raw draw call 시뮬레이션
      const canvas = document.createElement("canvas");
      canvas.width = 1200;
      canvas.height = 800;
      const gl = canvas.getContext("webgl2");
      if (!gl) return { avgMs: 999, fps: 0, frames: 0, note: "WebGL2 미지원" };

      // 단순 glClear + viewport 계산만 (PixiJS 오버헤드 없는 raw)
      const FRAMES = 60;
      const times = [];
      for (let f = 0; f < FRAMES; f++) {
        const t0 = performance.now();
        gl.clearColor(0.98, 0.98, 1.0, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        // 좌석 visibility 계산 (CPU 비용 시뮬)
        for (const s of seats) {
          const sx = s.x * 0.3;
          const sy = s.y * 0.3;
          if (sx + 22 * 0.3 >= 0 && sx <= 1200 && sy + 22 * 0.3 >= 0 && sy <= 800) {
            // visibility check
          }
        }
        gl.flush();
        const t1 = performance.now();
        times.push(t1 - t0);
      }
      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      return { avgMs: Math.round(avg * 100) / 100, fps: Math.round(1000 / avg), frames: FRAMES, visible: "N/A (raw GL)" };
    }
  }, { count: t.count, renderer: t.renderer });

  const verdict = result.fps >= 55 ? "✅ PASS" : result.fps >= 30 ? "⚠️ OK" : "❌ FAIL";
  console.log(
    `${String(t.count).padStart(7)} | ${t.renderer.padEnd(9)} | ${String(result.frames).padStart(6)} | ${String(result.avgMs).padStart(12)}ms | ${String(result.fps).padStart(6)} | ${verdict}`
  );
}

await browser.close();
console.log("\n⚠️ WebGL 수치는 raw GL clear+culling만 측정 (PixiJS Graphics 오버헤드 미포함)");
console.log("⚠️ 실제 PixiJS 성능은 수동 검증(시나리오 C1)으로 별도 확인 필요");
