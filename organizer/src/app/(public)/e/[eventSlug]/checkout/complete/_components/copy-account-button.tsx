"use client";

/**
 * 입금 계좌 복사 — 무통장 입금 대기 화면의 **주 행동**.
 *
 * 지금 손님이 할 일은 은행 앱을 열어 계좌번호를 붙여넣는 것 하나뿐이다.
 * 그런데 종전 주 버튼은 「티켓 확인하기」였고, 눌러도 아직 없는 티켓을 찾으러 갔다.
 *
 * ⚠️ **계좌번호만 복사한다.** 은행 앱은 은행을 따로 고르게 하므로 은행명·예금주까지
 *    붙으면 손님이 지워야 한다.
 * ⚠️ 클립보드가 막힌 환경(구형 브라우저·비보안 컨텍스트)이 있으므로 **실패를 삼키지 않고**
 *    번호를 그대로 보여준다 — 손으로라도 옮겨 적을 수 있어야 한다.
 */
import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

export function CopyAccountButton({ account, label }: { account: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(account);
      setState("copied");
      // 잠시 뒤 원래대로 — 눌렀다는 사실만 알리고 자리를 계속 먹지 않는다.
      setTimeout(() => setState("idle"), 2000);
    } catch {
      setState("failed");
    }
  }

  return (
    <div className="flex flex-col items-center gap-1">
      <Button type="button" className="min-w-48" onClick={() => void copy()}>
        {state === "copied" ? (
          <Check className="mr-2 size-4" aria-hidden="true" />
        ) : (
          <Copy className="mr-2 size-4" aria-hidden="true" />
        )}
        {state === "copied" ? "복사했습니다" : label}
      </Button>
      {state === "failed" ? (
        <p className="text-xs text-content-muted" role="status">
          복사가 지원되지 않습니다 — 위 계좌번호를 직접 입력해 주세요.
        </p>
      ) : null}
    </div>
  );
}
