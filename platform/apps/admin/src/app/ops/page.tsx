"use client";

/**
 * 운영 작업보드 (/ops) — 사람(운영팀)과 AI 에이전트가 공유하는 SSOT 칸반.
 * 백엔드: /api/v1/admin/ops/tasks (에이전트는 /internal 경로로 같은 데이터를 씀).
 * 설계: docs/OPS_ORCHESTRATION_PLAN.md §3. assignee/created_by 는 user:*|agent:* 로 구분.
 */

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Plus, RefreshCw, Bot, User as UserIcon, MessageSquare } from "lucide-react";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  Textarea,
} from "@pickket/ui";
import api from "@pickket/lib/api";

// ── Types ──

interface OpsTask {
  id: string;
  title: string;
  body: string | null;
  status: "backlog" | "in_progress" | "review" | "blocked" | "done";
  label: string;
  priority: "critical" | "high" | "medium" | "low";
  assignee: string | null;
  created_by: string;
  source: string;
  links: Record<string, string> | null;
  due_at: string | null;
  created_at: string;
  updated_at: string;
  comment_count: number;
}

interface OpsComment {
  id: string;
  author: string;
  body: string;
  created_at: string;
}

const STATUSES = [
  { key: "backlog", title: "백로그" },
  { key: "in_progress", title: "진행중" },
  { key: "review", title: "리뷰" },
  { key: "blocked", title: "차단됨" },
  { key: "done", title: "완료" },
] as const;

const LABELS = ["frontend", "backend", "security", "cs", "sales", "ops", "bug", "feature"] as const;
const PRIORITIES = ["critical", "high", "medium", "low"] as const;

const PRIORITY_STYLE: Record<string, string> = {
  critical: "bg-destructive/10 text-destructive border-destructive/30",
  high: "bg-warning/10 text-warning border-warning/30",
  medium: "bg-primary/10 text-primary border-primary/30",
  low: "bg-muted text-muted-foreground border-border",
};

function AssigneeChip({ who }: { who: string | null }) {
  if (!who) return <span className="text-xs text-muted-foreground">미배정</span>;
  const isAgent = who.startsWith("agent:") || who.startsWith("cron:");
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      {isAgent ? <Bot className="h-3 w-3 text-primary" /> : <UserIcon className="h-3 w-3 text-primary" />}
      {who.replace(/^(user|agent|cron):/, "")}
    </span>
  );
}

export default function OpsBoardPage() {
  const [tasks, setTasks] = useState<OpsTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [labelFilter, setLabelFilter] = useState("");
  const [detail, setDetail] = useState<OpsTask | null>(null);
  const [comments, setComments] = useState<OpsComment[]>([]);
  const [commentDraft, setCommentDraft] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState({ title: "", body: "", label: "ops", priority: "medium" });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = labelFilter ? `?label=${labelFilter}` : "";
      const res = await api.get<OpsTask[]>(`/admin/ops/tasks${qs}`);
      setTasks(res.data);
    } catch {
      toast.error("보드를 불러오지 못했습니다");
    } finally {
      setLoading(false);
    }
  }, [labelFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  async function openDetail(task: OpsTask) {
    setDetail(task);
    setComments([]);
    try {
      const res = await api.get<OpsComment[]>(`/admin/ops/tasks/${task.id}/comments`);
      setComments(res.data);
    } catch {
      /* 코멘트 로드 실패는 카드 표시를 막지 않음 */
    }
  }

  async function patchTask(taskId: string, patch: Partial<OpsTask>) {
    try {
      const res = await api.patch<OpsTask>(`/admin/ops/tasks/${taskId}`, patch);
      setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, ...res.data } : t)));
      if (detail?.id === taskId) setDetail((d) => (d ? { ...d, ...res.data } : d));
    } catch {
      toast.error("변경에 실패했습니다");
    }
  }

  async function addComment() {
    if (!detail || !commentDraft.trim()) return;
    try {
      const res = await api.post<OpsComment>(`/admin/ops/tasks/${detail.id}/comments`, {
        author: "user:me", // 서버가 로그인 사용자로 덮어씀
        body: commentDraft.trim(),
      });
      setComments((prev) => [...prev, res.data]);
      setCommentDraft("");
    } catch {
      toast.error("코멘트 등록 실패");
    }
  }

  async function createTask() {
    if (draft.title.trim().length < 2) {
      toast.error("제목을 입력해주세요");
      return;
    }
    setSaving(true);
    try {
      await api.post(`/admin/ops/tasks`, {
        ...draft,
        title: draft.title.trim(),
        body: draft.body.trim() || null,
        created_by: "user:me", // 서버가 로그인 사용자로 덮어씀
      });
      toast.success("카드가 생성되었습니다");
      setCreateOpen(false);
      setDraft({ title: "", body: "", label: "ops", priority: "medium" });
      await load();
    } catch {
      toast.error("생성에 실패했습니다");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">운영 보드</h1>
          <p className="text-sm text-muted-foreground">
            사람(<UserIcon className="inline h-3 w-3 text-primary" />)과 AI 에이전트(
            <Bot className="inline h-3 w-3 text-primary" />)가 공유하는 작업 SSOT
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={labelFilter}
            onChange={(e) => setLabelFilter(e.target.value)}
            className="h-9 rounded-md border border-border bg-background text-foreground px-2 text-sm"
          >
            <option value="">전체 라벨</option>
            {LABELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1 h-4 w-4" /> 새 카드
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex min-h-[40vh] items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-5">
          {STATUSES.map((col) => {
            const items = tasks.filter((t) => t.status === col.key);
            return (
              <div key={col.key} className="rounded-lg border border-border bg-muted p-2">
                <div className="mb-2 flex items-center justify-between px-1">
                  <span className="text-sm font-semibold text-foreground">{col.title}</span>
                  <Badge variant="secondary">{items.length}</Badge>
                </div>
                <div className="space-y-2">
                  {items.length === 0 ? (
                    <p className="px-1 py-4 text-center text-xs text-muted-foreground">비어있음</p>
                  ) : (
                    items.map((t) => (
                      <button
                        key={t.id}
                        onClick={() => void openDetail(t)}
                        className="w-full rounded-md border border-border bg-card p-2.5 text-left transition hover:border-muted-foreground"
                      >
                        <p className="text-sm font-medium leading-snug text-foreground">{t.title}</p>
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          <span className={`rounded border px-1.5 py-0.5 text-[10px] ${PRIORITY_STYLE[t.priority]}`}>
                            {t.priority}
                          </span>
                          <Badge variant="outline" className="text-[10px]">
                            {t.label}
                          </Badge>
                          <AssigneeChip who={t.assignee} />
                          {t.comment_count > 0 && (
                            <span className="ml-auto inline-flex items-center gap-0.5 text-[10px] text-muted-foreground">
                              <MessageSquare className="h-3 w-3" />
                              {t.comment_count}
                            </span>
                          )}
                        </div>
                        {t.due_at && (
                          <p className="mt-1 text-[10px] text-warning">
                            due {new Date(t.due_at).toLocaleDateString("ko-KR")}
                          </p>
                        )}
                      </button>
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 상세 다이얼로그 */}
      <Dialog open={detail !== null} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle className="pr-6 leading-snug">{detail.title}</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={detail.status}
                    onChange={(e) => void patchTask(detail.id, { status: e.target.value as OpsTask["status"] })}
                    className="h-8 rounded-md border border-border bg-background text-foreground px-2 text-xs"
                  >
                    {STATUSES.map((s) => (
                      <option key={s.key} value={s.key}>
                        {s.title}
                      </option>
                    ))}
                  </select>
                  <select
                    value={detail.priority}
                    onChange={(e) => void patchTask(detail.id, { priority: e.target.value as OpsTask["priority"] })}
                    className="h-8 rounded-md border border-border bg-background text-foreground px-2 text-xs"
                  >
                    {PRIORITIES.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                  <Badge variant="outline">{detail.label}</Badge>
                  <AssigneeChip who={detail.assignee} />
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    defaultValue={detail.assignee ?? ""}
                    placeholder="담당 (user:이름 / agent:이름)"
                    className="h-8 text-xs"
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v !== (detail.assignee ?? "")) void patchTask(detail.id, { assignee: v || null });
                    }}
                  />
                </div>
                {detail.body && (
                  <p className="whitespace-pre-wrap rounded-md border border-border bg-muted p-3 text-foreground">
                    {detail.body}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  생성 {detail.created_by} · {new Date(detail.created_at).toLocaleString("ko-KR")} · 출처{" "}
                  {detail.source}
                </p>

                <div className="border-t border-border pt-3">
                  <p className="mb-2 text-xs font-semibold text-muted-foreground">코멘트 {comments.length}</p>
                  <div className="max-h-48 space-y-2 overflow-y-auto">
                    {comments.map((c) => (
                      <div key={c.id} className="rounded-md bg-muted p-2">
                        <div className="mb-0.5 flex items-center justify-between">
                          <AssigneeChip who={c.author} />
                          <span className="text-[10px] text-muted-foreground">
                            {new Date(c.created_at).toLocaleString("ko-KR")}
                          </span>
                        </div>
                        <p className="whitespace-pre-wrap text-xs text-foreground">{c.body}</p>
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 flex gap-2">
                    <Input
                      value={commentDraft}
                      onChange={(e) => setCommentDraft(e.target.value)}
                      placeholder="코멘트 입력"
                      className="h-8 text-xs"
                      onKeyDown={(e) => e.key === "Enter" && void addComment()}
                    />
                    <Button size="sm" onClick={() => void addComment()}>
                      등록
                    </Button>
                  </div>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* 생성 다이얼로그 */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>새 카드</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              value={draft.title}
              onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
              placeholder="제목"
            />
            <Textarea
              value={draft.body}
              onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
              placeholder="내용 (선택)"
              rows={4}
            />
            <div className="flex gap-2">
              <select
                value={draft.label}
                onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
                className="h-9 flex-1 rounded-md border border-border bg-background text-foreground px-2 text-sm"
              >
                {LABELS.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
              <select
                value={draft.priority}
                onChange={(e) => setDraft((d) => ({ ...d, priority: e.target.value }))}
                className="h-9 flex-1 rounded-md border border-border bg-background text-foreground px-2 text-sm"
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setCreateOpen(false)}>
                취소
              </Button>
              <Button onClick={() => void createTask()} disabled={saving}>
                {saving ? "생성 중…" : "생성"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
