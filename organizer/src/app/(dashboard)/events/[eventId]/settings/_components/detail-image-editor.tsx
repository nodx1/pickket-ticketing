"use client";

import { ArrowDown, ArrowUp, ImagePlus, Loader2, X } from "lucide-react";
import { fetchWithRefresh } from "@/lib/fetchWithAuth";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { showError, showSuccess } from "@/lib/hooks/useToast";
import {
  DETAIL_CAPTION_MAX,
  DETAIL_IMAGE_MAX,
  DETAIL_SECTION_LABELS,
  DETAIL_SECTION_MAX,
  DETAIL_SECTIONS,
  resolveDetailSection,
  type DetailSection,
} from "@/lib/public/detail-image";
import { canSaveEditor } from "@/lib/forms/save-guard";
import { useUnsavedSection } from "@/lib/hooks/unsaved-sections";
import { UnsavedBadge } from "@/components/shared/unsaved-badge";
import {
  appendToSection,
  countInSection,
  moveWithinSection,
  remainingSlots,
} from "@/lib/events/detail-image-order";

interface DetailImage {
  url: string;
  caption?: string;
  section?: DetailSection;
}

/**
 * 상세 안내 이미지 편집 — 이벤트 소개 아래에 세로로 이어 붙는 이미지.
 *
 * 🔴 왜 이벤트 폼(EventForm)이 아니라 독립 카드인가
 *  · 저장 위치가 다르다 — 이 값은 `homepage_design` JSONB 에 산다(이벤트 필드가 아니다).
 *  · 폼은 생성 모드에서도 쓰이는데, 그때는 `eventId` 가 없어 저장할 곳이 없다.
 *  · 폼에 묶으면 저장 한 번에 API 두 개를 호출해야 하고, 한쪽만 실패하면
 *    "저장됐다는데 이미지가 없다" 가 된다.
 *
 * 🔴 저장은 **PATCH(부분 병합)** 로 한다. PUT 은 전체 교체라 색·토글·히어로 설정까지
 *    날아간다 — 이 화면은 디자인 전체를 알지 못한다.
 */
export function DetailImageEditor({ eventId }: { eventId: string }) {
  const [items, setItems] = useState<DetailImage[]>([]);
  const [loading, setLoading] = useState(true);
  /** 기존 값을 못 읽은 상태 — 저장하면 덮어쓰므로 편집·저장을 막는다. */
  const [loadFailed, setLoadFailed] = useState(false);
  /** 어느 섹션이 업로드 중인가 — 그룹별 버튼이라 boolean 으로는 어디가 도는지 못 보여준다. */
  const [uploading, setUploading] = useState<DetailSection | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  useUnsavedSection("detail-images", "상세 안내 이미지", dirty);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** 파일 선택창을 띄운 그룹 — onChange 에서 어느 섹션인지 알아야 한다. */
  const pendingSection = useRef<DetailSection>("intro");

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetchWithRefresh(`/api/events/${eventId}/homepage-design`, { credentials: "include" });
        if (!res.ok) throw new Error(String(res.status));
        const payload = (await res.json()) as { data?: { detailImages?: DetailImage[] } };
        if (alive && Array.isArray(payload.data?.detailImages)) setItems(payload.data.detailImages);
      } catch {
        // 🔴 로드 실패를 빈 목록으로 흘리면 **기존 이미지를 지운다.**
        //    화면은 "등록된 이미지 없음"으로 보이고, 거기서 한 장 올려 저장하면
        //    PATCH 가 detailImages 를 [새 1장] 으로 덮어써 원래 목록이 사라진다.
        //    그래서 실패를 표시하고 **저장 자체를 막는다** — 모르면 쓰지 않는다.
        if (alive) setLoadFailed(true);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [eventId]);

  /**
   * 업로드 — **누른 그룹의 섹션으로** 들어간다.
   *
   * 🔴 종전에는 무조건 `section: "intro"` 였다. 그래서 주최자가 약도를 올려도 드롭다운을
   *    손대지 않으면 전부 「이벤트 안내」로 갔다 — KLPGA 실데이터가 그 상태였다(2장 모두).
   *    섹션 지정 기능이 **기본값 때문에 사실상 안 쓰였다.** 지금은 기본값 개념이 없다.
   */
  async function uploadFiles(files: File[], section: DetailSection) {
    const slots = remainingSlots(items, section);
    if (slots <= 0) {
      showError(
        `${DETAIL_SECTION_LABELS[section]} 이미지는 최대 ${DETAIL_SECTION_MAX[section]}장까지 등록할 수 있습니다`,
      );
      return;
    }
    setUploading(section);
    try {
      const uploaded: Array<{ url: string }> = [];
      for (const file of files.slice(0, slots)) {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("uploadType", "event");
        const res = await fetchWithRefresh("/api/upload", { method: "POST", credentials: "include", body: fd });
        const payload = (await res.json()) as { data?: { url: string }; error?: string };
        if (!res.ok || !payload.data) throw new Error(payload.error ?? "업로드에 실패했습니다");
        // 🔴 마스터 URL 을 쓴다 — 축소 렌디션은 안내문 글자를 뭉갠다.
        uploaded.push({ url: payload.data.url });
      }
      const { next, accepted, dropped } = appendToSection(items, section, uploaded);
      setItems(next);
      setDirty(true);
      // 넘쳐서 버린 장수를 **말해준다** — 조용히 버리면 "올렸는데 없다" 가 된다.
      showSuccess(
        dropped > 0
          ? `${DETAIL_SECTION_LABELS[section]}에 ${accepted}장 추가 (상한 초과 ${dropped}장은 제외). 저장을 눌러주세요.`
          : `${DETAIL_SECTION_LABELS[section]}에 ${accepted}장 추가되었습니다. 저장을 눌러주세요.`,
      );
      if (files.length > slots) {
        showError(`${DETAIL_SECTION_LABELS[section]} 잔여 ${slots}장을 넘겨 일부를 넣지 못했습니다`);
      }
    } catch (err: unknown) {
      if (err instanceof Error) showError(err.message);
    } finally {
      setUploading(null);
    }
  }

  /** 같은 섹션 안에서만 이동한다. 판정은 순수 함수(`detail-image-order.ts`)가 한다. */
  function move(index: number, dir: -1 | 1) {
    const next = moveWithinSection(items, index, dir);
    if (!next) return; // 그룹의 처음/끝 — 무의미한 dirty 를 만들지 않는다
    setItems(next);
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    try {
      const res = await fetchWithRefresh(`/api/events/${eventId}/homepage-design`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ detailImages: items }),
      });
      if (!res.ok) {
        const payload = (await res.json()) as { error?: string };
        throw new Error(payload.error ?? "저장에 실패했습니다");
      }
      setDirty(false);
      showSuccess("상세 이미지를 저장했습니다");
    } catch (err: unknown) {
      if (err instanceof Error) showError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          상세 안내 이미지
          <UnsavedBadge show={dirty} />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          대회 안내문·타임테이블·약도처럼 <strong className="font-medium">이미지로 만든 안내물</strong>을
          올리는 자리입니다. <strong className="font-medium">넣고 싶은 자리의 「이미지 추가」</strong>를
          누르면 그 자리에 위에서부터 차례로 붙습니다.
          <br />
          자리별 장수는 아래 각 칸에 표시됩니다 (합 {DETAIL_IMAGE_MAX}장).
          <br />
          가로 <strong className="font-medium">1200px 이상</strong> 권장 · 세로 길이는 자유
          <br />
          🔴 글자가 든 이미지는 <strong className="font-medium">설명을 함께 넣어주세요</strong> — 화면을 읽어주는
          기기와 검색엔진에는 그 문장만 전달됩니다.
        </p>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> 불러오는 중...
          </div>
        ) : loadFailed ? (
          <div className="space-y-3 rounded-lg border border-error/30 bg-error/5 p-4">
            <p className="text-sm text-error">
              기존 상세 이미지를 불러오지 못했습니다. 이 상태로 저장하면 <strong>이미 등록된 이미지가
              지워질 수 있어</strong> 편집을 잠갔습니다.
            </p>
            <Button variant="outline" onClick={() => window.location.reload()}>
              다시 불러오기
            </Button>
          </div>
        ) : (
          <div className="space-y-5">
            {/* 🔴 섹션별 그룹 — "어느 그룹의 추가 버튼을 눌렀는지" 가 곧 표시 위치다.
                종전에는 이미지마다 드롭다운으로 골랐고 업로드 기본값이 intro 여서,
                손대지 않으면 전부 「이벤트 안내」로 갔다(KLPGA 실데이터가 그 상태였다).
                그룹으로 바꾸면 **기본값이라는 개념이 없어지고 오분류가 불가능**하다. */}
            {DETAIL_SECTIONS.map((section) => {
              const used = countInSection(items, section);
              const left = remainingSlots(items, section);
              const indices = items
                .map((item, index) => ({ item, index }))
                .filter(({ item }) => resolveDetailSection(item.section) === section);

              return (
                <div key={section} className="rounded-lg border border-border p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-sm font-semibold text-foreground">
                      {DETAIL_SECTION_LABELS[section]}
                    </p>
                    <span className="text-xs text-muted-foreground">
                      {used} / {DETAIL_SECTION_MAX[section]}장
                    </span>
                  </div>

                  {indices.length === 0 ? (
                    <p className="mb-2 text-xs text-muted-foreground">등록된 이미지가 없습니다.</p>
                  ) : (
                    <div className="mb-2 space-y-2">
                      {indices.map(({ item, index }, positionInGroup) => (
                        <div key={`${item.url}-${index}`} className="flex gap-3 rounded border border-border p-2">
                          <div className="relative h-20 w-16 shrink-0 overflow-hidden rounded border border-border bg-muted">
                            <Image
                              src={item.url}
                              alt={item.caption?.trim() || `${DETAIL_SECTION_LABELS[section]} ${positionInGroup + 1}`}
                              fill
                              className="object-contain"
                              unoptimized
                            />
                          </div>
                          <div className="flex flex-1 flex-col gap-2">
                            <input
                              type="text"
                              value={item.caption ?? ""}
                              onChange={(e) => {
                                const caption = e.target.value.slice(0, DETAIL_CAPTION_MAX);
                                setItems((prev) =>
                                  prev.map((it, idx) => (idx === index ? { ...it, caption } : it)),
                                );
                                setDirty(true);
                              }}
                              maxLength={DETAIL_CAPTION_MAX}
                              placeholder="이미지 설명 (예: 셔틀버스 운행 안내)"
                              aria-label={`${DETAIL_SECTION_LABELS[section]} ${positionInGroup + 1} 설명`}
                              className="w-full rounded-md border border-border bg-card px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
                            />
                            <div className="flex gap-1">
                              {/* ↑↓ 는 **이 그룹 안에서만** 움직인다. 판정은 순수 함수가 한다. */}
                              <button
                                type="button"
                                onClick={() => move(index, -1)}
                                disabled={positionInGroup === 0}
                                aria-label={`${DETAIL_SECTION_LABELS[section]} ${positionInGroup + 1} 위로`}
                                className="rounded border border-border p-1.5 text-foreground disabled:opacity-30"
                              >
                                <ArrowUp className="size-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => move(index, 1)}
                                disabled={positionInGroup === indices.length - 1}
                                aria-label={`${DETAIL_SECTION_LABELS[section]} ${positionInGroup + 1} 아래로`}
                                className="rounded border border-border p-1.5 text-foreground disabled:opacity-30"
                              >
                                <ArrowDown className="size-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setItems((prev) => prev.filter((_, idx) => idx !== index));
                                  setDirty(true);
                                }}
                                aria-label={`${DETAIL_SECTION_LABELS[section]} ${positionInGroup + 1} 삭제`}
                                className="rounded border border-border p-1.5 text-error"
                              >
                                <X className="size-3.5" />
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {left > 0 ? (
                    <button
                      type="button"
                      onClick={() => {
                        pendingSection.current = section;
                        inputRef.current?.click();
                      }}
                      disabled={uploading !== null}
                      className="flex w-full items-center justify-center gap-2 rounded border border-dashed border-border bg-muted px-3 py-3 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:opacity-50"
                    >
                      {uploading === section ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <ImagePlus className="size-4" />
                      )}
                      이 자리에 이미지 추가 ({left}장 더 가능)
                    </button>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      가득 찼습니다. 바꾸려면 위에서 삭제한 뒤 추가하세요.
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length) void uploadFiles(files, pendingSection.current);
            e.target.value = "";
          }}
        />

        {/* 저장 가능 판정은 순수 함수에 둔다 — 컴포넌트 안에 두면 테스트가 닿지 못한다. */}
        <Button
          onClick={() => void save()}
          disabled={!canSaveEditor({ loading, loadFailed, dirty, saving })}
        >
          {saving ? "저장 중..." : dirty ? "상세 이미지 저장" : "저장됨"}
        </Button>
      </CardContent>
    </Card>
  );
}
