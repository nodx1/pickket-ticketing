"use client";

/**
 * 🔴 현장 임시티켓 발급용 조회 (2026-08-19 현장업체 요청).
 *
 * ## 왜 관리자 화면인가
 *
 * 업체는 "이름·전화로 조회하는 현장 API"를 요청하려다 스스로 접었다 —
 * 현장 API 는 **조회와 사용처리가 한 번에** 일어나서, 잘못 검색하면 **남의 표가
 * 사용처리**된다. 그 판단이 옳다.
 *
 * ⟹ 여기서는 **검색과 사용처리를 분리**한다. 검색은 아무것도 바꾸지 않고,
 *    스태프가 「입장 처리」를 눌러야 비로소 체크인된다.
 *
 * ⚠️ 복사값은 **하이픈 없는 번호**다 — 업체 시스템 파싱 기준과 같게 맞춘다.
 */

import { useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface RosterRow {
  ticketNumber: string;
  name: string | null;
  phone: string | null;
  productName: string | null;
  raffleNumber: number | null;
  status: string;
}

/** 검색 대상 정규화 — 이름·전화·티켓번호 어느 것으로도 찾는다. */
export function matchRoster(rows: readonly RosterRow[], query: string): RosterRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const digits = q.replace(/\D/g, "");
  return rows.filter((r) => {
    if ((r.name ?? "").toLowerCase().includes(q)) return true;
    if ((r.ticketNumber ?? "").toLowerCase().includes(q)) return true;
    // 🔴 전화는 하이픈을 무시하고 비교한다 — 스태프가 010-1234 로 쳐도 찾아야 한다.
    if (digits.length >= 4 && (r.phone ?? "").replace(/\D/g, "").includes(digits)) return true;
    return false;
  });
}

/** 임시티켓에 붙여넣을 한 덩어리. 순서는 업체 요청(이름·연락처·권종·경품번호). */
export function buildCopyText(r: RosterRow): string {
  return [
    r.name ?? "",
    (r.phone ?? "").replace(/\D/g, ""),
    r.productName ?? "",
    r.raffleNumber != null ? String(r.raffleNumber) : "",
  ].join("\t");
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  if (!value) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={`${label} 복사`}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(
          () => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          },
          () => setDone(false),
        );
      }}
    >
      {done ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
    </Button>
  );
}

export function RosterLookupPanel({
  rows,
  onCheckIn,
}: {
  rows: readonly RosterRow[];
  onCheckIn: (ticketNumber: string) => void;
}) {
  const [query, setQuery] = useState("");
  const results = useMemo(() => matchRoster(rows, query).slice(0, 20), [rows, query]);

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="roster-lookup">이름 · 연락처 · 티켓번호로 찾기</Label>
        <Input
          id="roster-lookup"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="예: 홍길동 · 010-1234-5678 · TKT-…"
        />
        <p className="text-xs text-content-muted">
          🔴 검색만으로는 입장 처리되지 않습니다. 확인 후 「입장 처리」를 눌러주세요.
        </p>
      </div>

      {query.trim() && results.length === 0 ? (
        <p className="text-sm text-content-muted">검색 결과가 없습니다.</p>
      ) : null}

      <ul className="space-y-2">
        {results.map((r) => (
          <li key={r.ticketNumber} className="rounded-lg border border-border bg-card p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{r.name ?? "(이름 없음)"}</span>
              <CopyButton value={r.name ?? ""} label="이름" />
              {r.status === "checked_in" ? (
                <Badge variant="success">입장 완료</Badge>
              ) : null}
            </div>
            <dl className="mt-1 space-y-0.5 text-sm text-content-subtle">
              <div className="flex items-center gap-1">
                <dt className="text-content-muted">연락처</dt>
                <dd className="tabular-nums">{(r.phone ?? "").replace(/\D/g, "") || "-"}</dd>
                <CopyButton value={(r.phone ?? "").replace(/\D/g, "")} label="연락처" />
              </div>
              <div className="flex items-center gap-1">
                <dt className="text-content-muted">권종</dt>
                <dd>{r.productName ?? "-"}</dd>
                <CopyButton value={r.productName ?? ""} label="권종" />
              </div>
              <div className="flex items-center gap-1">
                <dt className="text-content-muted">경품번호</dt>
                <dd className="tabular-nums">{r.raffleNumber ?? "-"}</dd>
                <CopyButton value={r.raffleNumber != null ? String(r.raffleNumber) : ""} label="경품번호" />
              </div>
            </dl>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm"
                onClick={() => void navigator.clipboard.writeText(buildCopyText(r))}>
                전체 복사
              </Button>
              <Button type="button" size="sm" onClick={() => onCheckIn(r.ticketNumber)}>
                입장 처리
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
