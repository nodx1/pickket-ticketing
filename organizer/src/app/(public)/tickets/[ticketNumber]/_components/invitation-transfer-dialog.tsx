"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * 초대권 양도 — 받는 분 정보를 받아 서버가 새 링크를 발송한다.
 *
 * ## 🔴 왜 2단계인가 (입력 → 확인)
 *
 * **되돌릴 수 없는 동작**이다. 넘기는 순간 보낸 분의 링크는 죽고, 되찾으려면 받은 분이
 * 다시 넘겨줘야 한다. 그리고 실제로 가장 잦은 사고는 오타다 — 번호 하나 틀리면
 * 초대권이 **모르는 사람에게** 간다(주최자가 회수해 재발급해야 한다).
 *
 * 그래서 입력 후 "010-1234-5678 님께 넘깁니다" 를 **한 번 더 보여주고** 확인을 받는다.
 * 확인 화면에 번호를 그대로 노출하는 것이 핵심이다 — 요약만 보여주면 오타를 못 잡는다.
 */

type Step = "form" | "confirm" | "done";

function formatPhone(raw: string): string {
  const d = raw.replace(/\D/g, "").slice(0, 11);
  if (d.length <= 3) return d;
  if (d.length <= 7) return `${d.slice(0, 3)}-${d.slice(3)}`;
  if (d.length <= 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
}

export function InvitationTransferDialog({
  ticketNumber,
  token,
  accentColor,
  onClose,
}: {
  ticketNumber: string;
  /** 현재 딥링크 토큰 — 서버가 소지자 증명으로 쓴다. */
  token: string;
  accentColor: string;
  onClose: () => void;
}) {
  const [step, setStep] = useState<Step>("form");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [doneMessage, setDoneMessage] = useState("");

  const digits = phone.replace(/\D/g, "");
  const canProceed = name.trim().length > 0 && /^01\d{8,9}$/.test(digits);

  async function submit() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/public/tickets/${encodeURIComponent(ticketNumber)}/transfer`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, toName: name.trim(), toPhone: digits }),
        },
      );
      const json = (await res.json()) as {
        success?: boolean;
        data?: { message?: string };
        error?: string | { message?: string };
      };
      if (!res.ok || json.success === false) {
        const msg =
          typeof json.error === "string"
            ? json.error
            : json.error?.message ?? "양도에 실패했습니다. 잠시 후 다시 시도해주세요";
        setError(msg);
        // 🔴 실패하면 **입력 화면으로 되돌린다**. 확인 화면에 머무르면 손님이 같은 버튼을
        //    계속 눌러 레이트리밋에 걸린다.
        setStep("form");
        return;
      }
      setDoneMessage(json.data?.message ?? "초대권을 보냈습니다.");
      setStep("done");
    } catch {
      setError("네트워크 오류입니다. 잠시 후 다시 시도해주세요");
      setStep("form");
    } finally {
      setPending(false);
    }
  }

  if (step === "done") {
    return (
      <div className="rounded-lg border border-border bg-background p-5">
        <p className="text-base font-semibold text-content-emphasis">양도 완료</p>
        <p className="mt-2 text-sm text-content-default">{doneMessage}</p>
        <p className="mt-3 text-xs text-content-subtle">
          이 화면의 초대권은 더 이상 사용할 수 없습니다. 받는 분께 알림톡으로 새 초대권이
          전달됩니다.
        </p>
        <Button
          className="mt-4 w-full rounded-full"
          style={{ backgroundColor: accentColor }}
          onClick={() => window.location.reload()}
        >
          확인
        </Button>
      </div>
    );
  }

  if (step === "confirm") {
    return (
      <div className="rounded-lg border border-border bg-background p-5">
        <p className="text-base font-semibold text-content-emphasis">
          이 분께 초대권을 넘길까요?
        </p>
        {/* 🔴 번호를 그대로 보여준다 — 요약만 보여주면 오타를 못 잡는다. */}
        <div className="mt-3 rounded-lg bg-muted px-4 py-3">
          <p className="text-lg font-semibold text-content-emphasis">{name.trim()}</p>
          <p className="mt-0.5 text-base tabular-nums text-content-default">
            {formatPhone(digits)}
          </p>
        </div>
        <p className="mt-3 text-sm text-content-default">
          넘기면 <b>회원님의 초대권은 즉시 사용할 수 없습니다.</b> 되돌리려면 받는 분이
          다시 넘겨주셔야 합니다.
        </p>
        <div className="mt-4 flex gap-2">
          <Button
            variant="outline"
            className="flex-1 rounded-full"
            onClick={() => setStep("form")}
            disabled={pending}
          >
            다시 입력
          </Button>
          <Button
            className="flex-1 rounded-full"
            style={{ backgroundColor: accentColor }}
            onClick={submit}
            disabled={pending}
          >
            {pending ? "보내는 중…" : "넘기기"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-background p-5">
      <p className="text-base font-semibold text-content-emphasis">초대권 양도</p>
      <p className="mt-1 text-sm text-content-subtle">
        받는 분께 알림톡으로 새 초대권이 발송됩니다.
      </p>
      <div className="mt-4 space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="transfer-name">받는 분 성함</Label>
          <Input
            id="transfer-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="홍길동"
            maxLength={50}
            autoComplete="name"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="transfer-phone">받는 분 휴대폰 번호</Label>
          <Input
            id="transfer-phone"
            value={phone}
            onChange={(e) => setPhone(formatPhone(e.target.value))}
            placeholder="010-1234-5678"
            inputMode="numeric"
            autoComplete="tel"
          />
          <p className="text-xs text-content-subtle">
            이 번호로 초대권이 전송됩니다. 번호를 정확히 확인해주세요.
          </p>
        </div>
      </div>
      {error && (
        <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>
      )}
      <div className="mt-4 flex gap-2">
        <Button variant="outline" className="flex-1 rounded-full" onClick={onClose}>
          취소
        </Button>
        <Button
          className="flex-1 rounded-full"
          style={{ backgroundColor: accentColor }}
          onClick={() => setStep("confirm")}
          disabled={!canProceed}
        >
          다음
        </Button>
      </div>
    </div>
  );
}
