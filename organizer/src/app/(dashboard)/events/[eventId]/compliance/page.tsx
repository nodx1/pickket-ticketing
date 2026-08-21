"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";

import { Pagination } from "@/components/shared/pagination";
import { fetchWithAuth } from "@/lib/fetchWithAuth";
import { AUDIT_ACTION_LABELS } from "@/lib/constants";
import { formatDateTimeSecKst } from "@/lib/format";

interface AuditLog { id: string; action: string; tableName: string; recordId: string; changes: unknown; ipAddress: string; createdAt: string; userName: string; userEmail: string; }
interface AuditStats { totalLogs: number; uniqueUsers: number; tablesAffected: number; deleteActions: number; }

const PAGE_SIZE = 30;

export default function CompliancePage() {
  const { eventId } = useParams<{ eventId: string }>();
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [stats, setStats] = useState<AuditStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);

  const fetch_ = useCallback(async (p: number) => {
    try {
      const offset = (p - 1) * PAGE_SIZE;
      const res = await fetchWithAuth<{ success: boolean; data: { logs: AuditLog[]; stats: AuditStats } }>(`/api/events/${eventId}/compliance?limit=${PAGE_SIZE}&offset=${offset}`);
      if (res.success) { setLogs(res.data.logs); setStats(res.data.stats); }
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [eventId]);

  useEffect(() => { fetch_(page); }, [fetch_, page]);

  if (loading) return <div className="animate-pulse rounded-lg border border-border bg-card p-8"><div className="h-6 w-48 rounded bg-bg-muted" /></div>;

  const s = stats ?? { totalLogs: 0, uniqueUsers: 0, tablesAffected: 0, deleteActions: 0 };

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-content-subtle">컴플라이언스</p>
        <h2 className="mt-2 text-3xl font-black tracking-[-0.04em] text-foreground">감사 추적</h2>
      </div>
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: "전체 로그", value: s.totalLogs },
          { label: "활동 사용자", value: s.uniqueUsers },
          { label: "영향 테이블", value: s.tablesAffected },
          { label: "삭제 작업", value: s.deleteActions, color: "text-error" },
        ].map((st) => (
          <div key={st.label} className="rounded-lg border border-border bg-card p-4">
            <p className="text-xs text-content-muted">{st.label}</p>
            <p className={`mt-1 text-2xl font-bold ${st.color ?? "text-foreground"}`}>{st.value}</p>
          </div>
        ))}
      </div>
      <div className="rounded-lg border border-border bg-card">
        <table className="w-full">
          <thead><tr className="border-b border-border text-left text-xs text-content-muted">
            <th className="px-4 py-3">시간</th><th className="px-4 py-3">사용자</th>
            <th className="px-4 py-3">작업</th><th className="px-4 py-3">테이블</th><th className="px-4 py-3">IP</th>
          </tr></thead>
          <tbody>
            {logs.map((l) => (
              <tr key={l.id} className="border-b border-border last:border-0">
                <td className="px-4 py-3 text-xs text-content-muted">{formatDateTimeSecKst(l.createdAt)}</td>
                <td className="px-4 py-3 text-sm">{l.userName ?? l.userEmail ?? "-"}</td>
                <td className="px-4 py-3"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${l.action === "delete" ? "bg-error/10 text-error" : l.action === "create" ? "bg-success/10 text-success" : "bg-bg-muted text-content-subtle"}`}>{AUDIT_ACTION_LABELS[l.action] ?? l.action}</span></td>
                <td className="px-4 py-3 text-sm text-content-subtle">{l.tableName}</td>
                <td className="px-4 py-3 text-xs text-content-muted">{l.ipAddress}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {s.totalLogs > PAGE_SIZE ? (
        <Pagination
          page={page}
          totalPages={Math.ceil(s.totalLogs / PAGE_SIZE)}
          onPageChange={(p) => { setPage(p); setLoading(true); }}
        />
      ) : null}
    </div>
  );
}
