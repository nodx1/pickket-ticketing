import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();
await page.goto("about:blank");

const result = await page.evaluate(() => {
  const canvas = document.createElement("canvas");
  canvas.width = 600; canvas.height = 600;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 600, 600);

  // 10×20 격자, radius 6, spacing 50
  const expected = [];
  for (let r = 0; r < 10; r++) for (let c = 0; c < 20; c++) {
    const cx = 15 + c * 28, cy = 15 + r * 50;
    ctx.fillStyle = "#000000";
    ctx.beginPath();
    ctx.arc(cx, cy, 6, 0, Math.PI * 2);
    ctx.fill();
    expected.push({ x: cx, y: cy });
  }

  const imageData = ctx.getImageData(0, 0, 600, 600);
  const { width, height, data } = imageData;

  // Otsu
  const histogram = new Uint32Array(256);
  for (let i = 0; i < width * height; i++) {
    histogram[Math.round((data[i*4] + data[i*4+1] + data[i*4+2]) / 3)]++;
  }
  let totalSum = 0;
  for (let i = 0; i < 256; i++) totalSum += i * histogram[i];
  let bgC = 0, bgS = 0, maxV = 0, otsuT = 128;
  for (let t = 0; t < 256; t++) {
    bgC += histogram[t]; if (bgC === 0) continue;
    const fgC = width * height - bgC; if (fgC === 0) break;
    bgS += t * histogram[t];
    const v = bgC * fgC * ((bgS/bgC) - ((totalSum-bgS)/fgC)) ** 2;
    if (v > maxV) { maxV = v; otsuT = t; }
  }

  const binary = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    binary[i] = (data[i*4] + data[i*4+1] + data[i*4+2]) / 3 < otsuT ? 1 : 0;
  }

  // 8-conn BFS
  const labels = new Int32Array(width * height);
  let nextLabel = 1;
  const components = [];
  const queue = new Int32Array(width * height);
  const dx8 = [-1,1,0,0,-1,-1,1,1], dy8 = [0,0,-1,1,-1,1,-1,1];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const idx = y * width + x;
    if (binary[idx] === 0 || labels[idx] !== 0) continue;
    const label = nextLabel++;
    const comp = { pixels: 0, sumX: 0, sumY: 0 };
    let qs = 0, qe = 0;
    queue[qe++] = idx; labels[idx] = label;
    while (qs < qe) {
      const cur = queue[qs++];
      const cy2 = Math.floor(cur / width), cx2 = cur - cy2 * width;
      comp.pixels++; comp.sumX += cx2; comp.sumY += cy2;
      for (let d = 0; d < 8; d++) {
        const nx = cx2 + dx8[d], ny = cy2 + dy8[d];
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const ni = ny * width + nx;
        if (binary[ni] === 1 && labels[ni] === 0) { labels[ni] = label; queue[qe++] = ni; }
      }
    }
    components.push(comp);
  }

  const areas = components.map(c => c.pixels).sort((a, b) => a - b);
  const q1 = areas[Math.floor(areas.length * 0.25)];
  const q3 = areas[Math.floor(areas.length * 0.75)];
  const iqr = q3 - q1;
  const minA = Math.max(5, q1 - 1.5 * iqr);
  const maxA = q3 + 1.5 * iqr;
  const filtered = components.filter(c => c.pixels >= minA && c.pixels <= maxA);

  return {
    totalComponents: components.length,
    areas: areas.slice(0, 20).join(",") + "..." + areas.slice(-5).join(","),
    q1, q3, iqr, minA: Math.round(minA), maxA: Math.round(maxA),
    filtered: filtered.length,
    expected: 200,
    otsuT,
    canvasSize: `${width}x${height}`,
  };
});

console.log(JSON.stringify(result, null, 2));
await browser.close();
