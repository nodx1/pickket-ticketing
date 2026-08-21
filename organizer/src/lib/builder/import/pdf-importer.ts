/**
 * 트랙 5.3 — PDF 도면 임포트
 *
 * PDF 페이지를 canvas 로 렌더해 이미지를 얻고, 트랙 4.1 AI 파이프라인으로 전달.
 * pdf.js 는 무거운 의존성이라 동적 import + lazy load.
 *
 * 사용:
 *   const pages = await renderPdfPages(file, { dpi: 300 });
 *   for (const imageData of pages) { /* AI 파이프라인 *​/ }
 */

export interface RenderedPdfPage {
  /** 페이지 번호 (1-indexed) */
  pageNumber: number;
  /** 캔버스 width (px) */
  width: number;
  /** 캔버스 height (px) */
  height: number;
  /** ImageData 또는 Blob URL */
  imageDataUrl: string;
}

interface RenderOptions {
  dpi?: number;
  /** 페이지 범위 (1-indexed). 미지정 시 전체 */
  pageRange?: { from: number; to: number };
}

/**
 * PDF File → 페이지별 PNG dataURL.
 * 브라우저 전용 (pdf.js 동적 import).
 */
export async function renderPdfPages(
  file: File,
  options?: RenderOptions,
): Promise<RenderedPdfPage[]> {
  if (typeof window === "undefined") {
    throw new Error("PDF 렌더링은 브라우저 환경에서만 사용 가능합니다");
  }

  const dpi = options?.dpi ?? 300;
  // PDF 표준 1pt = 1/72 인치 → DPI 환산 비율
  const scale = dpi / 72;

  // 동적 import (pdfjs-dist 가 설치되어 있을 때만 — 본 세션에서는 미설치, 런타임 lazy load)
  // 타입 import 회피를 위해 unknown 캐스팅
  let pdfjs: {
    GlobalWorkerOptions?: { workerSrc?: string };
    getDocument: (params: { data: ArrayBuffer }) => {
      promise: Promise<{
        numPages: number;
        getPage: (n: number) => Promise<{
          getViewport: (params: { scale: number }) => {
            width: number;
            height: number;
          };
          render: (params: unknown) => { promise: Promise<void> };
        }>;
      }>;
    };
  };
  try {
    pdfjs = (await import(
      /* @vite-ignore */ "pdfjs-dist" as string
    )) as typeof pdfjs;
  } catch {
    throw new Error(
      "pdfjs-dist 가 설치되어 있지 않습니다. npm install pdfjs-dist 후 다시 시도해주세요.",
    );
  }

  // worker 경로 — pdfjs-dist v4 는 ES module worker 필요
  if (pdfjs.GlobalWorkerOptions && !pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc =
      "https://cdn.jsdelivr.net/npm/pdfjs-dist@4/build/pdf.worker.min.mjs";
  }

  const arrayBuffer = await file.arrayBuffer();
  const loadingTask = pdfjs.getDocument({ data: arrayBuffer });
  const doc = await loadingTask.promise;

  const pages: RenderedPdfPage[] = [];
  const start = options?.pageRange?.from ?? 1;
  const end = options?.pageRange?.to ?? doc.numPages;

  for (let pageNum = start; pageNum <= end; pageNum++) {
    const page = await doc.getPage(pageNum);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) continue;

    await page.render({ canvas, canvasContext: ctx, viewport }).promise;

    pages.push({
      pageNumber: pageNum,
      width: canvas.width,
      height: canvas.height,
      imageDataUrl: canvas.toDataURL("image/png"),
    });
  }

  return pages;
}
