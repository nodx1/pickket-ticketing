"use client";

/**
 * 「장소 찾기」 — 지도 API 연동(과업지시서 2-1).
 *
 * 장소 이름이나 주소로 검색 → 결과를 고르면 지도에서 위치를 확인 → 「이 장소로 정하기」.
 * 검색은 우리 서버(/api/maps/search)를 거쳐 오픈스트리트맵에 묻는다. 이용 정책상 입력할 때마다
 * 부르지 않고 「검색」 버튼이나 Enter 로만 부른다.
 */
import { useEffect, useState } from "react";
import { Loader2, MapPin, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { fetchWithRefresh } from "@/lib/fetchWithAuth";
import type { MapPlace, MapSearchResult } from "@/lib/map/osm";
import { VenueMapPreview } from "./venue-map-preview";

interface VenueSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialQuery: string;
  onPick: (place: MapPlace) => void;
}

type SearchState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "done"; places: MapPlace[]; attribution: string };

export function VenueSearchDialog({ open, onOpenChange, initialQuery, onPick }: VenueSearchDialogProps) {
  const [query, setQuery] = useState(initialQuery);
  const [state, setState] = useState<SearchState>({ kind: "idle" });
  const [selected, setSelected] = useState<MapPlace | null>(null);

  // 열 때마다 지금 입력된 장소명·주소로 검색창을 채운다.
  useEffect(() => {
    if (open) {
      setQuery(initialQuery);
      setState({ kind: "idle" });
      setSelected(null);
    }
  }, [open, initialQuery]);

  async function runSearch() {
    const q = query.replace(/\s+/g, " ").trim();
    if (q.length < 2) {
      setState({ kind: "error", message: "장소 이름이나 주소를 두 글자 이상 입력해 주세요." });
      return;
    }
    setState({ kind: "loading" });
    setSelected(null);
    try {
      const res = await fetchWithRefresh(`/api/maps/search?q=${encodeURIComponent(q)}`, { credentials: "include" });
      const body = (await res.json().catch(() => ({}))) as { data?: MapSearchResult; error?: string };
      if (!res.ok || !body.data) {
        setState({ kind: "error", message: body.error ?? "장소를 검색하지 못했어요. 잠시 후 다시 시도해 주세요." });
        return;
      }
      setState({ kind: "done", places: body.data.places, attribution: body.data.attribution });
      if (body.data.places.length > 0) setSelected(body.data.places[0]);
    } catch {
      setState({ kind: "error", message: "장소를 검색하지 못했어요. 인터넷 연결을 확인해 주세요." });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] w-[min(94vw,44rem)] flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>장소 찾기</DialogTitle>
          <DialogDescription>공연장 이름이나 주소로 검색하고, 지도에서 위치를 확인한 뒤 고르세요.</DialogDescription>
        </DialogHeader>

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            // 🔴 다이얼로그는 포털로 떠 있지만 React 트리상 이벤트 폼 안이라 submit 이 바깥 폼까지 올라간다
            //    (검색 Enter 가 이벤트 저장으로 이어졌다). 여기서 끊는다.
            e.preventDefault();
            e.stopPropagation();
            void runSearch();
          }}
        >
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="예: 블루스퀘어, 킨텍스, 서울특별시 송파구 올림픽로 424"
            aria-label="장소 검색어"
            maxLength={100}
          />
          <Button type="submit" disabled={state.kind === "loading"} className="shrink-0">
            {state.kind === "loading" ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
            검색
          </Button>
        </form>

        <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
          {state.kind === "error" ? (
            <p className="rounded-lg bg-error/10 px-3 py-2 text-sm text-error">{state.message}</p>
          ) : null}

          {state.kind === "done" && state.places.length === 0 ? (
            <p className="rounded-lg bg-muted/40 px-3 py-3 text-sm text-content-subtle">
              검색 결과가 없어요. 이름 대신 도로명 주소로 검색해 보세요 (예: 서울특별시 송파구 올림픽로 424).
            </p>
          ) : null}

          {state.kind === "done" && state.places.length > 0 ? (
            <div className="space-y-3">
              <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border" role="listbox" aria-label="검색 결과">
                {state.places.map((p) => {
                  const active = selected?.source_id === p.source_id;
                  return (
                    <li key={p.source_id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={active}
                        onClick={() => setSelected(p)}
                        className={`flex w-full items-start gap-2 px-3 py-2.5 text-left transition ${
                          active ? "bg-primary/10" : "hover:bg-muted/40"
                        }`}
                      >
                        <MapPin className={`mt-0.5 size-4 shrink-0 ${active ? "text-primary" : "text-content-subtle"}`} />
                        <span className="min-w-0">
                          <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                            {p.name}
                            {p.kind ? (
                              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-content-subtle">{p.kind}</span>
                            ) : null}
                          </span>
                          <span className="block truncate text-xs text-content-subtle">{p.address || "주소 정보 없음"}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {selected ? <VenueMapPreview lat={selected.lat} lng={selected.lng} title={selected.name} className="h-56" /> : null}
            </div>
          ) : null}
        </div>

        <DialogFooter className="mt-4 flex-wrap justify-between gap-2">
          <span className="text-[11px] text-content-subtle">지도 데이터 © OpenStreetMap contributors</span>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              취소
            </Button>
            <Button
              type="button"
              disabled={!selected}
              onClick={() => {
                if (!selected) return;
                onPick(selected);
                onOpenChange(false);
              }}
            >
              이 장소로 정하기
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
