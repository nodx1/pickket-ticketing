"use client";

import { EventForm } from "@/components/forms/event-form";

export default function CreateEventPage() {
  return (
    // 넓은 화면에서 입력칸이 화면 끝까지 늘어나 읽기 어려웠다 — 폼 폭을 줄이고 가운데에 둔다.
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <div>
        <p className="text-sm text-muted-foreground">이벤트 관리</p>
        <h2 className="mt-2 text-3xl font-black tracking-[-0.04em] text-foreground">새 이벤트</h2>
      </div>

      <EventForm mode="create" />
    </div>
  );
}
