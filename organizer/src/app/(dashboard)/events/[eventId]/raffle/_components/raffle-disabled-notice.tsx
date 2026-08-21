"use client";

// 🔴 2026-07-27 prod 실결함: 이 파일이 **서버 컴포넌트**인 채로 `EmptyState`(클라이언트 컴포넌트)에
//    `icon={Gift}` 를 넘겨, 경품 추첨이 **꺼진 이벤트**의 추첨 페이지가 통째로
//    "페이지를 불러오는 중 문제가 발생했습니다" 로 추락했다.
//    Next.js 는 서버→클라이언트 경계에서 **함수(컴포넌트)를 prop 으로 직렬화할 수 없다**.
//    prod 빌드는 원인 메시지를 숨기므로("The specific message is omitted…") 화면·로그 어디에도
//    단서가 없었다 — 전수 스윕에서 이 페이지만 추락하는 것으로 발견했다.
//    ⟹ 이 안내 컴포넌트 자체를 클라이언트로 내려 경계를 없앤다.
import Link from "next/link";
import { Gift } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";

// raffle_enabled 아닌 이벤트 진입 시 안내 — 설정에서 경품 추첨을 켜도록 유도.
export function RaffleDisabledNotice({ eventId }: { eventId: string }) {
  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-content-subtle">현장 운영</p>
        <h2 className="mt-2 text-3xl font-black tracking-[-0.04em] text-foreground">경품 추첨</h2>
      </div>
      <EmptyState
        icon={Gift}
        title="경품 추첨이 활성화되지 않았습니다"
        description="이 이벤트에서 경품 추첨을 실행하려면 이벤트 설정에서 경품 추첨을 먼저 켜주세요. 체크인 완료자를 대상으로 공개 시드 기반 추첨을 실행할 수 있습니다."
      />
      <div className="flex justify-center">
        <Button asChild>
          <Link href={`/events/${eventId}/settings`}>이벤트 설정으로 이동</Link>
        </Button>
      </div>
    </div>
  );
}
