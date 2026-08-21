import { chromium } from "playwright";

// 합성 테스트 도면 생성 (Canvas → PNG) + AI 검출 → 비교
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
const page = await ctx.newPage();
await page.goto("about:blank");

console.log("=== AI 좌석 검출 정확도 실측 ===\n");

const scenarios = [
  { name: "깨끗한 격자 (5×10)", rows: 5, cols: 10, radius: 8, noise: false },
  { name: "노이즈 격자 (5×10)", rows: 5, cols: 10, radius: 8, noise: true },
  { name: "큰 도면 (10×20)", rows: 10, cols: 20, radius: 6, noise: false },
  { name: "불규칙 크기 (혼합)", rows: 5, cols: 10, radius: 0, noise: false },
];

console.log("시나리오          | 예상 | 검출 | 정밀도 | 재현율 | verdict");
console.log("------------------|------|------|--------|--------|--------");

for (const sc of scenarios) {
  const result = await page.evaluate(({ rows, cols, radius, noise }) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 600;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { expected: 0, detected: 0 };

    // 흰 배경
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 1200, 600);

    // 좌석 그리기 (검은 원)
    const expected = rows * cols;
    const positions = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cx = 60 + c * 50;
        const cy = 80 + r * 50;
        const rad = radius > 0 ? radius : 4 + Math.random() * 8; // 불규칙
        ctx.fillStyle = "#000000";
        ctx.beginPath();
        ctx.arc(cx, cy, rad, 0, Math.PI * 2);
        ctx.fill();
        positions.push({ x: cx, y: cy });
      }
    }

    // 노이즈 점 추가 (작은 점 30개)
    if (noise) {
      for (let i = 0; i < 30; i++) {
        ctx.fillStyle = "#333333";
        ctx.beginPath();
        ctx.arc(Math.random() * 1200, Math.random() * 600, 1 + Math.random() * 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 이미지 데이터 추출
    const imageData = ctx.getImageData(0, 0, 1200, 600);
    const { width, height, data } = imageData;

    // ─── Otsu 이진화 ───
    const histogram = new Uint32Array(256);
    for (let i = 0; i < width * height; i++) {
      const gray = Math.round((data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3);
      histogram[gray]++;
    }
    let totalSum = 0;
    for (let i = 0; i < 256; i++) totalSum += i * histogram[i];
    let bgCount = 0, bgSum = 0, maxVar = 0, otsuT = 128;
    const pxCount = width * height;
    for (let t = 0; t < 256; t++) {
      bgCount += histogram[t];
      if (bgCount === 0) continue;
      const fgCount = pxCount - bgCount;
      if (fgCount === 0) break;
      bgSum += t * histogram[t];
      const bgMean = bgSum / bgCount;
      const fgMean = (totalSum - bgSum) / fgCount;
      const v = bgCount * fgCount * (bgMean - fgMean) * (bgMean - fgMean);
      if (v > maxVar) { maxVar = v; otsuT = t; }
    }

    let binary = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i++) {
      const gray = (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3;
      binary[i] = gray < otsuT ? 1 : 0;
    }

    // morphology disabled (Phase 2 fix)

    // 8-connectivity BFS
    const labels = new Int32Array(width * height);
    let nextLabel = 1;
    const components = [];
    const queue = new Int32Array(width * height);
    const dx8 = [-1, 1, 0, 0, -1, -1, 1, 1];
    const dy8 = [0, 0, -1, 1, -1, 1, -1, 1];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (binary[idx] === 0 || labels[idx] !== 0) continue;
      const label = nextLabel++;
      const comp = { pixels: 0, sumX: 0, sumY: 0 };
      let qs = 0, qe = 0;
      queue[qe++] = idx;
      labels[idx] = label;
      while (qs < qe) {
        const cur = queue[qs++];
        const cy = Math.floor(cur / width), cx = cur - cy * width;
        comp.pixels++;
        comp.sumX += cx;
        comp.sumY += cy;
        for (let d = 0; d < 8; d++) {
          const nx = cx + dx8[d], ny = cy + dy8[d];
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const ni = ny * width + nx;
          if (binary[ni] === 1 && labels[ni] === 0) { labels[ni] = label; queue[qe++] = ni; }
        }
      }
      components.push(comp);
    }

    // IQR 필터
    const areas = components.map(c => c.pixels).sort((a, b) => a - b);
    const q1 = areas[Math.floor(areas.length * 0.25)] || 0;
    const q3 = areas[Math.floor(areas.length * 0.75)] || 0;
    const iqr = q3 - q1;
    const minA = Math.max(5, q1 - 1.5 * iqr);
    const maxA = q3 + 1.5 * iqr;

    const detected = components.filter(c => c.pixels >= minA && c.pixels <= maxA);

    // 매칭: 검출 중심점 → 예상 위치 10px 이내 = TP
    let tp = 0;
    const matched = new Set();
    for (const d of detected) {
      const dx = d.sumX / d.pixels;
      const dy = d.sumY / d.pixels;
      for (let i = 0; i < positions.length; i++) {
        if (matched.has(i)) continue;
        const dist = Math.sqrt((dx - positions[i].x) ** 2 + (dy - positions[i].y) ** 2);
        if (dist < 15) { tp++; matched.add(i); break; }
      }
    }
    const precision = detected.length > 0 ? Math.round((tp / detected.length) * 100) : 0;
    const recall = expected > 0 ? Math.round((tp / expected) * 100) : 0;

    return { expected, detected: detected.length, tp, precision, recall };
  }, sc);

  const verdict = result.precision >= 80 && result.recall >= 75 ? "✅ PASS" :
                  result.precision >= 60 ? "⚠️ OK" : "❌ FAIL";
  console.log(
    `${sc.name.padEnd(18)}| ${String(result.expected).padStart(4)} | ${String(result.detected).padStart(4)} | ${String(result.precision).padStart(5)}% | ${String(result.recall).padStart(5)}% | ${verdict}`
  );
}

await browser.close();
console.log("\n합성 도면 기준 (깨끗한 벡터 그래픽). 실제 스캔/사진은 정확도 더 낮음.");
