"use client";

/**
 * FigmaBuilder — 피그마처럼 섹션 블록을 드래그로 배치하는 빌더.
 *
 * 핵심 개념:
 * - 섹션은 "블록 객체" (행 × 좌석 크기를 가진 사각형)
 * - 드래그로 위치 이동
 * - 회전 핸들로 각도 조절
 * - 저장 시 섹션 안의 좌석들이 자동으로 x/y/회전 좌표를 가진 seats 로 변환됨
 *
 * 제한사항 (MVP):
 * - 리사이즈 없음 (행/좌석 수는 인라인 폼에서만 변경)
 * - 그룹/정렬/복제 같은 고급 기능은 Phase 2
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Group, Layer, Line, Rect, Stage, Text, Transformer } from "react-konva";
import type Konva from "konva";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { showError } from "@/lib/hooks/useToast";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Trash2, RotateCw, ChevronDown, Grid3x3 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type SectionKind = "assigned" | "standing" | "stage" | "console";

export interface FigmaSection {
  id: string;
  name: string;
  x: number; // 섹션 중심 x
  y: number; // 섹션 중심 y
  rotation: number; // degrees
  tierId: string | null;
  /** assigned = 지정석 / standing = 스탠딩(자유석) */
  kind: SectionKind;
  /** 지정석 전용 */
  rows: number;
  seatsPerRow: number;
  /** 지정석에서 차단된 좌석 좌표 배열. "rowIdx-seatIdx" 형식 */
  blockedPositions?: string[];
  /** 스탠딩 전용 — 수용 인원 */
  capacity?: number;
  /** stage/standing 커스텀 크기. assigned는 rows×seatsPerRow로 계산됨 */
  width?: number;
  height?: number;
}

export interface FigmaTierLite {
  id: string;
  name: string;
  colorHex: string | null;
}

const SEAT_SIZE = 16;
const SEAT_GAP = 4;
const PADDING = 20;
const STAGE_W_INITIAL = 1000;
const STAGE_H = 700;
const SNAP_THRESHOLD = 6; // px — 이 거리 이내에서 걸림

interface SnapGuide {
  orientation: "vertical" | "horizontal";
  position: number; // x or y
}

interface SnapResult {
  snappedX: number;
  snappedY: number;
  guides: SnapGuide[];
}

/**
 * 드래그 중인 섹션의 x/y/크기와 다른 섹션들·캔버스 중심을 비교해서
 * 가장 가까운 정렬 지점을 찾아 position을 snap하고 guide line을 리턴.
 */
function computeSnap(
  dragCenterX: number,
  dragCenterY: number,
  dragWidth: number,
  dragHeight: number,
  others: Array<{ x: number; y: number; width: number; height: number }>,
  stageWidth: number,
): SnapResult {
  // 내 기준점 3개 (X축): left, center, right
  const myLeft = dragCenterX - dragWidth / 2;
  const myRight = dragCenterX + dragWidth / 2;
  const myXs = [myLeft, dragCenterX, myRight];

  // 내 기준점 3개 (Y축): top, center, bottom
  const myTop = dragCenterY - dragHeight / 2;
  const myBottom = dragCenterY + dragHeight / 2;
  const myYs = [myTop, dragCenterY, myBottom];

  // 타겟: 다른 섹션의 edges+center + 캔버스 center
  const targetXs: number[] = [stageWidth / 2];
  const targetYs: number[] = [STAGE_H / 2];
  for (const o of others) {
    targetXs.push(o.x - o.width / 2, o.x, o.x + o.width / 2);
    targetYs.push(o.y - o.height / 2, o.y, o.y + o.height / 2);
  }

  // 가장 가까운 X 스냅 찾기
  let bestDx: { delta: number; guideX: number } | null = null;
  for (const t of targetXs) {
    for (const my of myXs) {
      const delta = t - my;
      if (Math.abs(delta) < SNAP_THRESHOLD) {
        if (!bestDx || Math.abs(delta) < Math.abs(bestDx.delta)) {
          bestDx = { delta, guideX: t };
        }
      }
    }
  }

  // 가장 가까운 Y 스냅 찾기
  let bestDy: { delta: number; guideY: number } | null = null;
  for (const t of targetYs) {
    for (const my of myYs) {
      const delta = t - my;
      if (Math.abs(delta) < SNAP_THRESHOLD) {
        if (!bestDy || Math.abs(delta) < Math.abs(bestDy.delta)) {
          bestDy = { delta, guideY: t };
        }
      }
    }
  }

  const guides: SnapGuide[] = [];
  if (bestDx) guides.push({ orientation: "vertical", position: bestDx.guideX });
  if (bestDy) guides.push({ orientation: "horizontal", position: bestDy.guideY });

  return {
    snappedX: dragCenterX + (bestDx?.delta ?? 0),
    snappedY: dragCenterY + (bestDy?.delta ?? 0),
    guides,
  };
}

function sectionDims(section: FigmaSection) {
  if (section.kind === "stage") {
    // 무대는 넓고 얕은 블록 (기본 320x80, 리사이즈 시 저장된 값 사용)
    return { width: section.width ?? 320, height: section.height ?? 80 };
  }
  if (section.kind === "console") {
    // 콘솔(음향/조명 부스)도 비좌석 블록
    return { width: section.width ?? 180, height: section.height ?? 80 };
  }
  if (section.kind === "standing") {
    if (section.width && section.height) {
      return { width: section.width, height: section.height };
    }
    const cap = section.capacity ?? 100;
    const scale = Math.max(1, Math.sqrt(cap / 50));
    return { width: 180 * scale, height: 120 * scale };
  }
  const width = section.seatsPerRow * (SEAT_SIZE + SEAT_GAP) - SEAT_GAP + PADDING * 2;
  const height = section.rows * (SEAT_SIZE + SEAT_GAP) - SEAT_GAP + PADDING * 2 + 20;
  return { width, height };
}

function newSection(
  name: string,
  index: number,
  stageWidth: number,
  kind: SectionKind = "assigned",
): FigmaSection {
  const defaultName = kind === "stage" ? "STAGE" : kind === "console" ? "콘솔" : name;
  return {
    id: crypto.randomUUID(),
    name: defaultName,
    x: kind === "stage" ? stageWidth / 2 : 120 + (index % 3) * 280,
    y: kind === "stage" ? 80 : 120 + Math.floor(index / 3) * 220,
    rows: 5,
    seatsPerRow: 8,
    rotation: 0,
    tierId: null,
    kind,
    blockedPositions: [],
    capacity: kind === "standing" ? 100 : undefined,
    width: kind === "console" ? 180 : undefined,
    height: kind === "console" ? 80 : undefined,
  };
}

interface FigmaBuilderProps {
  tiers: FigmaTierLite[];
  initialSections?: FigmaSection[];
  onSave: (sections: FigmaSection[]) => Promise<void>;
}

export function FigmaBuilder({ tiers, initialSections = [], onSave }: FigmaBuilderProps) {
  const [sections, setSections] = useState<FigmaSection[]>(initialSections);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [guides, setGuides] = useState<SnapGuide[]>([]);
  const [showGrid, setShowGrid] = useState(true);
  const [marquee, setMarquee] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const marqueeStart = useRef<{ x: number; y: number } | null>(null);
  const dragStartPositions = useRef<Map<string, { x: number; y: number }>>(new Map());
  const stageRef = useRef<Konva.Stage>(null);
  const transformerRef = useRef<Konva.Transformer>(null);
  const groupRefs = useRef<Map<string, Konva.Group>>(new Map());
  const stageContainerRef = useRef<HTMLDivElement>(null);
  const [stageWidth, setStageWidth] = useState(STAGE_W_INITIAL);

  useEffect(() => {
    const el = stageContainerRef.current;
    if (!el) return;
    const update = () => {
      const width = el.clientWidth;
      if (width > 0) setStageWidth(width);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const selectedId = selectedIds.size === 1 ? Array.from(selectedIds)[0] : null;
  const isMulti = selectedIds.size > 1;

  const selected = useMemo(
    () => (selectedId ? (sections.find((s) => s.id === selectedId) ?? null) : null),
    [sections, selectedId],
  );

  // Transformer에 선택된 그룹 연결 (단일 선택일 때만)
  const attachTransformer = useCallback(() => {
    if (!transformerRef.current) return;
    if (!selectedId || isMulti) {
      transformerRef.current.nodes([]);
      transformerRef.current.getLayer()?.batchDraw();
      return;
    }
    const node = groupRefs.current.get(selectedId);
    if (node) {
      transformerRef.current.nodes([node]);
      transformerRef.current.getLayer()?.batchDraw();
    }
  }, [selectedId, isMulti]);

  function selectSingle(id: string) {
    setSelectedIds(new Set([id]));
  }

  function toggleSelection(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // 클립보드 — Ctrl/Cmd+C 복사, Ctrl/Cmd+V 붙여넣기
  const clipboardRef = useRef<FigmaSection[]>([]);

  // 키보드 단축키 — Figma 풍 인터랙션
  //   Delete / Backspace : 선택 섹션 삭제
  //   ↑ ↓ ← →           : 1px 이동 (Shift 동시 = 10px)
  //   ⌘/Ctrl + C        : 복사
  //   ⌘/Ctrl + V        : 붙여넣기 (오프셋 +20)
  //   ⌘/Ctrl + D        : 복제 (선택 즉시 +20 오프셋, Figma 동일)
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // 입력 필드 포커스 중이면 모든 단축키 무시
      const tag = (e.target as HTMLElement)?.tagName;
      const isContentEditable = (e.target as HTMLElement)?.isContentEditable;
      if (tag === "INPUT" || tag === "TEXTAREA" || isContentEditable) return;

      const meta = e.metaKey || e.ctrlKey;

      // 복사
      if (meta && e.key.toLowerCase() === "c" && selectedIds.size > 0) {
        e.preventDefault();
        clipboardRef.current = sections.filter((s) => selectedIds.has(s.id));
        return;
      }

      // 붙여넣기
      if (meta && e.key.toLowerCase() === "v" && clipboardRef.current.length > 0) {
        e.preventDefault();
        const newOnes = clipboardRef.current.map((s) => ({
          ...s,
          id: crypto.randomUUID(),
          name: `${s.name} 복사본`,
          x: s.x + 20,
          y: s.y + 20,
        }));
        setSections((prev) => [...prev, ...newOnes]);
        setSelectedIds(new Set(newOnes.map((s) => s.id)));
        return;
      }

      // 복제 (Cmd/Ctrl + D)
      if (meta && e.key.toLowerCase() === "d" && selectedIds.size > 0) {
        e.preventDefault();
        const targets = sections.filter((s) => selectedIds.has(s.id));
        const newOnes = targets.map((s) => ({
          ...s,
          id: crypto.randomUUID(),
          name: `${s.name} 복사본`,
          x: s.x + 20,
          y: s.y + 20,
        }));
        setSections((prev) => [...prev, ...newOnes]);
        setSelectedIds(new Set(newOnes.map((s) => s.id)));
        return;
      }

      if (selectedIds.size === 0) return;

      // 삭제
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        setSections((prev) => prev.filter((s) => !selectedIds.has(s.id)));
        setSelectedIds(new Set());
        return;
      }

      // 화살표 이동 — Figma: 기본 1px, Shift 시 10px
      const arrowMap: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      };
      const delta = arrowMap[e.key];
      if (delta) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const [dx, dy] = delta;
        setSections((prev) =>
          prev.map((s) =>
            selectedIds.has(s.id)
              ? { ...s, x: s.x + dx * step, y: s.y + dy * step }
              : s,
          ),
        );
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedIds, sections]);

  function handleAddSection(kind: SectionKind = "assigned") {
    const name = String.fromCharCode(65 + sections.length); // A, B, C, ...
    const newOne = newSection(name, sections.length, stageWidth, kind);
    setSections((prev) => [...prev, newOne]);
    selectSingle(newOne.id);
  }

  function handleUpdate(id: string, patch: Partial<FigmaSection>) {
    setSections((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  function toggleSeatBlock(sectionId: string, key: string) {
    setSections((prev) =>
      prev.map((s) => {
        if (s.id !== sectionId) return s;
        const current = s.blockedPositions ?? [];
        const next = current.includes(key)
          ? current.filter((k) => k !== key)
          : [...current, key];
        return { ...s, blockedPositions: next };
      }),
    );
  }

  function changeKind(sectionId: string, kind: SectionKind) {
    setSections((prev) =>
      prev.map((s) =>
        s.id === sectionId
          ? {
              ...s,
              kind,
              blockedPositions: kind === "assigned" ? (s.blockedPositions ?? []) : [],
              capacity: kind === "standing" ? (s.capacity ?? s.rows * s.seatsPerRow) : undefined,
              width: kind === "console" ? (s.width ?? 180) : s.width,
              height: kind === "console" ? (s.height ?? 80) : s.height,
              name: kind === "console" && !s.name ? "콘솔" : s.name,
            }
          : s,
      ),
    );
  }

  function handleDelete(id: string) {
    setSections((prev) => prev.filter((s) => s.id !== id));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  function handleDeleteSelected() {
    setSections((prev) => prev.filter((s) => !selectedIds.has(s.id)));
    setSelectedIds(new Set());
  }

  function handleRotate(delta: number) {
    if (!selected) return;
    handleUpdate(selected.id, { rotation: (selected.rotation + delta) % 360 });
  }

  function handleSnapRotation(rotation: number) {
    if (!selected) return;
    handleUpdate(selected.id, { rotation });
  }

  async function handleSave() {
    if (sections.length === 0) {
      showError("섹션을 하나 이상 추가해주세요");
      return;
    }
    setSaving(true);
    try {
      await onSave(sections);
    } finally {
      setSaving(false);
    }
  }

  function tierColor(tierId: string | null): string {
    if (!tierId) return "#9ca3af";
    return tiers.find((t) => t.id === tierId)?.colorHex ?? "#9ca3af";
  }

  function tierName(tierId: string | null): string {
    if (!tierId) return "등급 없음";
    return tiers.find((t) => t.id === tierId)?.name ?? "등급 없음";
  }

  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      {/* 캔버스 + 툴바 */}
      <div className="flex-1 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm">
                  <Plus className="mr-1 size-4" /> 섹션 추가 <ChevronDown className="ml-1 size-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-44">
                <DropdownMenuItem onClick={() => handleAddSection("assigned")}>
                  🪑 지정석 섹션
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => handleAddSection("standing")}>
                  👥 스탠딩 섹션
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => handleAddSection("stage")}>
                  🎤 무대
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => handleAddSection("console")}>
                  🎛️ 콘솔 (음향/조명 부스)
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              size="sm"
              variant={showGrid ? "default" : "outline"}
              onClick={() => setShowGrid((v) => !v)}
              title="배경 눈금 토글"
            >
              <Grid3x3 className="mr-1 size-4" /> 눈금
            </Button>
            {isMulti && (
              <Button
                size="sm"
                variant="outline"
                className="border-error/40 text-error hover:bg-error/10"
                onClick={handleDeleteSelected}
              >
                <Trash2 className="mr-1 size-4" /> {selectedIds.size}개 삭제
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>섹션: {sections.length}</span>
            {selectedIds.size > 0 && (
              <>
                <span>·</span>
                <span className="font-semibold text-primary">{selectedIds.size}개 선택</span>
              </>
            )}
            <span>·</span>
            <span>
              총 판매 가능:{" "}
              {sections.reduce((sum, s) => {
                if (s.kind === "stage" || s.kind === "console") return sum;
                if (s.kind === "standing") return sum + (s.capacity ?? 0);
                return sum + s.rows * s.seatsPerRow - (s.blockedPositions?.length ?? 0);
              }, 0)}
              명/석
            </span>
          </div>
          <Button size="sm" onClick={() => void handleSave()} disabled={saving}>
            {saving ? "저장 중..." : "💾 저장 & 발행"}
          </Button>
        </div>

        <div ref={stageContainerRef} className="overflow-hidden rounded-lg border border-border bg-muted/30">
          <Stage
            ref={stageRef}
            width={stageWidth}
            height={STAGE_H}
            style={{ backgroundColor: "#f8f9fc" }}
            onMouseDown={(e) => {
              if (e.target === e.target.getStage()) {
                const stage = e.target.getStage();
                const pos = stage?.getPointerPosition();
                if (!pos) return;
                marqueeStart.current = pos;
                setMarquee({ x: pos.x, y: pos.y, width: 0, height: 0 });
                if (!e.evt.shiftKey) {
                  setSelectedIds(new Set());
                }
              }
            }}
            onMouseMove={(e) => {
              if (!marqueeStart.current) return;
              const pos = e.target.getStage()?.getPointerPosition();
              if (!pos) return;
              setMarquee({
                x: Math.min(marqueeStart.current.x, pos.x),
                y: Math.min(marqueeStart.current.y, pos.y),
                width: Math.abs(pos.x - marqueeStart.current.x),
                height: Math.abs(pos.y - marqueeStart.current.y),
              });
            }}
            onMouseUp={() => {
              if (marquee && (marquee.width > 3 || marquee.height > 3)) {
                const intersecting = sections
                  .filter((s) => {
                    const d = sectionDims(s);
                    const sLeft = s.x - d.width / 2;
                    const sRight = s.x + d.width / 2;
                    const sTop = s.y - d.height / 2;
                    const sBottom = s.y + d.height / 2;
                    const mLeft = marquee.x;
                    const mRight = marquee.x + marquee.width;
                    const mTop = marquee.y;
                    const mBottom = marquee.y + marquee.height;
                    return !(sRight < mLeft || sLeft > mRight || sBottom < mTop || sTop > mBottom);
                  })
                  .map((s) => s.id);
                setSelectedIds((prev) => new Set([...prev, ...intersecting]));
              }
              marqueeStart.current = null;
              setMarquee(null);
            }}
          >
            {/* 배경 눈금 — 캔버스 정중앙에 라인이 위치하도록 오프셋 */}
            {showGrid && (
              <Layer listening={false}>
                {(() => {
                  const cx = stageWidth / 2;
                  const cy = STAGE_H / 2;
                  const halfV = Math.ceil(cx / 20);
                  const halfH = Math.ceil(cy / 20);
                  const lines: React.ReactNode[] = [];
                  for (let i = -halfV; i <= halfV; i += 1) {
                    const x = cx + i * 20;
                    const isCenter = i === 0;
                    lines.push(
                      <Line
                        key={`gv-${i}`}
                        points={[x, 0, x, STAGE_H]}
                        stroke={isCenter ? "#a78bfa" : i % 5 === 0 ? "#d1d5db" : "#e5e7eb"}
                        strokeWidth={isCenter ? 1 : 0.5}
                      />,
                    );
                  }
                  for (let i = -halfH; i <= halfH; i += 1) {
                    const y = cy + i * 20;
                    const isCenter = i === 0;
                    lines.push(
                      <Line
                        key={`gh-${i}`}
                        points={[0, y, stageWidth, y]}
                        stroke={isCenter ? "#a78bfa" : i % 5 === 0 ? "#d1d5db" : "#e5e7eb"}
                        strokeWidth={isCenter ? 1 : 0.5}
                      />,
                    );
                  }
                  return lines;
                })()}
              </Layer>
            )}
            <Layer>
              {sections.map((section) => {
                const { width, height } = sectionDims(section);
                const color = tierColor(section.tierId);

                return (
                  <Group
                    key={section.id}
                    ref={(node) => {
                      if (node) {
                        groupRefs.current.set(section.id, node);
                        if (selectedIds.has(section.id)) {
                          attachTransformer();
                        }
                      }
                    }}
                    x={section.x}
                    y={section.y}
                    offsetX={width / 2}
                    offsetY={height / 2}
                    rotation={section.rotation}
                    draggable
                    onClick={(e) => {
                      if (e.evt.shiftKey) {
                        toggleSelection(section.id);
                      } else if (!selectedIds.has(section.id)) {
                        selectSingle(section.id);
                      }
                    }}
                    onTap={() => selectSingle(section.id)}
                    onDragStart={() => {
                      // 다중 선택 시 모든 선택된 섹션 원본 위치 기록
                      dragStartPositions.current = new Map();
                      if (selectedIds.size > 1 && selectedIds.has(section.id)) {
                        sections.forEach((s) => {
                          if (selectedIds.has(s.id)) {
                            dragStartPositions.current.set(s.id, { x: s.x, y: s.y });
                          }
                        });
                      }
                    }}
                    onDragMove={(e) => {
                      const node = e.target;
                      // 다중 선택 드래그: 델타로 나머지도 이동
                      if (selectedIds.size > 1 && selectedIds.has(section.id)) {
                        const startPos = dragStartPositions.current.get(section.id);
                        if (startPos) {
                          const dx = node.x() - startPos.x;
                          const dy = node.y() - startPos.y;
                          setSections((prev) =>
                            prev.map((s) => {
                              if (s.id === section.id) return s; // 현재 드래그 중인 건 Konva가 관리
                              if (!selectedIds.has(s.id)) return s;
                              const orig = dragStartPositions.current.get(s.id);
                              if (!orig) return s;
                              return { ...s, x: orig.x + dx, y: orig.y + dy };
                            }),
                          );
                        }
                        return;
                      }
                      // 단일 드래그: 스냅 적용
                      const otherBoxes = sections
                        .filter((s) => s.id !== section.id)
                        .map((s) => {
                          const d = sectionDims(s);
                          return { x: s.x, y: s.y, width: d.width, height: d.height };
                        });
                      const snap = computeSnap(
                        node.x(),
                        node.y(),
                        width,
                        height,
                        otherBoxes,
                        stageWidth,
                      );
                      node.x(snap.snappedX);
                      node.y(snap.snappedY);
                      setGuides(snap.guides);
                    }}
                    onDragEnd={(e) => {
                      handleUpdate(section.id, {
                        x: e.target.x(),
                        y: e.target.y(),
                      });
                      setGuides([]);
                      dragStartPositions.current.clear();
                    }}
                    onTransformEnd={(e) => {
                      const node = e.target;
                      const scaleX = node.scaleX();
                      const scaleY = node.scaleY();
                      const scaled = Math.abs(scaleX - 1) > 0.001 || Math.abs(scaleY - 1) > 0.001;
                      const current = sectionDims(section);
                      const newWidth = Math.max(40, current.width * scaleX);
                      const newHeight = Math.max(40, current.height * scaleY);

                      if (!scaled) {
                        handleUpdate(section.id, {
                          x: node.x(),
                          y: node.y(),
                          rotation: node.rotation(),
                        });
                      } else if (section.kind === "assigned") {
                        // 픽셀 → 행/좌석 수로 역산
                        const innerW = newWidth - PADDING * 2 + SEAT_GAP;
                        const innerH = newHeight - PADDING * 2 - 20 + SEAT_GAP;
                        const newSeatsPerRow = Math.max(1, Math.min(50, Math.round(innerW / (SEAT_SIZE + SEAT_GAP))));
                        const newRows = Math.max(1, Math.min(30, Math.round(innerH / (SEAT_SIZE + SEAT_GAP))));
                        handleUpdate(section.id, {
                          x: node.x(),
                          y: node.y(),
                          rotation: node.rotation(),
                          rows: newRows,
                          seatsPerRow: newSeatsPerRow,
                        });
                      } else {
                        handleUpdate(section.id, {
                          x: node.x(),
                          y: node.y(),
                          rotation: node.rotation(),
                          width: newWidth,
                          height: newHeight,
                        });
                      }
                      node.scaleX(1);
                      node.scaleY(1);
                    }}
                  >
                    {/* 섹션 배경 박스 */}
                    <Rect
                      width={width}
                      height={height}
                      fill={
                        section.kind === "stage"
                          ? "#e5e7eb"
                          : section.kind === "console"
                            ? "#fef3c7"
                            : `${color}22`
                      }
                      stroke={
                        section.kind === "stage"
                          ? "#6b7280"
                          : section.kind === "console"
                            ? "#d97706"
                            : color
                      }
                      strokeWidth={selectedIds.has(section.id) ? 3 : 1.5}
                      cornerRadius={section.kind === "stage" ? 40 : 8}
                      dash={section.kind === "standing" ? [6, 4] : undefined}
                    />
                    {/* 섹션 이름 (stage/console 은 별도 중앙 라벨로 대체) */}
                    {section.kind !== "stage" && section.kind !== "console" && (
                      <Text
                        x={0}
                        y={4}
                        width={width}
                        height={18}
                        text={section.name}
                        fontSize={14}
                        fontStyle="bold"
                        fill={color}
                        align="center"
                      />
                    )}
                    {section.kind === "stage" ? (
                      /* 무대 — "STAGE" 라벨 (이름 label 위에 중앙) */
                      <Text
                        x={0}
                        y={height / 2 - 12}
                        width={width}
                        text={`🎤 ${section.name || "STAGE"}`}
                        fontSize={20}
                        fontStyle="bold"
                        fill="#1f2937"
                        align="center"
                      />
                    ) : section.kind === "console" ? (
                      /* 콘솔 — 음향/조명 부스 라벨 */
                      <Text
                        x={0}
                        y={height / 2 - 10}
                        width={width}
                        text={`🎛️ ${section.name || "콘솔"}`}
                        fontSize={16}
                        fontStyle="bold"
                        fill="#92400e"
                        align="center"
                      />
                    ) : section.kind === "standing" ? (
                      /* 스탠딩 — 수용 인원 표시 */
                      <>
                        <Text
                          x={0}
                          y={height / 2 - 16}
                          width={width}
                          text="STANDING"
                          fontSize={11}
                          fontStyle="bold"
                          fill={color}
                          align="center"
                          opacity={0.6}
                        />
                        <Text
                          x={0}
                          y={height / 2 + 2}
                          width={width}
                          text={`${section.capacity ?? 0}명`}
                          fontSize={22}
                          fontStyle="bold"
                          fill={color}
                          align="center"
                        />
                      </>
                    ) : (
                      /* 지정석 — 좌석 도트 (클릭으로 차단 토글) */
                      Array.from({ length: section.rows }).map((_, rIdx) =>
                        Array.from({ length: section.seatsPerRow }).map((_, cIdx) => {
                          const key = `${rIdx}-${cIdx}`;
                          const isBlocked = section.blockedPositions?.includes(key);
                          return (
                            <Rect
                              key={key}
                              x={PADDING + cIdx * (SEAT_SIZE + SEAT_GAP)}
                              y={PADDING + 20 + rIdx * (SEAT_SIZE + SEAT_GAP)}
                              width={SEAT_SIZE}
                              height={SEAT_SIZE}
                              fill={isBlocked ? "#cbd5e1" : color}
                              stroke={isBlocked ? "#94a3b8" : undefined}
                              strokeWidth={isBlocked ? 1 : 0}
                              opacity={isBlocked ? 0.7 : 0.8}
                              cornerRadius={3}
                              onClick={(e) => {
                                e.cancelBubble = true;
                                if (!selectedIds.has(section.id)) {
                                  selectSingle(section.id);
                                  return;
                                }
                                toggleSeatBlock(section.id, key);
                              }}
                              onTap={(e) => {
                                e.cancelBubble = true;
                                if (!selectedIds.has(section.id)) {
                                  selectSingle(section.id);
                                  return;
                                }
                                toggleSeatBlock(section.id, key);
                              }}
                            />
                          );
                        }),
                      )
                    )}
                  </Group>
                );
              })}
              {/* 회전 + 리사이즈 핸들 */}
              <Transformer
                ref={transformerRef}
                rotateEnabled={true}
                resizeEnabled={true}
                enabledAnchors={[
                  "top-left",
                  "top-right",
                  "bottom-left",
                  "bottom-right",
                  "middle-left",
                  "middle-right",
                  "top-center",
                  "bottom-center",
                ]}
                boundBoxFunc={(oldBox, newBox) => {
                  // 최소 크기 40x40 — 너무 작아지는 것 방지
                  if (newBox.width < 40 || newBox.height < 40) return oldBox;
                  return newBox;
                }}
                rotationSnaps={[0, 15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165, 180, 195, 210, 225, 240, 255, 270, 285, 300, 315, 330, 345]}
                rotationSnapTolerance={5}
              />

              {/* Snap guide lines (드래그 중에만 보임) */}
              {guides.map((g, idx) => (
                <Line
                  key={`${g.orientation}-${g.position}-${idx}`}
                  points={
                    g.orientation === "vertical"
                      ? [g.position, 0, g.position, STAGE_H]
                      : [0, g.position, stageWidth, g.position]
                  }
                  stroke="#ff3b8c"
                  strokeWidth={1}
                  dash={[4, 4]}
                  listening={false}
                />
              ))}
              {/* 마퀴 선택 박스 */}
              {marquee && (marquee.width > 3 || marquee.height > 3) && (
                <Rect
                  x={marquee.x}
                  y={marquee.y}
                  width={marquee.width}
                  height={marquee.height}
                  fill="#6C5CE7"
                  opacity={0.1}
                  stroke="#6C5CE7"
                  strokeWidth={1}
                  dash={[4, 4]}
                  listening={false}
                />
              )}
            </Layer>
          </Stage>
        </div>

        <p className="text-xs text-muted-foreground">
          💡 빈 공간 드래그로 여러 섹션 선택 · Shift+클릭으로 추가 선택 · 모서리 핸들로 크기 조절 · 회전 핸들로 각도 조절
        </p>
      </div>

      {/* 우측 속성 패널 */}
      <div className="w-full space-y-3 lg:w-72">
        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="mb-3 text-sm font-bold text-foreground">섹션 속성</h3>
          {isMulti ? (
            <div className="space-y-3">
              <div className="rounded-md bg-primary/10 px-3 py-2 text-xs font-semibold text-primary">
                🎯 {selectedIds.size}개 섹션 선택됨
              </div>
              <p className="text-xs text-muted-foreground">
                드래그로 모두 함께 이동, Delete 키로 삭제, 등급 일괄 지정 가능합니다.
              </p>
              <div className="space-y-1.5">
                <Label className="text-xs">선택된 섹션 등급 일괄 지정</Label>
                <Select
                  value="none"
                  onValueChange={(v) => {
                    const tid = v === "none" ? null : v;
                    setSections((prev) =>
                      prev.map((s) => (selectedIds.has(s.id) ? { ...s, tierId: tid } : s)),
                    );
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="등급 선택..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">등급 없음</SelectItem>
                    {tiers.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        <span className="inline-block size-3 rounded-full" style={{ backgroundColor: t.colorHex ?? "#9ca3af" }} />
                        <span className="ml-2">{t.name}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="w-full border-error/30 text-error hover:bg-error/10"
                onClick={handleDeleteSelected}
              >
                <Trash2 className="mr-1 size-3" /> {selectedIds.size}개 섹션 삭제
              </Button>
            </div>
          ) : selected ? (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="sec-name" className="text-xs">이름</Label>
                <Input
                  id="sec-name"
                  value={selected.name}
                  onChange={(e) => handleUpdate(selected.id, { name: e.target.value })}
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">타입</Label>
                <div className="grid grid-cols-2 gap-1 rounded-lg border border-border p-1">
                  <button
                    type="button"
                    onClick={() => changeKind(selected.id, "assigned")}
                    className={cn(
                      "rounded px-2 py-1.5 text-xs font-semibold transition",
                      selected.kind === "assigned"
                        ? "bg-primary text-white"
                        : "text-muted-foreground hover:bg-muted",
                    )}
                  >
                    🪑 지정석
                  </button>
                  <button
                    type="button"
                    onClick={() => changeKind(selected.id, "standing")}
                    className={cn(
                      "rounded px-2 py-1.5 text-xs font-semibold transition",
                      selected.kind === "standing"
                        ? "bg-primary text-white"
                        : "text-muted-foreground hover:bg-muted",
                    )}
                  >
                    👥 스탠딩
                  </button>
                  <button
                    type="button"
                    onClick={() => changeKind(selected.id, "stage")}
                    className={cn(
                      "rounded px-2 py-1.5 text-xs font-semibold transition",
                      selected.kind === "stage"
                        ? "bg-primary text-white"
                        : "text-muted-foreground hover:bg-muted",
                    )}
                  >
                    🎤 무대
                  </button>
                  <button
                    type="button"
                    onClick={() => changeKind(selected.id, "console")}
                    className={cn(
                      "rounded px-2 py-1.5 text-xs font-semibold transition",
                      selected.kind === "console"
                        ? "bg-primary text-white"
                        : "text-muted-foreground hover:bg-muted",
                    )}
                  >
                    🎛️ 콘솔
                  </button>
                </div>
              </div>

              {selected.kind === "stage" ? (
                <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                  🎤 무대는 공연장 구조 표시용입니다. 판매되지 않습니다.
                </p>
              ) : selected.kind === "console" ? (
                <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                  🎛️ 콘솔(음향/조명 부스)은 공연장 구조 표시용입니다. 판매되지 않습니다.
                </p>
              ) : selected.kind === "assigned" ? (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="sec-rows" className="text-xs">행</Label>
                      <Input
                        id="sec-rows"
                        type="number"
                        min={1}
                        max={30}
                        value={selected.rows}
                        onChange={(e) =>
                          handleUpdate(selected.id, {
                            rows: Math.max(1, Math.min(30, Number(e.target.value) || 1)),
                          })
                        }
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="sec-cols" className="text-xs">좌석</Label>
                      <Input
                        id="sec-cols"
                        type="number"
                        min={1}
                        max={50}
                        value={selected.seatsPerRow}
                        onChange={(e) =>
                          handleUpdate(selected.id, {
                            seatsPerRow: Math.max(1, Math.min(50, Number(e.target.value) || 1)),
                          })
                        }
                      />
                    </div>
                  </div>
                  {selected.blockedPositions && selected.blockedPositions.length > 0 && (
                    <div className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
                      🚫 차단 좌석: {selected.blockedPositions.length}개
                      <button
                        type="button"
                        className="ml-2 underline"
                        onClick={() => handleUpdate(selected.id, { blockedPositions: [] })}
                      >
                        모두 해제
                      </button>
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">
                    💡 선택된 섹션의 좌석을 클릭하면 판매 제외(차단)됩니다.
                  </p>
                </>
              ) : (
                <div className="space-y-1.5">
                  <Label htmlFor="sec-capacity" className="text-xs">수용 인원</Label>
                  <Input
                    id="sec-capacity"
                    type="number"
                    min={1}
                    max={10000}
                    value={selected.capacity ?? 100}
                    onChange={(e) =>
                      handleUpdate(selected.id, {
                        capacity: Math.max(1, Math.min(10000, Number(e.target.value) || 1)),
                      })
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    이 구역에 몇 명까지 입장 가능한지 (자유석)
                  </p>
                </div>
              )}
              <div className="space-y-1.5">
                <Label className="text-xs">등급</Label>
                <Select
                  value={selected.tierId ?? "none"}
                  onValueChange={(v) => handleUpdate(selected.id, { tierId: v === "none" ? null : v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">등급 없음</SelectItem>
                    {tiers.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        <span className="inline-block size-3 rounded-full" style={{ backgroundColor: t.colorHex ?? "#9ca3af" }} />
                        <span className="ml-2">{t.name}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">회전: {Math.round(selected.rotation)}°</Label>
                <div className="flex gap-1">
                  <Button size="sm" variant="outline" onClick={() => handleRotate(-15)}>
                    <RotateCw className="size-3 scale-x-[-1]" />
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => handleRotate(15)}>
                    <RotateCw className="size-3" />
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => handleSnapRotation(0)}>0°</Button>
                  <Button size="sm" variant="outline" onClick={() => handleSnapRotation(90)}>90°</Button>
                </div>
              </div>
              <div className="pt-2 text-xs text-muted-foreground">
                {selected.kind === "assigned"
                  ? `좌석: ${selected.rows * selected.seatsPerRow - (selected.blockedPositions?.length ?? 0)}석 (차단 ${selected.blockedPositions?.length ?? 0}석 제외)`
                  : `수용: ${selected.capacity ?? 0}명`}{" "}
                · 등급: {tierName(selected.tierId)}
              </div>
              <Button
                size="sm"
                variant="outline"
                className="w-full border-error/30 text-error hover:bg-error/10"
                onClick={() => handleDelete(selected.id)}
              >
                <Trash2 className="mr-1 size-3" /> 섹션 삭제
              </Button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              섹션을 선택하거나 &quot;섹션 추가&quot;로 새로 만드세요.
            </p>
          )}
        </div>

        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="mb-2 text-sm font-bold text-foreground">섹션 목록</h3>
          <div className="space-y-1">
            {sections.length === 0 ? (
              <p className="text-xs text-muted-foreground">비어있음</p>
            ) : (
              sections.map((s) => (
                <button
                  key={s.id}
                  className={`flex w-full items-center gap-2 rounded border px-2 py-1.5 text-left text-xs transition ${selectedIds.has(s.id) ? "border-primary bg-primary/10" : "border-border hover:bg-muted"}`}
                  onClick={(e) =>
                    e.shiftKey ? toggleSelection(s.id) : selectSingle(s.id)
                  }
                >
                  <span className="inline-block size-2.5 rounded-full" style={{ backgroundColor: tierColor(s.tierId) }} />
                  <span className="flex-1 font-semibold">{s.name}</span>
                  <span className="text-muted-foreground">
                    {s.kind === "stage"
                      ? "🎤 무대"
                      : s.kind === "standing"
                        ? `👥 ${s.capacity ?? 0}`
                        : `${s.rows}×${s.seatsPerRow}`}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
