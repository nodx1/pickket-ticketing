"use client";

/**
 * 트랙 5.1 — SVG 임포트 모달
 *
 * Illustrator / Inkscape 에서 저장한 SVG 파일을 업로드하면
 * - <circle>/<rect> → 좌석 후보
 * - fill 색상 → tier 후보
 * - <g class="stage"> → 랜드마크
 * 를 추출해 빌더에 바로 주입한다.
 */

import React, { useState } from "react";
import { FileJson, Upload } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  parseSvgDocument,
  type ParsedSvgResult,
} from "@/lib/builder/import/svg-parser";
import { showError, showSuccess } from "@/lib/hooks/useToast";
import type { GeneratedSeat } from "@/lib/builder/row-wizard";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultTierId?: string | null;
  onImported: (seats: GeneratedSeat[]) => void;
}

export function SvgImportDialog({
  open,
  onOpenChange,
  defaultTierId,
  onImported,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<ParsedSvgResult | null>(null);
  const [fileName, setFileName] = useState<string>("");

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!/\.svgz?$/i.test(file.name)) {
      showError("SVG 파일을 선택해주세요");
      return;
    }
    setFileName(file.name);
    setLoading(true);
    try {
      const text = await file.text();
      const parsed = parseSvgDocument(text);
      setPreview(parsed);
      if (parsed.seats.length === 0) {
        showError("좌석으로 인식할 수 있는 도형이 없습니다");
      }
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "SVG 파싱 실패");
      setPreview(null);
    } finally {
      setLoading(false);
    }
  }

  function handleConfirm() {
    if (!preview) return;
    const generated: GeneratedSeat[] = preview.seats.map((s) => ({
      id: s.id,
      x: s.x,
      y: s.y,
      label: s.label,
      tierId: defaultTierId ?? null,
      isObstructed: false,
    }));
    onImported(generated);
    showSuccess(`${generated.length}석을 가져왔습니다`);
    onOpenChange(false);
    setPreview(null);
    setFileName("");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileJson className="size-5 text-primary" aria-hidden />
            SVG 도면 불러오기
          </DialogTitle>
          <DialogDescription>
            Illustrator / Inkscape 에서 저장한 SVG 파일을 업로드하면 도형을 좌석으로
            자동 변환합니다. <code>&lt;g class=&quot;stage&quot;&gt;</code>는 무대 랜드마크로
            인식합니다.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <label className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted p-6 text-sm text-muted-foreground hover:border-primary hover:text-primary">
            <Upload className="size-4" aria-hidden />
            {fileName || "SVG 파일 선택"}
            <input
              type="file"
              accept=".svg,.svgz,image/svg+xml"
              className="hidden"
              onChange={(e) => void handleFile(e)}
            />
          </label>
          {loading ? (
            <p className="text-xs text-muted-foreground">파싱 중…</p>
          ) : null}
          {preview ? (
            <div className="rounded-lg border border-border bg-card p-3 text-sm">
              <p className="font-medium text-foreground">
                좌석 {preview.seats.length}개 추출
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                랜드마크 {preview.landmarks.length}개, 색상 {preview.colors.length}종
              </p>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            취소
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={!preview || preview.seats.length === 0}
          >
            {preview ? `${preview.seats.length}석 가져오기` : "가져오기"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
