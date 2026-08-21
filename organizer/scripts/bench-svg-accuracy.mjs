import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.goto("about:blank");

console.log("=== SVG 임포트 정확도 실측 ===\n");

const svg1 = `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="300">${Array.from({length:20},(_,i)=>`<circle cx="${60+(i%10)*40}" cy="${60+Math.floor(i/10)*60}" r="8" fill="#333" id="S${i+1}"/>`).join("")}<g class="stage"><rect x="100" y="10" width="200" height="30" fill="#1f2937"/></g></svg>`;

const svg2 = `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="300"><g transform="translate(100,50)"><g transform="rotate(15)">${Array.from({length:10},(_,i)=>`<circle cx="${i*35}" cy="0" r="6" fill="#333" id="T${i+1}"/>`).join("")}</g></g></svg>`;

const svg3 = `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="300">${Array.from({length:5},(_,i)=>`<path d="M ${50+i*80} 100 L ${70+i*80} 100 L ${70+i*80} 120 L ${50+i*80} 120 Z" fill="#666"/>`).join("")}${Array.from({length:5},(_,i)=>`<text x="${55+i*80}" y="115">A${i+1}</text>`).join("")}</svg>`;

const tests = [
  { name: "단순 격자 (circle 20)", expected: 20, svg: svg1 },
  { name: "transform 중첩 (rotate)", expected: 10, svg: svg2 },
  { name: "path + text 라벨", expected: 5, svg: svg3 },
];

console.log("시나리오                  | 예상 | 검출 | 라벨 | 정확도 | verdict");
console.log("--------------------------|------|------|------|--------|--------");

for (const tc of tests) {
  const result = await page.evaluate((svgStr) => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgStr, "image/svg+xml");
    if (doc.querySelector("parsererror")) return { detected: 0, labels: 0 };

    const landmarkGs = new Set();
    doc.querySelectorAll("g[class]").forEach(g => {
      if (["stage","aisle","exit"].some(t => (g.getAttribute("class")||"").includes(t))) landmarkGs.add(g);
    });
    function inLm(el) { let p = el.parentElement; while(p) { if(landmarkGs.has(p)) return true; p=p.parentElement; } return false; }

    function getMatrix(el) {
      const chain = [];
      let cur = el;
      while (cur && cur.tagName !== "svg") {
        const t = cur.getAttribute("transform");
        if (t) chain.unshift(t);
        cur = cur.parentElement;
      }
      let m = new DOMMatrix();
      for (const t of chain) {
        try { m = m.multiply(new DOMMatrix(t)); } catch {
          // fallback parse
        }
      }
      return m;
    }

    const seats = [];
    doc.querySelectorAll("circle, rect, ellipse, path").forEach(el => {
      if (inLm(el)) return;
      const m = getMatrix(el);
      let cx=0, cy=0;
      if (el.tagName === "circle") {
        const p = m.transformPoint(new DOMPoint(parseFloat(el.getAttribute("cx")||"0"), parseFloat(el.getAttribute("cy")||"0")));
        cx = p.x; cy = p.y;
      } else if (el.tagName === "path") {
        const d = el.getAttribute("d") || "";
        const coords = [];
        const re = /[ML]\s*([\d.-]+)[,\s]+([\d.-]+)/gi;
        let mm;
        while ((mm = re.exec(d)) !== null) coords.push({x:Number(mm[1]),y:Number(mm[2])});
        if (coords.length === 0) return;
        const avgX = coords.reduce((s,p)=>s+p.x,0)/coords.length;
        const avgY = coords.reduce((s,p)=>s+p.y,0)/coords.length;
        const p = m.transformPoint(new DOMPoint(avgX, avgY));
        cx = p.x; cy = p.y;
      }
      seats.push({ x: Math.round(cx), y: Math.round(cy), label: el.getAttribute("id") || "" });
    });

    let labelsMatched = 0;
    doc.querySelectorAll("text").forEach(t => {
      if (inLm(t)) return;
      const content = (t.textContent||"").trim();
      if (!content) return;
      const m = getMatrix(t);
      const p = m.transformPoint(new DOMPoint(parseFloat(t.getAttribute("x")||"0"), parseFloat(t.getAttribute("y")||"0")));
      let best = 20, bestSeat = null;
      for (const s of seats) {
        const d = Math.sqrt((s.x-p.x)**2+(s.y-p.y)**2);
        if (d < best) { best = d; bestSeat = s; }
      }
      if (bestSeat) { bestSeat.label = content; labelsMatched++; }
    });

    return { detected: seats.length, labels: labelsMatched };
  }, tc.svg);

  const accuracy = tc.expected > 0 ? Math.round((Math.min(result.detected, tc.expected) / tc.expected) * 100) : 0;
  const verdict = accuracy >= 80 ? "✅ PASS" : accuracy >= 60 ? "⚠️ OK" : "❌ FAIL";
  console.log(`${tc.name.padEnd(26)}| ${String(tc.expected).padStart(4)} | ${String(result.detected).padStart(4)} | ${String(result.labels).padStart(4)} | ${String(accuracy).padStart(5)}% | ${verdict}`);
}

await browser.close();
