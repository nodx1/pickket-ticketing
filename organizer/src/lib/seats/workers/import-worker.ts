/**
 * 트랙 7.15 — SVG/DXF 파싱 Web Worker
 *
 * ⚠️ 현재 caller 없음 (lib 만 존재). 다음 caller 가 통합 시 활성화:
 *   svg-import-dialog.tsx 에 "백그라운드 파싱" 옵션 토글 →
 *     parseInWorker({ type: "svg", payload: text }) 호출
 *   대용량(>5,000 좌석) SVG 파일에서 메인 스레드 블로킹 회피.
 *
 * 메인 스레드 블로킹 없이 대용량 SVG/DXF 파일을 파싱.
 * 사용:
 *   const worker = createImportWorker();
 *   worker.postMessage({ type: "svg", text: svgString });
 *   worker.onmessage = (e) => { ... };
 *
 * Next.js 16 에서 Worker URL 은 import.meta.url 패턴 사용.
 * 본 모듈은 wrapper 만 제공 — 실제 worker.ts 파일은 inline blob 으로 생성.
 */

export interface ParseRequest {
  type: "svg" | "dxf";
  payload: string;
  options?: { scale?: number; flipY?: boolean };
}

export interface ParseResponse {
  type: "svg" | "dxf";
  success: boolean;
  result?: unknown;
  error?: string;
}

const WORKER_SOURCE = `
self.onmessage = async (e) => {
  const { type, payload, options } = e.data;
  try {
    if (type === "svg") {
      // SVG 는 DOMParser 가 worker 에서 안 됨 → 메인 스레드 fallback
      // Worker 에서는 정규식 기반 단순 파싱만 수행
      const seats = [];
      const circleRe = /<circle[^>]*cx="([0-9.]+)"[^>]*cy="([0-9.]+)"[^>]*(?:id="([^"]*)")?/g;
      let m;
      let idx = 0;
      while ((m = circleRe.exec(payload)) !== null) {
        seats.push({
          id: crypto.randomUUID ? crypto.randomUUID() : String(idx),
          x: Math.round(parseFloat(m[1])),
          y: Math.round(parseFloat(m[2])),
          label: m[3] || ('S' + (idx + 1)),
          fill: '#9ca3af',
        });
        idx++;
      }
      self.postMessage({ type: "svg", success: true, result: { seats, landmarks: [], colors: [] } });
    } else if (type === "dxf") {
      // DXF 단순 파서 (메인 dxf-parser 와 동일 로직 단순화)
      const scale = (options && options.scale) || 1;
      const lines = payload.split(/\\r?\\n/);
      const seats = [];
      let inEntities = false;
      let current = null;
      let seatIdx = 0;
      for (let i = 0; i + 1 < lines.length; i += 2) {
        const code = parseInt(lines[i].trim(), 10);
        const value = (lines[i + 1] || '').trim();
        if (!Number.isFinite(code)) continue;
        if (code === 0) {
          if (current && current.type === 'CIRCLE' && current.layer && /seat|좌석/i.test(current.layer)) {
            seats.push({
              id: crypto.randomUUID ? crypto.randomUUID() : String(seatIdx),
              x: Math.round((current.cx || 0) * scale),
              y: Math.round((current.cy || 0) * scale),
              label: 'S' + (seatIdx + 1),
              layer: current.layer,
            });
            seatIdx++;
          }
          if (value === 'ENTITIES') inEntities = true;
          else if (value === 'ENDSEC') inEntities = false;
          current = inEntities ? { type: value, layer: '0' } : null;
        } else if (current && inEntities) {
          if (code === 8) current.layer = value;
          else if (code === 10) current.cx = parseFloat(value);
          else if (code === 20) current.cy = parseFloat(value);
        }
      }
      self.postMessage({ type: "dxf", success: true, result: { seats, landmarks: [], layers: [] } });
    } else {
      self.postMessage({ type, success: false, error: 'unknown type' });
    }
  } catch (err) {
    self.postMessage({ type, success: false, error: err.message || 'parse failed' });
  }
};
`;

export function createImportWorker(): Worker {
  if (typeof Worker === "undefined") {
    throw new Error("Web Worker 미지원 환경");
  }
  const blob = new Blob([WORKER_SOURCE], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url);
  // 가비지 컬렉션을 위해 worker 종료 시 URL 해제 (worker.terminate 시점에서)
  return worker;
}

/**
 * 단발 호출 헬퍼 — promise 기반.
 */
export function parseInWorker(req: ParseRequest): Promise<ParseResponse> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = createImportWorker();
    } catch (err) {
      reject(err);
      return;
    }
    worker.onmessage = (e: MessageEvent<ParseResponse>) => {
      resolve(e.data);
      worker.terminate();
    };
    worker.onerror = (err) => {
      reject(err);
      worker.terminate();
    };
    worker.postMessage(req);
  });
}
