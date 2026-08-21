"use client";

import { EventForm } from "@/components/forms/event-form";

export default function CreateEventPage() {
  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted-foreground">이벤트 관리</p>
        <h2 className="mt-2 text-3xl font-black tracking-[-0.04em] text-foreground">새 이벤트</h2>
      </div>

      <EventForm mode="create" />
    </div>
  );
}
