/**
 * 트랙 5.1 + Phase I1 고도화 — SVG 도면에서 좌석 추출
 *
 * 개선 (I1):
 * - ✅ 중첩 `<g transform="...">` 재귀 적용 (DOMMatrix API)
 * - ✅ `<text>` 내용 파싱 + 가장 가까운 좌석에 label 매핑 (15px proximity)
 * - ✅ CSS `<style>` 블록 내 fill 규칙 추출 (regex 기반)
 * - ✅ `<path>` d-attribute 기초 파싱 (M/L 명령, 중심점 추정)
 * - ✅ inline `style="fill:..."` 파싱
 *
 * 타겟: 70% → 85%
 */

export interface ParsedSeat {
  id: string;
  x: number;
  y: number;
  label: string;
  fill: string;
}

export interface ParsedLandmark {
  type: "stage" | "aisle" | "exit" | "restroom" | "custom";
  label: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ParsedSvgResult {
  seats: ParsedSeat[];
  landmarks: ParsedLandmark[];
  colors: string[];
  /** I1 — 추출된 텍스트 라벨 수 */
  textLabelsMatched: number;
}

function numAttr(el: Element, name: string): number {
  const v = el.getAttribute(name);
  if (!v) return 0;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

// ─── I1: CSS <style> 파싱 ───

function extractCSSFills(svgString: string): Map<string, string> {
  const map = new Map<string, string>();
  const styleMatch = svgString.match(/<style[^>]*>([\s\S]*?)<\/style>/gi);
  if (!styleMatch) return map;
  for (const block of styleMatch) {
    const inner = block.replace(/<\/?style[^>]*>/gi, "");
    // 단순 regex: .className { fill: #xxx; }
    const ruleRe = /([.#][\w-]+)\s*\{[^}]*fill\s*:\s*([^;}\s]+)/gi;
    let m;
    while ((m = ruleRe.exec(inner)) !== null) {
      map.set(m[1].toLowerCase(), m[2].toLowerCase());
    }
  }
  return map;
}

// ─── I1: Transform 재귀 적용 ───

function getAccumulatedTransform(el: Element): DOMMatrix {
  const chain: string[] = [];
  let cur: Element | null = el;
  while (cur) {
    const t = cur.getAttribute("transform");
    if (t) chain.unshift(t);
    cur = cur.parentElement;
    if (cur && cur.tagName === "svg") break;
  }
  let matrix = new DOMMatrix();
  for (const t of chain) {
    // DOMMatrix.fromFloat64Array 는 SVG transform 파싱 지원 안 함
    // CSS transform 문법으로 변환 시도
    try {
      const temp = new DOMMatrix(t);
      matrix = matrix.multiply(temp);
    } catch {
      // translate/rotate/scale 파싱
      const translateMatch = t.match(/translate\(\s*([\d.-]+)[,\s]+([\d.-]+)\s*\)/);
      if (translateMatch) {
        matrix = matrix.translate(Number(translateMatch[1]), Number(translateMatch[2]));
      }
      const rotateMatch = t.match(/rotate\(\s*([\d.-]+)/);
      if (rotateMatch) {
        matrix = matrix.rotate(Number(rotateMatch[1]));
      }
      const scaleMatch = t.match(/scale\(\s*([\d.-]+)(?:[,\s]+([\d.-]+))?\s*\)/);
      if (scaleMatch) {
        const sx = Number(scaleMatch[1]);
        const sy = scaleMatch[2] ? Number(scaleMatch[2]) : sx;
        matrix = matrix.scale(sx, sy);
      }
    }
  }
  return matrix;
}

function transformPoint(x: number, y: number, matrix: DOMMatrix): { x: number; y: number } {
  const p = matrix.transformPoint(new DOMPoint(x, y));
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

// ─── I1: Fill 추출 (inline style + attribute + CSS class) ───

function extractFill(el: Element, cssMap: Map<string, string>): string {
  // 1. inline style
  const style = el.getAttribute("style");
  if (style) {
    const m = style.match(/fill\s*:\s*([^;]+)/i);
    if (m) return m[1].trim().toLowerCase();
  }
  // 2. fill attribute
  const fill = el.getAttribute("fill");
  if (fill && fill !== "none") return fill.toLowerCase();
  // 3. CSS class
  const cls = el.getAttribute("class");
  if (cls) {
    for (const c of cls.split(/\s+/)) {
      const color = cssMap.get(`.${c.toLowerCase()}`);
      if (color) return color;
    }
  }
  // 4. id
  const id = el.getAttribute("id");
  if (id) {
    const color = cssMap.get(`#${id.toLowerCase()}`);
    if (color) return color;
  }
  return "#9ca3af";
}

// ─── I1+: <path> 중심점 + Bézier C/S/Q 샘플링 ───

function cubicBezier(
  p0: { x: number; y: number }, p1: { x: number; y: number },
  p2: { x: number; y: number }, p3: { x: number; y: number },
  t: number,
): { x: number; y: number } {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

function quadBezier(
  p0: { x: number; y: number }, p1: { x: number; y: number },
  p2: { x: number; y: number }, t: number,
): { x: number; y: number } {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
  };
}

function pathCenter(d: string): { x: number; y: number } | null {
  const coords: Array<{ x: number; y: number }> = [];
  // M, L 기본 좌표 추출
  const mlRe = /[ML]\s*([\d.-]+)[,\s]+([\d.-]+)/gi;
  let m;
  while ((m = mlRe.exec(d)) !== null) {
    coords.push({ x: Number(m[1]), y: Number(m[2]) });
  }

  // I1+: C (cubic Bézier) 샘플링 — 10% 간격 11 점
  const cRe = /C\s*([\d.-]+)[,\s]+([\d.-]+)[,\s]+([\d.-]+)[,\s]+([\d.-]+)[,\s]+([\d.-]+)[,\s]+([\d.-]+)/gi;
  while ((m = cRe.exec(d)) !== null) {
    const cp1 = { x: Number(m[1]), y: Number(m[2]) };
    const cp2 = { x: Number(m[3]), y: Number(m[4]) };
    const end = { x: Number(m[5]), y: Number(m[6]) };
    const start = coords.length > 0 ? coords[coords.length - 1] : { x: 0, y: 0 };
    for (let t = 0; t <= 1; t += 0.1) {
      coords.push(cubicBezier(start, cp1, cp2, end, t));
    }
  }

  // I1+: Q (quadratic Bézier) 샘플링
  const qRe = /Q\s*([\d.-]+)[,\s]+([\d.-]+)[,\s]+([\d.-]+)[,\s]+([\d.-]+)/gi;
  while ((m = qRe.exec(d)) !== null) {
    const cp = { x: Number(m[1]), y: Number(m[2]) };
    const end = { x: Number(m[3]), y: Number(m[4]) };
    const start = coords.length > 0 ? coords[coords.length - 1] : { x: 0, y: 0 };
    for (let t = 0; t <= 1; t += 0.1) {
      coords.push(quadBezier(start, cp, end, t));
    }
  }

  // S (smooth cubic) → C와 유사, 간소화
  const sRe = /S\s*([\d.-]+)[,\s]+([\d.-]+)[,\s]+([\d.-]+)[,\s]+([\d.-]+)/gi;
  while ((m = sRe.exec(d)) !== null) {
    coords.push({ x: Number(m[1]), y: Number(m[2]) });
    coords.push({ x: Number(m[3]), y: Number(m[4]) });
  }

  if (coords.length === 0) return null;
  const cx = coords.reduce((s, p) => s + p.x, 0) / coords.length;
  const cy = coords.reduce((s, p) => s + p.y, 0) / coords.length;
  return { x: Math.round(cx), y: Math.round(cy) };
}

// ─── Main ───

export function parseSvgDocument(svgString: string): ParsedSvgResult {
  if (typeof DOMParser === "undefined") throw new Error("SVG 파싱은 브라우저 환경에서만 가능");
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgString, "image/svg+xml");
  if (doc.querySelector("parsererror")) throw new Error("잘못된 SVG 형식");

  const cssMap = extractCSSFills(svgString);
  const seats: ParsedSeat[] = [];
  const landmarks: ParsedLandmark[] = [];
  const colorSet = new Set<string>();

  // 랜드마크 <g class="...">
  const landmarkGs = new Set<Element>();
  doc.querySelectorAll("g[class]").forEach((g) => {
    const cls = g.getAttribute("class") ?? "";
    const knownType = ["stage", "aisle", "exit", "restroom"].find((t) => cls.includes(t));
    if (!knownType) return;
    landmarkGs.add(g);
    const children = g.querySelectorAll("rect, circle, ellipse, path");
    if (children.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    children.forEach((c) => {
      const matrix = getAccumulatedTransform(c);
      if (c.tagName === "rect") {
        const p = transformPoint(numAttr(c, "x"), numAttr(c, "y"), matrix);
        const w = numAttr(c, "width"), h = numAttr(c, "height");
        if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
        if (p.x + w > maxX) maxX = p.x + w; if (p.y + h > maxY) maxY = p.y + h;
      } else if (c.tagName === "circle" || c.tagName === "ellipse") {
        const p = transformPoint(numAttr(c, "cx"), numAttr(c, "cy"), matrix);
        const r = numAttr(c, "r") || numAttr(c, "rx") || 10;
        if (p.x - r < minX) minX = p.x - r; if (p.y - r < minY) minY = p.y - r;
        if (p.x + r > maxX) maxX = p.x + r; if (p.y + r > maxY) maxY = p.y + r;
      }
    });
    if (Number.isFinite(minX)) {
      landmarks.push({
        type: knownType as ParsedLandmark["type"],
        label: g.getAttribute("data-label") ?? knownType,
        x: minX, y: minY, width: maxX - minX, height: maxY - minY,
      });
    }
  });

  function isInsideLandmark(el: Element): boolean {
    let p: Element | null = el.parentElement;
    while (p) { if (landmarkGs.has(p)) return true; p = p.parentElement; }
    return false;
  }

  // 좌석: circle/rect/ellipse + path (I1)
  let idx = 0;
  doc.querySelectorAll("circle, rect, ellipse, path").forEach((el) => {
    if (isInsideLandmark(el)) return;
    const matrix = getAccumulatedTransform(el);
    let cx = 0, cy = 0;
    if (el.tagName === "circle" || el.tagName === "ellipse") {
      const p = transformPoint(numAttr(el, "cx"), numAttr(el, "cy"), matrix);
      cx = p.x; cy = p.y;
    } else if (el.tagName === "rect") {
      const x = numAttr(el, "x"), y = numAttr(el, "y"), w = numAttr(el, "width"), h = numAttr(el, "height");
      const p = transformPoint(x + w / 2, y + h / 2, matrix);
      cx = p.x; cy = p.y;
    } else if (el.tagName === "path") {
      const d = el.getAttribute("d") ?? "";
      const center = pathCenter(d);
      if (!center) return;
      const p = transformPoint(center.x, center.y, matrix);
      cx = p.x; cy = p.y;
    }
    const label = el.getAttribute("id") ?? `S${idx + 1}`;
    const fill = extractFill(el, cssMap);
    if (fill && fill !== "none") colorSet.add(fill);
    seats.push({ id: crypto.randomUUID(), x: cx, y: cy, label, fill });
    idx += 1;
  });

  // I1: <text> 내용 → 가장 가까운 좌석에 label 매핑
  let textLabelsMatched = 0;
  doc.querySelectorAll("text").forEach((textEl) => {
    if (isInsideLandmark(textEl)) return;
    const content = textEl.textContent?.trim();
    if (!content || content.length > 10) return;
    const matrix = getAccumulatedTransform(textEl);
    const tx = numAttr(textEl, "x"), ty = numAttr(textEl, "y");
    const p = transformPoint(tx, ty, matrix);
    // 가장 가까운 좌석 찾기 (15px 이내)
    let bestDist = 15;
    let bestSeat: ParsedSeat | null = null;
    for (const s of seats) {
      const d = Math.sqrt((s.x - p.x) ** 2 + (s.y - p.y) ** 2);
      if (d < bestDist) { bestDist = d; bestSeat = s; }
    }
    if (bestSeat) {
      bestSeat.label = content;
      textLabelsMatched++;
    }
  });

  return { seats, landmarks, colors: Array.from(colorSet), textLabelsMatched };
}
