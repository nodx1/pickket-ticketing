"use client";

import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";

const subscribeNothing = () => () => {};

/**
 * 화면 아래에 떠 있는 저장 막대. 긴 양식을 고치는 동안 맨 아래 저장 버튼까지 내려가지 않아도 저장할 수 있게 한다.
 *
 * `sticky` 로는 안 된다. 관리 화면 바깥 틀(overflow-x-hidden)이 스크롤 기준을 가로채서 붙지 않고,
 * 카드의 transform 때문에 카드 안 `fixed` 도 카드 기준이 된다. 그래서 body 에 따로 띄우고,
 * 양식 밖에 있어도 제출되도록 `form` 속성으로 양식을 가리킨다.
 * 모바일 하단 메뉴(lg 미만, 높이 약 4rem)를 가리지 않게 그 위에 둔다.
 */
export function FloatingSaveBar({
  show,
  formId,
  message,
  label,
  saving,
}: {
  show: boolean;
  formId: string;
  message: string;
  label: string;
  saving: boolean;
}) {
  // 서버 렌더에는 document.body 가 없다 — 브라우저에서만 띄운다.
  const mounted = useSyncExternalStore(subscribeNothing, () => true, () => false);
  if (!mounted || !show) return null;
  return createPortal(
    <div
      role="region"
      aria-label="저장 안 된 변경"
      className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex justify-center px-4 lg:bottom-6"
    >
      <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-border bg-card py-2 pl-5 pr-2 shadow-lg">
        <p className="text-sm font-medium text-warning">{message}</p>
        <Button type="submit" form={formId} size="sm" className="rounded-full" disabled={saving}>
          {saving ? "저장 중..." : label}
        </Button>
      </div>
    </div>,
    document.body,
  );
}
