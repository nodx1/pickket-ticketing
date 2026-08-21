"use client";

import { useState } from "react";
import DOMPurify from "isomorphic-dompurify";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fetchWithAuth } from "@/lib/fetchWithAuth";
import { showError, showSuccess } from "@/lib/hooks/useToast";
import { useUnsavedChanges } from "@/lib/hooks/useUnsavedChanges";

interface CampaignComposerProps {
  eventId: string;
  /** 생성 성공 시 — 부모가 작성창을 닫고 목록을 갱신한다. */
  onCreated: () => void;
  onCancel: () => void;
}

export function CampaignComposer({ eventId, onCreated, onCancel }: CampaignComposerProps) {
  const [form, setForm] = useState({ subject: "", bodyHtml: "" });
  const [creating, setCreating] = useState(false);
  const [showBodyPreview, setShowBodyPreview] = useState(false);

  // B8: 입력이 있고 아직 저장 안 됐으면 dirty
  const formDirty = form.subject.trim().length > 0 || form.bodyHtml.trim().length > 0;
  useUnsavedChanges(formDirty);

  // 본문 편집 헬퍼(간이 리치에디터).
  function insertBody(text: string) {
    const el = document.getElementById("campaign-body") as HTMLTextAreaElement | null;
    const b = form.bodyHtml;
    if (!el) { setForm((p) => ({ ...p, bodyHtml: p.bodyHtml + text })); return; }
    const s = el.selectionStart ?? b.length;
    const e = el.selectionEnd ?? b.length;
    setForm((p) => ({ ...p, bodyHtml: b.slice(0, s) + text + b.slice(e) }));
  }
  function wrapBody(pre: string, post: string) {
    const el = document.getElementById("campaign-body") as HTMLTextAreaElement | null;
    const b = form.bodyHtml;
    if (!el) { setForm((p) => ({ ...p, bodyHtml: p.bodyHtml + pre + post })); return; }
    const s = el.selectionStart ?? b.length;
    const e = el.selectionEnd ?? b.length;
    setForm((p) => ({ ...p, bodyHtml: b.slice(0, s) + pre + b.slice(s, e) + post + b.slice(e) }));
  }

  async function handleCreate() {
    if (!form.subject || !form.bodyHtml) { showError("제목과 본문을 입력해주세요"); return; }
    setCreating(true);
    try {
      await fetchWithAuth(`/api/events/${eventId}/campaigns`, {
        method: "POST",
        body: JSON.stringify(form),
      });
      showSuccess("캠페인이 생성되었습니다");
      setForm({ subject: "", bodyHtml: "" });
      onCreated();
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "생성 실패");
    } finally {
      setCreating(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">새 캠페인 작성</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="campaign-subject">제목</Label>
          <Input id="campaign-subject" value={form.subject} onChange={(e) => setForm((p) => ({ ...p, subject: e.target.value }))} placeholder="이메일 제목" />
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="campaign-body">본문 (HTML)</Label>
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => wrapBody("<b>", "</b>")}
                className="rounded border border-border px-2 py-0.5 text-xs font-bold text-foreground hover:bg-bg-subtle">B</button>
              <button type="button" onClick={() => wrapBody("<h3>", "</h3>")}
                className="rounded border border-border px-2 py-0.5 text-xs text-foreground hover:bg-bg-subtle">제목</button>
              <button type="button" onClick={() => wrapBody("<a href=\"https://\">", "</a>")}
                className="rounded border border-border px-2 py-0.5 text-xs text-foreground hover:bg-bg-subtle">링크</button>
              <button type="button" onClick={() => wrapBody("<ul><li>", "</li></ul>")}
                className="rounded border border-border px-2 py-0.5 text-xs text-foreground hover:bg-bg-subtle">목록</button>
              <button type="button" onClick={() => insertBody("{{name}}")}
                className="rounded border border-border px-2 py-0.5 text-xs text-foreground hover:bg-bg-subtle">{"{{name}}"}</button>
              <button type="button" onClick={() => setShowBodyPreview((v) => !v)}
                className="rounded border border-border px-2 py-0.5 text-xs text-foreground hover:bg-bg-subtle">
                {showBodyPreview ? "편집" : "미리보기"}
              </button>
            </div>
          </div>
          {showBodyPreview ? (
            <div className="min-h-[8rem] rounded-lg border border-border bg-background p-3 text-sm">
              <div className="prose prose-sm max-w-none text-foreground"
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(form.bodyHtml || "<p class='text-muted-foreground'>본문 미리보기</p>") }} />
              <p className="mt-2 text-[11px] text-content-muted">{"{{name}}"}은 수신자 이름으로 치환됩니다.</p>
            </div>
          ) : (
            <textarea
              id="campaign-body"
              className="w-full rounded-lg border border-border bg-muted p-3 text-sm text-foreground placeholder:text-muted-foreground"
              rows={8}
              value={form.bodyHtml}
              onChange={(e) => setForm((p) => ({ ...p, bodyHtml: e.target.value }))}
              placeholder="이메일 본문을 입력하세요..."
            />
          )}
        </div>
        <div className="flex gap-2">
          <Button onClick={() => void handleCreate()} disabled={creating}>
            {creating ? "생성 중..." : "캠페인 생성"}
          </Button>
          <Button variant="outline" onClick={onCancel}>취소</Button>
        </div>
      </CardContent>
    </Card>
  );
}
