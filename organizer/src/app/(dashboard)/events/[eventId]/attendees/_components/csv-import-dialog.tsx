"use client";

import { useRef, useState } from "react";
import { Upload, FileSpreadsheet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { showError, showSuccess } from "@/lib/hooks/useToast";
import { fetchWithRefresh } from "@/lib/fetchWithAuth";
import {
  clearDurableIdempotencyKey,
  getDurableIdempotencyKey,
} from "@/lib/client/idempotency";

interface ColumnMapping {
  header: string;
  field: string | null;
  confidence: number;
}

interface AnalysisResult {
  headers: string[];
  sampleRows: string[][];
  mapping: ColumnMapping[];
  totalRows: number;
}

export function CsvImportDialog({ eventId, onImported }: { eventId: string; onImported: () => void }) {
  const [open, setOpen] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [importing, setImporting] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFileSelect(file: File) {
    setAnalyzing(true);
    setUploadedFile(file);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetchWithRefresh(`/api/events/${eventId}/import`, {
        method: "POST",
        credentials: "include",
        body: formData,
      });
      if (!res.ok) throw new Error("CSV 분석 실패");
      const data = (await res.json()) as { data: AnalysisResult };
      setAnalysis(data.data);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "CSV 분석 실패");
      setUploadedFile(null);
    } finally {
      setAnalyzing(false);
    }
  }

  async function handleImport() {
    if (!analysis || !uploadedFile) return;
    setImporting(true);
    try {
      const formData = new FormData();
      formData.append("file", uploadedFile);
      formData.append("mapping", JSON.stringify(analysis.mapping));
      const scope = `attendee-import:${eventId}`;
      const fingerprint = [
        uploadedFile.name,
        uploadedFile.size,
        uploadedFile.lastModified,
        JSON.stringify(analysis.mapping),
      ].join(":");
      const idempotencyKey = getDurableIdempotencyKey(scope, fingerprint);

      const res = await fetchWithRefresh(`/api/events/${eventId}/import/confirm`, {
        method: "POST",
        credentials: "include",
        headers: { "Idempotency-Key": idempotencyKey },
        body: formData,
      });

      if (!res.ok) {
        const errPayload = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errPayload.error ?? "임포트 실패");
      }

      const payload = (await res.json()) as { data?: { imported?: number } };
      clearDurableIdempotencyKey(scope, idempotencyKey);
      showSuccess(`${payload.data?.imported ?? 0}명이 임포트되었습니다`);
      setOpen(false);
      setAnalysis(null);
      setUploadedFile(null);
      onImported();
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "임포트 실패");
    } finally {
      setImporting(false);
    }
  }

  if (!open) {
    return (
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Upload className="size-4" />
        CSV 임포트
      </Button>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <FileSpreadsheet className="size-5" />
          CSV 스마트 임포트
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!analysis ? (
          <div className="space-y-4">
            <div
              className="flex cursor-pointer flex-col items-center gap-3 rounded-lg border-2 border-dashed border-border p-8 text-center transition hover:border-primary/50"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const file = e.dataTransfer.files[0];
                if (file && file.name.endsWith(".csv")) {
                  void handleFileSelect(file);
                } else {
                  showError("CSV 파일만 업로드할 수 있습니다");
                }
              }}
            >
              <Upload className="size-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">CSV 파일을 드래그하거나 클릭하여 업로드</p>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFileSelect(file);
              }}
            />
            {analyzing && <p className="text-center text-sm text-muted-foreground">AI가 컬럼을 분석하는 중...</p>}
            <Button variant="outline" onClick={() => setOpen(false)}>취소</Button>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              총 {analysis.totalRows}행 감지 · AI 컬럼 매핑 결과:
            </p>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="p-2 text-left text-muted-foreground">원본 헤더</th>
                    <th className="p-2 text-left text-muted-foreground">매핑 필드</th>
                    <th className="p-2 text-left text-muted-foreground">신뢰도</th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.mapping.map((m, idx) => (
                    <tr key={idx} className="border-b border-border/50">
                      <td className="p-2 text-foreground">{m.header}</td>
                      <td className="p-2 text-primary">{m.field ?? "-"}</td>
                      <td className="p-2 text-muted-foreground">{Math.round(m.confidence * 100)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex gap-2">
              <Button onClick={() => void handleImport()} disabled={importing}>
                {importing ? "임포트 중..." : `${analysis.totalRows}명 임포트`}
              </Button>
              <Button variant="outline" onClick={() => { setAnalysis(null); setOpen(false); }}>취소</Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
