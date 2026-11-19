"use client";

/**
 * TicketsClient — 통합 "티켓 & 좌석" 페이지.
 *
 * ## 좌석 판매 방식으로 화면이 갈린다
 * - `assigned`(지정석)   — 배치도 에디터. 섹션을 추가하고 섹션별로 지정석/스탠딩을 지정한다.
 *                          (섹션 단위로 고르므로 상단 모드 스위처는 없다.)
 * - `unassigned`(자유입장) — 배치도가 없는 행사(골프 갤러리·페스티벌·박람회).
 *                          등급 관리만 세우고 배치도 에디터는 띄우지 않는다.
 *
 * 🔴 종전에는 분기가 없어 자유입장 행사도 배치도 에디터를 마주했다. 배치도를 그려야만
 * 등급 수량이 채워지는 구조라 "섹션 0 · 총 판매 가능 0명/석" 이 실재고와 무관하게 표시됐고,
 * 설정이 덜 된 화면처럼 보였다. 판매 자체는 등급 수량만으로 정상 동작한다.
 */

import dynamic from "next/dynamic";
import { EVIDENCE_SIMPLE_MODE } from "@/lib/evidence-mode";
import { showsSeatMapEditor, type SeatType } from "@/lib/seats/seat-type";
import { TierManager } from "../../seat-map/_components/tier-manager";
import { SalePlanCard } from "./sale-plan-card";

const SeatMapEditor = dynamic(
  () =>
    import("../../seat-map/_components/seat-map-editor").then(
      (m) => m.SeatMapEditor,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="p-12 text-center text-muted-foreground">에디터 로딩 중...</div>
    ),
  },
);

interface TicketsClientProps {
  eventId: string;
  seatType: SeatType;
}

export function TicketsClient({ eventId, seatType }: TicketsClientProps) {
  const unassigned = !showsSeatMapEditor(seatType);

  return (
    <div className="space-y-6">
      {/* 페이지 헤더 */}
      <div>
        <h2 className="text-3xl font-black tracking-[-0.04em] text-foreground">
          {unassigned ? "티켓 등급" : "티켓 & 좌석배치도"}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {unassigned
            ? "좌석 지정 없이 판매하는 행사입니다. 등급과 수량을 입력하세요."
            : "섹션을 추가하고 섹션별로 지정석/스탠딩/무대 타입을 선택하세요."}
        </p>
      </div>

      {unassigned ? (
        <>
          <div className="max-w-md">
            <TierManager eventId={eventId} unassigned />
          </div>
          {/* 증빙용 간단 모드는 지정석 선택지를 숨기므로 이 안내도 숨긴다(@/lib/evidence-mode). */}
          {EVIDENCE_SIMPLE_MODE ? null : (
            <p className="text-xs text-muted-foreground">
              좌석을 지정해서 파는 행사로 바꾸려면 이벤트 설정에서 판매 방식을 「지정석 판매」로
              변경하세요.
            </p>
          )}
        </>
      ) : (
        /* 통합 에디터 — 좌측 등급 관리 + 우측 배치도 */
        <SeatMapEditor eventId={eventId} />
      )}

      {/* 판매 방식 선택 */}
      <SalePlanCard eventId={eventId} />
    </div>
  );
}
