"use client";

import { useEffect, useRef } from "react";

/**
 * 미저장 변경 이탈 경고 훅.
 *
 * dirty=true 인 동안 탭 닫기/새로고침/외부 이동 시 브라우저 확인창을 띄운다.
 * Next.js 클라이언트 네비게이션(<Link>)은 beforeunload 로 잡히지 않으므로,
 * 문서 레벨 클릭 캡처로 앵커 이동을 가로채 confirm 한다(디자이너·장문 에디터용 실용 절충).
 *
 * 사용: 저장 성공 시 dirty 를 false 로 되돌리는 것을 잊지 말 것.
 */
export function useUnsavedChanges(dirty: boolean, message = "저장하지 않은 변경사항이 있습니다. 이동할까요?") {
  const dirtyRef = useRef(dirty);
  // 렌더 중 ref 쓰기 금지(react-hooks/set-state-in-render) — effect 에서 최신값 동기화.
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  useEffect(() => {
    function onBeforeUnload(event: BeforeUnloadEvent) {
      if (!dirtyRef.current) return;
      event.preventDefault();
      // Chrome 은 returnValue 설정 필요(레거시 계약)
      event.returnValue = "";
    }

    function onClickCapture(event: MouseEvent) {
      if (!dirtyRef.current) return;
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; // 새 탭 열기는 현재 작업을 잃지 않음
      const anchor = (event.target as HTMLElement | null)?.closest("a[href]");
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";
      if (href.startsWith("#") || anchor.getAttribute("target") === "_blank") return;
      // window.confirm 은 라우터 이탈 가드의 유일한 동기 차단 수단(Next App Router 공식 API 부재).
      if (!window.confirm(message)) {
        event.preventDefault();
        event.stopPropagation();
      }
    }

    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClickCapture, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClickCapture, true);
    };
  }, [message]);
}
