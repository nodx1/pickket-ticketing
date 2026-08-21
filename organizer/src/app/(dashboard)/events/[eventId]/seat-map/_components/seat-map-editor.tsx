"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConfirmAction } from "@/lib/hooks/useConfirmAction";
import dynamic from "next/dynamic";
import { FileJson, ImagePlus, Trash2, Upload, Wand2 } from "lucide-react";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { showError, showSuccess } from "@/lib/hooks/useToast";
import type { SeatTier } from "@/lib/seats/types";
import { SeatGrid } from "./seat-grid";
import { BuilderModeTabs, type BuilderMode } from "./builder-mode-tabs";
import { TierManager } from "./tier-manager";
import type { SeatNode, TierLite } from "./visual-builder";
import type { FigmaSection } from "./figma-builder";
import { fetchWithRefresh } from "@/lib/fetchWithAuth";
import { formatDateTimeSecKst } from "@/lib/format";

const VisualBuilder = dynamic(
  () => import("./visual-builder").then((m) => m.VisualBuilder),
  {
    ssr: false,
    loading: () => (
      <div className="p-12 text-center text-content-subtle">시각 빌더 로딩 중...</div>
    ),
  },
);

const FigmaBuilder = dynamic(
  () => import("./figma-builder").then((m) => m.FigmaBuilder),
  {
    ssr: false,
    loading: () => (
      <div className="p-12 text-center text-content-subtle">피그마 빌더 로딩 중...</div>
    ),
  },
);

// 트랙 4/5/2.4 신규 다이얼로그 — admin 분할 (코드 분할)
const SvgImportDialog = dynamic(
  () => import("./svg-import-dialog").then((m) => m.SvgImportDialog),
  { ssr: false },
);
const RowGeneratorWizard = dynamic(
  () => import("./row-generator-wizard").then((m) => m.RowGeneratorWizard),
  { ssr: false },
);

interface SeatMapRow {
  id: string;
  name: string;
  status: "draft" | "published" | "archived";
}

interface SeatRow {
  id: string;
  section: string;
  row: string;
  seatNumber: string;
  status: "available" | "held" | "reserved" | "blocked";
  tierId: string | null;
}

export function SeatMapEditor({ eventId }: { eventId: string }) {
  const [maps, setMaps] = useState<SeatMapRow[]>([]);
  const [activeMapId, setActiveMapId] = useState<string | null>(null);
  const [seats, setSeats] = useState<SeatRow[]>([]);
  const [selectedSeatIds, setSelectedSeatIds] = useState<string[]>([]);
  const [referenceImageUrl, setReferenceImageUrl] = useState<string>("");
  const [mode, setMode] = useState<BuilderMode>("figma");
  const [tiers, setTiers] = useState<SeatTier[]>([]);
  const [visualSeats, setVisualSeats] = useState<SeatNode[]>([]);
  const csvInputRef = useRef<HTMLInputElement>(null);

  // 트랙 4/5/2.4 신규 다이얼로그 토글
  const [svgOpen, setSvgOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [mapToDelete, setMapToDelete] = useState<SeatMapRow | null>(null);
  const [figmaSections, setFigmaSections] = useState<FigmaSection[]>([]);

  const handleTiersChange = useCallback((next: SeatTier[]) => {
    setTiers(next);
  }, []);

  const handleVisualChange = useCallback((next: SeatNode[]) => {
    setVisualSeats(next);
  }, []);

  const tierLites: TierLite[] = useMemo(
    () =>
      tiers.map((t) => ({
        id: t.id,
        name: t.name,
        colorHex: t.colorHex ?? "#9ca3af",
      })),
    [tiers],
  );
  const [form, setForm] = useState({
    name: "메인 좌석도",
    sections: "A,B,C",
    rowsPerSection: "5",
    seatsPerRow: "8",
  });

  // 맵 상세를 로드하여 figmaSections / seats / activeMapId 를 원자적으로 갱신.
  // 순서 중요: figmaSections를 먼저 세팅해야 FigmaBuilder 리마운트 시 initialSections가 비어있지 않음.
  const loadMapDetail = useCallback(
    async (mapId: string): Promise<void> => {
      try {
        const res = await fetchWithRefresh(`/api/events/${eventId}/seat-maps/${mapId}`, {
          credentials: "include",
        });
        if (!res.ok) {
          console.warn("좌석 배치도 상세 로드 실패:", res.status);
          return;
        }
        const payload = (await res.json()) as {
          data?: {
            seats?: SeatRow[];
            mapData?: { mode?: string; figmaLayout?: { sections: unknown[] } } | null;
          };
        };
        const figmaLayout = payload.data?.mapData?.figmaLayout;
        const nextSections: FigmaSection[] = figmaLayout?.sections
          ? figmaLayout.sections.map((s) => {
              const raw = s as {
                name: string;
                x: number;
                y: number;
                rows?: number;
                seatsPerRow?: number;
                rotation?: number;
                tierId?: string | null;
                kind?: "assigned" | "standing" | "stage" | "console";
                blockedPositions?: string[];
                capacity?: number;
                width?: number;
                height?: number;
              };
              return {
                id: crypto.randomUUID(),
                name: raw.name,
                x: raw.x,
                y: raw.y,
                rows: raw.rows ?? 5,
                seatsPerRow: raw.seatsPerRow ?? 8,
                rotation: raw.rotation ?? 0,
                tierId: raw.tierId ?? null,
                kind: raw.kind ?? "assigned",
                blockedPositions: raw.blockedPositions ?? [],
                capacity: raw.capacity,
                width: raw.width,
                height: raw.height,
              };
            })
          : [];
        // 순서 보장: sections → seats → activeMapId (React 18 automatic batching 으로 같은 render에 반영)
        setFigmaSections(nextSections);
        setSeats(payload.data?.seats ?? []);
        setActiveMapId(mapId);
      } catch (err: unknown) {
        console.warn("좌석 배치도 상세 로드 오류:", err instanceof Error ? err.message : err);
      }
    },
    [eventId],
  );

  useEffect(() => {
    let isMounted = true;
    async function init() {
      try {
        const response = await fetchWithRefresh(`/api/events/${eventId}/seat-maps`, {
          credentials: "include",
        });
        if (!response.ok) {
          console.warn("좌석 배치도 목록 로드 실패:", response.status);
          return;
        }
        const payload = (await response.json()) as { data?: SeatMapRow[] };
        if (!isMounted) return;
        const nextMaps = payload.data ?? [];
        setMaps(nextMaps);
        // 이미 활성화된 맵이 없으면 가장 최근 저장된 맵(ASC 정렬의 마지막)을 로드
        const targetId = nextMaps.at(-1)?.id ?? null;
        if (!activeMapId && targetId) {
          await loadMapDetail(targetId);
        }
      } catch (err: unknown) {
        console.warn("좌석 배치도 목록 로드 오류:", err instanceof Error ? err.message : err);
      }
    }
    void init();
    return () => {
      isMounted = false;
    };
    // activeMapId는 의도적으로 제외 — 초기 마운트와 eventId 변경 시에만 자동 로드
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, loadMapDetail]);

  // 기존 좌석을 시각 빌더용 SeatNode[]로 변환 (빌더 진입 시 기존 좌석 표시)
  useEffect(() => {
    if (seats.length > 0 && visualSeats.length === 0) {
      const converted: SeatNode[] = seats.map((s, idx) => ({
        id: s.id,
        x: (idx % 10) * 32 + 100,
        y: Math.floor(idx / 10) * 36 + 100,
        label: `${s.row}${s.seatNumber}`,
        tierId: null,
        isObstructed: false,
      }));
      setVisualSeats(converted);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seats]);

  const summary = useMemo(() => ({
    available: seats.filter((seat) => seat.status === "available").length,
    blocked: seats.filter((seat) => seat.status === "blocked").length,
    reserved: seats.filter((seat) => seat.status === "reserved").length,
  }), [seats]);

  function toggleSeat(seatId: string) {
    setSelectedSeatIds((current) =>
      current.includes(seatId) ? current.filter((id) => id !== seatId) : [...current, seatId],
    );
  }

  async function createMap() {
    const response = await fetchWithRefresh(`/api/events/${eventId}/seat-maps`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: form.name,
        sections: form.sections.split(",").map((item) => item.trim()).filter(Boolean),
        rowsPerSection: Number(form.rowsPerSection),
        seatsPerRow: Number(form.seatsPerRow),
      }),
    });
    if (response.ok) {
      const mapsResponse = await fetchWithRefresh(`/api/events/${eventId}/seat-maps`, { credentials: "include" });
      const payload = (await mapsResponse.json()) as { data?: SeatMapRow[] };
      const nextMaps = payload.data ?? [];
      setMaps(nextMaps);
      setActiveMapId(nextMaps.at(-1)?.id ?? null);
    }
  }

  async function patchSeats(body: {
    status?: "available" | "blocked";
    tierId?: string | null;
  }) {
    if (!activeMapId || selectedSeatIds.length === 0) {
      return;
    }
    const response = await fetchWithRefresh(`/api/events/${eventId}/seat-maps/${activeMapId}/seats`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seatIds: selectedSeatIds, ...body }),
    });
    if (response.ok) {
      const detailResponse = await fetchWithRefresh(`/api/events/${eventId}/seat-maps/${activeMapId}`, { credentials: "include" });
      const payload = (await detailResponse.json()) as { data?: { seats?: SeatRow[] } };
      setSeats(payload.data?.seats ?? []);
      setSelectedSeatIds([]);
    } else {
      const body = await response.json().catch(() => ({}));
      showError((body as { error?: string }).error ?? "좌석 업데이트에 실패했습니다");
    }
  }

  async function updateSelected(status: "available" | "blocked") {
    await patchSeats({ status });
  }

  async function assignTier(tierId: string | null) {
    await patchSeats({ tierId });
    showSuccess(tierId ? "선택한 좌석에 등급을 지정했습니다" : "선택한 좌석의 등급을 해제했습니다");
  }

  async function deleteMap(mapId: string) {
    const response = await fetchWithRefresh(`/api/events/${eventId}/seat-maps/${mapId}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      showError((body as { error?: string }).error ?? "배치도 삭제에 실패했습니다");
      return;
    }
    showSuccess("배치도가 삭제되었습니다");
    const nextMaps = maps.filter((m) => m.id !== mapId);
    setMaps(nextMaps);
    if (activeMapId === mapId) {
      setSelectedSeatIds([]);
      const nextId = nextMaps.at(-1)?.id ?? null;
      if (nextId) {
        await loadMapDetail(nextId);
      } else {
        setFigmaSections([]);
        setSeats([]);
        setActiveMapId(null);
      }
    }
  }

  async function saveFigmaSections(sections: FigmaSection[]) {
    try {
      const figmaLayout = {
        sections: sections.map((s) => ({
          name: s.name,
          x: s.x,
          y: s.y,
          rotation: s.rotation,
          tierId: s.tierId,
          kind: s.kind,
          rows: s.rows,
          seatsPerRow: s.seatsPerRow,
          blockedPositions: s.blockedPositions ?? [],
          capacity: s.capacity,
          width: s.width,
          height: s.height,
        })),
      };

      // activeMapId가 있으면 in-place 업데이트 (PATCH). 없으면 새로 생성 (POST).
      const isUpdate = Boolean(activeMapId);
      const url = isUpdate
        ? `/api/events/${eventId}/seat-maps/${activeMapId}`
        : `/api/events/${eventId}/seat-maps`;
      const response = await fetchWithRefresh(url, {
        method: isUpdate ? "PATCH" : "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `피그마 배치도 ${formatDateTimeSecKst(new Date())}`,
          figmaLayout,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        showError((body as { error?: string }).error ?? "저장에 실패했습니다");
        return;
      }

      showSuccess("배치도가 저장 & 발행되었습니다. 구매 페이지에 노출됩니다");

      if (!isUpdate) {
        const payload = (await response.json()) as { data?: { id: string } };
        if (payload.data?.id) {
          // 섹션 상태를 먼저 반영해서 리마운트 시 빈 캔버스로 초기화되지 않게 함
          setFigmaSections(sections);
          setActiveMapId(payload.data.id);
        }
      }

      // 배치도 목록 새로고침
      const mapsRes = await fetchWithRefresh(`/api/events/${eventId}/seat-maps`, { credentials: "include" });
      const mapsPayload = (await mapsRes.json()) as { data?: SeatMapRow[] };
      setMaps(mapsPayload.data ?? []);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "저장 중 오류가 발생했습니다");
    }
  }

  async function toggleMapStatus(mapId: string, nextStatus: "draft" | "published") {
    const response = await fetchWithRefresh(`/api/events/${eventId}/seat-maps/${mapId}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: nextStatus }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      showError((body as { error?: string }).error ?? "상태 변경에 실패했습니다");
      return;
    }
    showSuccess(nextStatus === "published" ? "배치도를 발행했습니다" : "배치도를 초안으로 전환했습니다");
    setMaps((prev) => prev.map((m) => (m.id === mapId ? { ...m, status: nextStatus } : m)));
  }

  // 확인 버튼 잠금 + 재진입 차단 + 실패 시 해제 (S3).
  // 종전엔 `void fn(); setTarget(null)` 라 **요청이 끝나기 전에 창이 닫혔다** —
  // 그 상태로 pending 을 넘겨봐야 보이지도 않는다. 끝난 뒤 닫도록 바꿨다.
  const deleteMapAction = useConfirmAction(async () => {
    if (!mapToDelete) return;
    await deleteMap(mapToDelete.id);
    setMapToDelete(null);
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-6 lg:flex-row">
        <div className="space-y-4 lg:w-72">
          <TierManager eventId={eventId} onTiersChange={handleTiersChange} />

          {/* 저장된 배치도 목록 (피그마 모드에서도 표시) */}
          {mode === "figma" && (
            <Card className="border-border bg-card/95">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-bold text-foreground">
                  좌석배치도 목록
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {maps.length === 0 ? (
                  <p className="text-xs text-content-subtle">
                    저장된 배치도가 없습니다. 섹션을 배치하고 저장 & 발행을 눌러주세요.
                  </p>
                ) : (
                  maps.map((map) => (
                    <div
                      key={map.id}
                      className={`group relative rounded-lg border p-2.5 text-xs transition ${
                        activeMapId === map.id
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-border bg-muted/30 text-content-subtle hover:bg-muted"
                      }`}
                    >
                      <div className="flex items-start gap-1.5">
                        <button
                          type="button"
                          className="flex-1 text-left"
                          onClick={() => void loadMapDetail(map.id)}
                        >
                          <p className="font-semibold">{map.name}</p>
                          <p className="mt-0.5 text-[10px] uppercase tracking-[0.12em]">
                            {map.status === "published"
                              ? "✅ 발행됨"
                              : map.status === "archived"
                                ? "📦 보관"
                                : "📝 초안"}
                          </p>
                        </button>
                        <button
                          type="button"
                          aria-label={`${map.name} 삭제`}
                          className="rounded p-1 text-content-subtle opacity-0 transition hover:bg-error/10 hover:text-error group-hover:opacity-100"
                          onClick={(e) => {
                            e.stopPropagation();
                            setMapToDelete(map);
                          }}
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          )}
        </div>

        <div className="flex-1 space-y-6">
          {mode !== "figma" && <BuilderModeTabs mode={mode} onChange={setMode} />}

          {mode === "figma" ? (
            <div>
              <h3 className="mb-1 text-lg font-bold text-foreground">배치도 에디터</h3>
              <p className="mb-4 text-xs text-content-subtle">
                섹션을 추가하고 드래그/회전해서 실제 공연장 모양대로 배치하세요.
              </p>
              <FigmaBuilder
                key={activeMapId ?? "new"}
                tiers={tierLites}
                initialSections={figmaSections}
                onSave={saveFigmaSections}
              />
            </div>
          ) : mode === "visual" ? (
            <Card className="border-border bg-card/95">
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-foreground">시각 빌더</CardTitle>
                <div className="flex flex-wrap gap-2">
                  {/* 트랙 5.1 — SVG 임포트 트리거 */}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setSvgOpen(true)}
                  >
                    <FileJson className="mr-1 size-4" aria-hidden />
                    SVG 가져오기
                  </Button>
                  {/* 트랙 2.4 — 행/열 wizard 트리거 */}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setWizardOpen(true)}
                  >
                    <Wand2 className="mr-1 size-4" aria-hidden />
                    행/열 wizard
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <VisualBuilder
                  initialSeats={visualSeats}
                  tiers={tierLites}
                  onChange={handleVisualChange}
                  onRequestWizard={() => setWizardOpen(true)}
                />
              </CardContent>
            </Card>
          ) : (
            <>
      <Card className="border-border bg-card/95">
        <CardHeader>
          <CardTitle className="text-foreground">배치도 생성</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-4">
          <div className="space-y-2">
            <Label>이름</Label>
            <Input value={form.name} onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))} />
          </div>
          <div className="space-y-2">
            <Label>섹션</Label>
            <Input value={form.sections} onChange={(event) => setForm((prev) => ({ ...prev, sections: event.target.value }))} />
          </div>
          <div className="space-y-2">
            <Label>섹션당 행</Label>
            <Input value={form.rowsPerSection} onChange={(event) => setForm((prev) => ({ ...prev, rowsPerSection: event.target.value }))} />
          </div>
          <div className="space-y-2">
            <Label>행당 좌석</Label>
            <Input value={form.seatsPerRow} onChange={(event) => setForm((prev) => ({ ...prev, seatsPerRow: event.target.value }))} />
          </div>
          <div className="lg:col-span-4">
            <Button onClick={() => void createMap()}>새 좌석도 만들기</Button>
          </div>
        </CardContent>
      </Card>

      {/* 참고 이미지 + CSV 임포트 */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="border-border bg-card/95">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-foreground">
              <ImagePlus className="size-4" />
              참고 이미지
            </CardTitle>
          </CardHeader>
          <CardContent>
            {referenceImageUrl ? (
              <div className="space-y-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={referenceImageUrl} alt="좌석 배치도 참고" className="w-full rounded-lg border border-border" />
                <Button variant="outline" size="sm" onClick={() => setReferenceImageUrl("")}>이미지 제거</Button>
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-border bg-muted/30 p-6 text-center">
                <ImagePlus className="mx-auto size-8 text-content-subtle" />
                <p className="mt-2 text-sm text-content-subtle">좌석 배치도 참고 이미지를 업로드하세요</p>
                <p className="text-xs text-content-subtle">jpg, png, webp / 최대 10MB</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={async () => {
                    const input = document.createElement("input");
                    input.type = "file";
                    input.accept = "image/jpeg,image/png,image/webp";
                    input.onchange = async () => {
                      const file = input.files?.[0];
                      if (!file) return;
                      try {
                        const presignRes = await fetchWithRefresh("/api/upload", {
                          method: "POST",
                          credentials: "include",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ uploadType: "general", filename: file.name, contentType: file.type }),
                        });
                        const presign = (await presignRes.json()) as { data?: { uploadUrl: string; publicUrl: string; headers: Record<string, string> } };
                        if (!presign.data) throw new Error("URL 생성 실패");
                        if (presign.data.uploadUrl.startsWith("/")) {
                          const fd = new FormData();
                          fd.append("file", file);
                          const localRes = await fetchWithRefresh(presign.data.uploadUrl, { method: "PUT", credentials: "include", body: fd });
                          const localPayload = (await localRes.json()) as { data?: { url: string } };
                          setReferenceImageUrl(localPayload.data?.url ?? "");
                        } else {
                          // 🔴 fetchWithRefresh 를 쓰지 않는다 — 이 분기의 uploadUrl 은
                          //    **외부 S3/MinIO 서명 URL** 이다(lib/storage/s3.ts:130).
                          //    위 `startsWith("/")` 분기가 로컬 provider(s3.ts:196 의 "/api/upload").
                          //    credentials 가 없는 것도 의도다 — 스토리지에 쿠키를 보내지 않는다.
                          await fetch(presign.data.uploadUrl, { method: "PUT", headers: presign.data.headers, body: file });
                          setReferenceImageUrl(presign.data.publicUrl);
                        }
                        showSuccess("이미지가 업로드되었습니다");
                      } catch {
                        showError("이미지 업로드에 실패했습니다");
                      }
                    };
                    input.click();
                  }}
                >
                  파일 선택
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-border bg-card/95">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-foreground">
              <Upload className="size-4" />
              CSV로 좌석 가져오기
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="rounded-lg border border-dashed border-border bg-muted/30 p-6 text-center">
              <Upload className="mx-auto size-8 text-content-subtle" />
              <p className="mt-2 text-sm text-content-subtle">CSV 파일로 좌석을 일괄 등록할 수 있습니다</p>
              <p className="mt-1 text-xs text-content-subtle">
                필수 컬럼: section, row, seat_number<br />
                선택 컬럼: status (available/blocked)
              </p>
              <input
                ref={csvInputRef}
                type="file"
                accept=".csv"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file || !activeMapId) {
                    if (!activeMapId) showError("먼저 좌석 배치도를 생성해주세요");
                    return;
                  }
                  try {
                    const text = await file.text();
                    const lines = text.trim().split("\n");
                    const header = lines[0].toLowerCase().split(",").map((h) => h.trim());
                    const secIdx = header.indexOf("section");
                    const rowIdx = header.indexOf("row");
                    const seatIdx = header.indexOf("seat_number");
                    if (secIdx === -1 || rowIdx === -1 || seatIdx === -1) {
                      showError("CSV에 section, row, seat_number 컬럼이 필요합니다");
                      return;
                    }
                    const seats = lines.slice(1).filter((l) => l.trim()).map((line) => {
                      const cols = line.split(",").map((c) => c.trim());
                      return { section: cols[secIdx], row: cols[rowIdx], seatNumber: cols[seatIdx] };
                    });
                    const res = await fetchWithRefresh(`/api/events/${eventId}/seat-maps/${activeMapId}/import`, {
                      method: "POST",
                      credentials: "include",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ seats }),
                    });
                    if (res.ok) {
                      const payload = (await res.json()) as { data?: { imported: number } };
                      showSuccess(`${payload.data?.imported ?? 0}개 좌석이 가져와졌습니다`);
                      const detailRes = await fetchWithRefresh(`/api/events/${eventId}/seat-maps/${activeMapId}`, { credentials: "include" });
                      const detail = (await detailRes.json()) as { data?: { seats?: SeatRow[] } };
                      setSeats(detail.data?.seats ?? []);
                    } else {
                      const err = (await res.json()) as { error?: string };
                      showError(err.error ?? "CSV 가져오기에 실패했습니다");
                    }
                  } catch {
                    showError("CSV 파일을 읽을 수 없습니다");
                  }
                  if (csvInputRef.current) csvInputRef.current.value = "";
                }}
              />
              <Button variant="outline" size="sm" className="mt-3" onClick={() => csvInputRef.current?.click()}>
                CSV 파일 선택
              </Button>
            </div>
            <div className="mt-3">
              <p className="text-xs font-medium text-content-subtle">CSV 예시:</p>
              <pre className="mt-1 overflow-x-auto rounded bg-muted p-2 text-[11px] text-content-subtle">
{`section,row,seat_number
A,1,1
A,1,2
A,2,1
B,1,1`}
              </pre>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-[280px_minmax(0,1fr)_220px]">
        <Card className="border-border bg-card/95">
          <CardHeader>
            <CardTitle className="text-foreground">배치도 목록</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {maps.length === 0 ? (
              <p className="text-sm text-content-subtle">아직 등록된 배치도가 없습니다.</p>
            ) : maps.map((map) => (
              <div
                key={map.id}
                className={`group relative rounded-lg border p-3 text-sm ${activeMapId === map.id ? "border-primary bg-primary/10 text-foreground" : "border-border bg-muted text-content-subtle"}`}
              >
                <div className="flex items-start gap-2">
                  <button
                    type="button"
                    className="flex-1 text-left"
                    onClick={() => setActiveMapId(map.id)}
                  >
                    <p className="font-semibold">{map.name}</p>
                    <p className="mt-1 text-xs tracking-[0.16em]">
                      {map.status === "published" ? "게시됨" : map.status === "archived" ? "보관됨" : "초안"}
                    </p>
                  </button>
                  <button
                    type="button"
                    aria-label={`${map.name} 삭제`}
                    className="rounded-md p-1.5 text-content-subtle opacity-0 transition hover:bg-error/10 hover:text-error group-hover:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMapToDelete(map);
                    }}
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
                <div className="mt-2">
                  {map.status === "draft" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full"
                      onClick={(e) => {
                        e.stopPropagation();
                        void toggleMapStatus(map.id, "published");
                      }}
                    >
                      📢 발행하기
                    </Button>
                  ) : map.status === "published" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full"
                      onClick={(e) => {
                        e.stopPropagation();
                        void toggleMapStatus(map.id, "draft");
                      }}
                    >
                      초안으로 되돌리기
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="border-border bg-card/95">
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
            <div className="flex items-center gap-3">
              <CardTitle className="text-foreground">좌석 그리드</CardTitle>
              {selectedSeatIds.length > 0 && (
                <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
                  {selectedSeatIds.length}석 선택됨
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={selectedSeatIds.length === 0}
                onClick={() => void updateSelected("available")}
              >
                선택 해제
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={selectedSeatIds.length === 0}
                onClick={() => void updateSelected("blocked")}
              >
                좌석 차단
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" disabled={selectedSeatIds.length === 0 || tiers.length === 0}>
                    등급 지정 ▼
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel>선택한 좌석에 등급 지정</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {tiers.length === 0 ? (
                    <DropdownMenuItem disabled>등급을 먼저 추가해주세요</DropdownMenuItem>
                  ) : (
                    tiers.map((t) => (
                      <DropdownMenuItem key={t.id} onClick={() => void assignTier(t.id)}>
                        <span
                          className="mr-2 inline-block size-3 rounded-full border border-border"
                          style={{ backgroundColor: t.colorHex ?? "#9ca3af" }}
                        />
                        <span className="flex-1">{t.name}</span>
                        <span className="text-xs text-content-subtle">
                          {Number(t.basePrice ?? 0).toLocaleString()}원
                        </span>
                      </DropdownMenuItem>
                    ))
                  )}
                  {tiers.length > 0 && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => void assignTier(null)}>등급 해제</DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </CardHeader>
          <CardContent>
            {activeMapId ? (
              <SeatGrid seats={seats} selectedSeatIds={selectedSeatIds} tiers={tierLites} onToggle={toggleSeat} />
            ) : (
              <p className="text-sm text-content-subtle">먼저 좌석 배치도를 생성해 주세요.</p>
            )}
          </CardContent>
        </Card>

        <Card className="border-border bg-card/95">
          <CardHeader>
            <CardTitle className="text-foreground">범례</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-content-subtle">
            <p>사용 가능: {summary.available}</p>
            <p>차단 좌석: {summary.blocked}</p>
            <p>예약 완료: {summary.reserved}</p>
            <p>선택한 좌석 수: {selectedSeatIds.length}</p>
          </CardContent>
        </Card>
      </div>
            </>
          )}
        </div>
      </div>

      {/* 트랙 5.1 / 2.4 — 다이얼로그 마운트 (활성 좌석맵 있을 때만) */}
      {activeMapId ? (
        <>
          <SvgImportDialog
            open={svgOpen}
            onOpenChange={setSvgOpen}
            defaultTierId={tierLites[0]?.id ?? null}
            onImported={(seats) => {
              setVisualSeats((prev) => [...prev, ...seats]);
              setSvgOpen(false);
            }}
          />
          <RowGeneratorWizard
            open={wizardOpen}
            onOpenChange={setWizardOpen}
            defaultTierId={tierLites[0]?.id ?? null}
            onGenerate={(seats) => {
              setVisualSeats((prev) => [...prev, ...seats]);
              setWizardOpen(false);
            }}
          />
        </>
      ) : null}

      <ConfirmDialog
        open={mapToDelete !== null}
        onOpenChange={(open) => !open && setMapToDelete(null)}
        title="배치도를 삭제할까요?"
        description={`"${mapToDelete?.name ?? ""}" 배치도와 연결된 모든 좌석이 삭제됩니다. 이 작업은 되돌릴 수 없습니다.`}
        confirmText="삭제"
        cancelText="취소"
        pending={deleteMapAction.pending}
        onConfirm={deleteMapAction.run}
      />
    </div>
  );
}
