/**
 * 트랙 5.2 + Phase I2 고도화 — DXF (AutoCAD) 도면에서 좌석 추출
 *
 * 개선 (I2):
 * - ✅ BLOCKS 섹션 파싱 + INSERT 참조 시 geometry 전개
 * - ✅ SPLINE: 제어점 → 5px 간격 샘플링 → 좌석 후보
 * - ✅ TEXT → 좌석 proximity 매칭 (거리 < 2 × seatSize)
 * - ✅ 단위 자동 추정 (bounding box / 일반 좌석 크기 역산)
 *
 * 타겟: 70% → 85%
 */

export interface DxfSeat {
  id: string;
  x: number;
  y: number;
  label: string;
  layer: string;
}

export interface DxfLandmark {
  type: "stage" | "aisle" | "exit" | "custom";
  label: string;
  x: number;
  y: number;
  layer: string;
}

export interface DxfParseResult {
  seats: DxfSeat[];
  landmarks: DxfLandmark[];
  layers: string[];
  /** I2 — TEXT proximity 매칭된 수 */
  textLabelsMatched: number;
  /** I2 — 자동 추정 스케일 */
  estimatedScale: number;
}

function parsePairs(text: string): Array<[number, string]> {
  const lines = text.split(/\r?\n/);
  const pairs: Array<[number, string]> = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number.parseInt(lines[i].trim(), 10);
    const value = lines[i + 1] ?? "";
    if (Number.isFinite(code)) pairs.push([code, value.trim()]);
  }
  return pairs;
}

function isSeatLayer(layer: string): boolean { return /seat|좌석|chair/i.test(layer); }
function isStageLayer(layer: string): boolean { return /stage|무대/i.test(layer); }
function isAisleLayer(layer: string): boolean { return /aisle|통로|path/i.test(layer); }
function isExitLayer(layer: string): boolean { return /exit|출구/i.test(layer); }

interface RawEntity {
  type: string;
  layer: string;
  cx?: number;
  cy?: number;
  text?: string;
  blockName?: string;
  // SPLINE control points
  splinePoints?: Array<{ x: number; y: number }>;
}

// ─── I2: BLOCKS 파싱 ───

interface BlockDef {
  name: string;
  entities: RawEntity[];
}

function parseBlocks(pairs: Array<[number, string]>): Map<string, BlockDef> {
  const blocks = new Map<string, BlockDef>();
  let inBlocks = false;
  let currentBlock: BlockDef | null = null;
  let currentEntity: RawEntity | null = null;

  for (const [code, value] of pairs) {
    if (code === 0 && value === "BLOCK") {
      inBlocks = true;
      currentBlock = { name: "", entities: [] };
      continue;
    }
    if (code === 0 && value === "ENDBLK") {
      if (currentBlock && currentBlock.name) blocks.set(currentBlock.name, currentBlock);
      currentBlock = null;
      continue;
    }
    if (code === 2 && value === "BLOCKS") { inBlocks = true; continue; }
    if (code === 0 && value === "ENDSEC" && inBlocks) { inBlocks = false; continue; }

    if (!currentBlock) continue;
    if (code === 2 && !currentBlock.name) { currentBlock.name = value; continue; }
    if (code === 0) {
      if (currentEntity) currentBlock.entities.push(currentEntity);
      currentEntity = { type: value, layer: "0" };
      continue;
    }
    if (!currentEntity) continue;
    if (code === 8) currentEntity.layer = value;
    else if (code === 10) currentEntity.cx = Number.parseFloat(value);
    else if (code === 20) currentEntity.cy = Number.parseFloat(value);
    else if (code === 1) currentEntity.text = value;
  }
  return blocks;
}

// ─── I2: SPLINE 샘플링 ───

function sampleSpline(points: Array<{ x: number; y: number }>, interval: number): Array<{ x: number; y: number }> {
  if (points.length < 2) return points;
  const samples: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i], p1 = points[i + 1];
    const dist = Math.sqrt((p1.x - p0.x) ** 2 + (p1.y - p0.y) ** 2);
    const steps = Math.max(1, Math.round(dist / interval));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      samples.push({ x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t });
    }
  }
  samples.push(points[points.length - 1]);
  return samples;
}

// ─── I2+: HEADER $INSUNITS 자동 단위 ───

function detectInsUnits(pairs: Array<[number, string]>): number {
  // DXF $INSUNITS: 1=inches, 2=feet, 4=mm, 5=cm, 6=m
  let inHeader = false;
  let foundVar = false;
  for (const [code, value] of pairs) {
    if (code === 0 && value === "ENDSEC") { inHeader = false; continue; }
    if (code === 2 && value === "HEADER") { inHeader = true; continue; }
    if (!inHeader) continue;
    if (code === 9 && value === "$INSUNITS") { foundVar = true; continue; }
    if (foundVar && code === 70) {
      return Number.parseInt(value, 10);
    }
  }
  return 0; // unknown
}

function insUnitsToScale(units: number): number {
  // → pixels 변환 (1px ≈ 0.3mm at 300dpi 기준, 실용적으로 1m = 100px)
  switch (units) {
    case 1: return 2.54;   // inches → ×2.54(cm) → ×100/100 ≈ 2.54px
    case 2: return 30.48;  // feet → ×30.48
    case 4: return 0.1;    // mm → ×0.1px
    case 5: return 1;      // cm → 1px
    case 6: return 100;    // m → 100px
    default: return 1;
  }
}

// ─── I2+: Layer color filter ───

interface LayerDef {
  name: string;
  color: number;
  frozen: boolean;
  off: boolean;
}

function parseLayers(pairs: Array<[number, string]>): Map<string, LayerDef> {
  const layers = new Map<string, LayerDef>();
  let inLayer = false;
  let current: LayerDef | null = null;
  for (const [code, value] of pairs) {
    if (code === 0 && value === "TABLE") { continue; }
    if (code === 0 && value === "ENDTAB") {
      if (current) { layers.set(current.name, current); current = null; }
      inLayer = false; continue;
    }
    if (code === 0 && value === "LAYER") { inLayer = true; current = { name: "", color: 7, frozen: false, off: false }; continue; }
    if (!inLayer || !current) continue;
    if (code === 2) current.name = value;
    else if (code === 62) {
      const c = Number.parseInt(value, 10);
      current.color = Math.abs(c);
      current.off = c < 0; // 음수 = layer off
    }
    else if (code === 70) {
      const flags = Number.parseInt(value, 10);
      current.frozen = (flags & 1) !== 0;
    }
  }
  return layers;
}

// ─── Main ───

export function parseDxfDocument(
  dxfText: string,
  options?: { scale?: number; flipY?: boolean },
): DxfParseResult {
  const userScale = options?.scale;
  const flipY = options?.flipY ?? false;
  const pairs = parsePairs(dxfText);
  const blocks = parseBlocks(pairs);

  // I2+: HEADER 에서 $INSUNITS 자동 감지
  const insUnits = detectInsUnits(pairs);
  const unitScale = insUnitsToScale(insUnits);

  // I2+: TABLES 에서 레이어 정의 (frozen/off 필터)
  const layerDefs = parseLayers(pairs);
  function isLayerVisible(layerName: string): boolean {
    const def = layerDefs.get(layerName);
    if (!def) return true; // 정의 없으면 보임
    return !def.frozen && !def.off;
  }

  const entities: RawEntity[] = [];
  const layerSet = new Set<string>();
  let current: RawEntity | null = null;
  let inEntities = false;
  let splineCollecting = false;
  let splinePoints: Array<{ x: number; y: number }> = [];

  for (const [code, value] of pairs) {
    if (code === 0) {
      if (current && inEntities) {
        if (splineCollecting && splinePoints.length > 0) {
          current.splinePoints = [...splinePoints];
          splineCollecting = false;
          splinePoints = [];
        }
        if (current.cx !== undefined && current.cy !== undefined) entities.push(current);
        else if (current.type === "SPLINE" && current.splinePoints && current.splinePoints.length > 0) entities.push(current);
      }
      if (value === "ENDSEC") { inEntities = false; current = null; continue; }
      current = inEntities ? { type: value, layer: "0" } : null;
      if (value === "SPLINE") splineCollecting = true;
      continue;
    }
    if (code === 2 && !inEntities && value === "ENTITIES") { inEntities = true; continue; }
    if (!current || !inEntities) continue;
    if (code === 8) { current.layer = value; layerSet.add(value); }
    else if (code === 10) { if (splineCollecting) splinePoints.push({ x: Number.parseFloat(value), y: 0 }); else current.cx = Number.parseFloat(value); }
    else if (code === 20) {
      const y = Number.parseFloat(value);
      if (splineCollecting && splinePoints.length > 0) { splinePoints[splinePoints.length - 1].y = flipY ? -y : y; }
      else { current.cy = flipY ? -y : y; }
    }
    else if (code === 1) current.text = value;
    else if (code === 2) current.blockName = value;
  }
  // flush last
  if (current && inEntities && current.cx !== undefined) entities.push(current);

  // I2+: 단위 자동 추정 — $INSUNITS 우선, 없으면 bbox 역산
  let autoScale = unitScale; // HEADER 기반
  if (!userScale && insUnits === 0) {
    // $INSUNITS 없음 → bbox 기반 fallback
    const seatEntities = entities.filter((e) => (e.type === "CIRCLE" || e.type === "INSERT") && isSeatLayer(e.layer));
    if (seatEntities.length > 2) {
      const xs = seatEntities.filter((e) => e.cx !== undefined).map((e) => e.cx!);
      const ys = seatEntities.filter((e) => e.cy !== undefined).map((e) => e.cy!);
      const bboxW = Math.max(...xs) - Math.min(...xs);
      const bboxH = Math.max(...ys) - Math.min(...ys);
      const maxDim = Math.max(bboxW, bboxH);
      if (maxDim > 1000) autoScale = 1000 / maxDim;
      else if (maxDim > 100) autoScale = 10;
    }
  }
  const scale = userScale ?? autoScale;

  // 좌석 + 랜드마크 추출
  const seats: DxfSeat[] = [];
  const landmarks: DxfLandmark[] = [];
  const textEntities: Array<{ x: number; y: number; text: string }> = [];
  let seatIdx = 0;

  for (const e of entities) {
    // I2+: frozen/off 레이어 엔티티 제외
    if (!isLayerVisible(e.layer)) continue;

    // I2: INSERT → Block 전개
    if (e.type === "INSERT" && e.blockName && e.cx !== undefined && e.cy !== undefined) {
      const block = blocks.get(e.blockName);
      if (block) {
        for (const be of block.entities) {
          if ((be.type === "CIRCLE" || be.type === "ARC") && isSeatLayer(be.layer || e.layer)) {
            seats.push({
              id: crypto.randomUUID(),
              x: Math.round(((e.cx ?? 0) + (be.cx ?? 0)) * scale),
              y: Math.round(((e.cy ?? 0) + (be.cy ?? 0)) * scale),
              label: `S${seatIdx + 1}`,
              layer: be.layer || e.layer,
            });
            seatIdx++;
          }
        }
        continue;
      }
      // Block 정의 없는 INSERT → 단일 좌석으로 처리
      if (isSeatLayer(e.layer)) {
        seats.push({
          id: crypto.randomUUID(),
          x: Math.round(e.cx * scale), y: Math.round(e.cy * scale),
          label: `S${seatIdx + 1}`, layer: e.layer,
        });
        seatIdx++;
      }
      continue;
    }

    // I2: SPLINE → 샘플링 후 좌석 후보 (좌석 레이어만)
    if (e.type === "SPLINE" && e.splinePoints && isSeatLayer(e.layer)) {
      const samples = sampleSpline(e.splinePoints, 5);
      for (const sp of samples) {
        seats.push({
          id: crypto.randomUUID(),
          x: Math.round(sp.x * scale), y: Math.round(sp.y * scale),
          label: `S${seatIdx + 1}`, layer: e.layer,
        });
        seatIdx++;
      }
      continue;
    }

    // CIRCLE → 좌석
    if (e.type === "CIRCLE" && isSeatLayer(e.layer) && e.cx !== undefined && e.cy !== undefined) {
      seats.push({
        id: crypto.randomUUID(),
        x: Math.round(e.cx * scale), y: Math.round(e.cy * scale),
        label: `S${seatIdx + 1}`, layer: e.layer,
      });
      seatIdx++;
      continue;
    }

    // TEXT → 모아두고 나중에 proximity 매칭
    if (e.type === "TEXT" && e.text && e.cx !== undefined && e.cy !== undefined) {
      textEntities.push({ x: Math.round(e.cx * scale), y: Math.round(e.cy * scale), text: e.text });
      // 랜드마크 텍스트
      let landmarkType: DxfLandmark["type"] | null = null;
      if (isStageLayer(e.layer)) landmarkType = "stage";
      else if (isAisleLayer(e.layer)) landmarkType = "aisle";
      else if (isExitLayer(e.layer)) landmarkType = "exit";
      if (landmarkType) {
        landmarks.push({ type: landmarkType, label: e.text, x: Math.round(e.cx * scale), y: Math.round(e.cy * scale), layer: e.layer });
      }
      continue;
    }

    // 기타 랜드마크
    if ((e.type === "INSERT" || e.type === "CIRCLE") && e.cx !== undefined && e.cy !== undefined) {
      let lt: DxfLandmark["type"] | null = null;
      if (isStageLayer(e.layer)) lt = "stage";
      else if (isAisleLayer(e.layer)) lt = "aisle";
      else if (isExitLayer(e.layer)) lt = "exit";
      if (lt) landmarks.push({ type: lt, label: e.text ?? lt, x: Math.round(e.cx * scale), y: Math.round(e.cy * scale), layer: e.layer });
    }
  }

  // I2: TEXT → 좌석 proximity 매칭
  let textLabelsMatched = 0;
  const avgSeatSize = seats.length > 0
    ? Math.max(20, Math.sqrt(seats.length) * 2)
    : 30;
  for (const te of textEntities) {
    let bestDist = avgSeatSize * 2;
    let bestSeat: DxfSeat | null = null;
    for (const s of seats) {
      const d = Math.sqrt((s.x - te.x) ** 2 + (s.y - te.y) ** 2);
      if (d < bestDist) { bestDist = d; bestSeat = s; }
    }
    if (bestSeat) { bestSeat.label = te.text; textLabelsMatched++; }
  }

  return {
    seats, landmarks, layers: Array.from(layerSet),
    textLabelsMatched, estimatedScale: scale,
  };
}
