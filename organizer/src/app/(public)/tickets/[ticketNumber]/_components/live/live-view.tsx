"use client";

/**
 * 대회 라이브 화면 — 입장한 갤러리가 **티켓 링크 그대로** 대회 상황을 본다.
 *
 * ## 🔴 상태 판정은 여기 한 곳에서만 한다
 * `summary.state` 를 보고 LIVE 표시·안내 문구를 정한다. 각 탭은 **받은 값을 그리기만**
 * 한다 — 탭마다 따로 판단하면 같은 데이터를 두고 화면이 서로 다른 말을 한다.
 *
 * ## 🔴 티켓 탭은 어떤 경우에도 살아 있어야 한다
 * 라이브가 못 뜨는 상황(라우트 미배포·네트워크 단절)에서 **티켓까지 못 보면** 그게 사고다.
 * 그래서 요약이 없어도 탭 구조와 티켓 패널은 그대로 렌더한다.
 */
import { useState } from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { CalendarDays, House, Ticket, Trophy, Users } from "lucide-react";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { isLiveIndicatorOn, liveNotices } from "@/lib/live/presentation";
import { isSpectatorSafe } from "@/lib/live/gate";
import { useLiveSummary } from "@/lib/live/use-live-summary";
import type { EventScheduleItem } from "@/lib/v2/event-schedules";
import { LiveGroups } from "./live-groups";
import { LiveHome } from "./live-home";
import { LiveLeaderboard } from "./live-leaderboard";
import { LiveSchedule } from "./live-schedule";

export interface LiveViewProps {
  ticketNumber: string;
  /**
   * 🔴 주최자 리허설 미리보기 전용 — 티켓 대신 **행사 id** 로 읽는다.
   *
   * 8/6~8/19 는 다른 대회의 실제 스코어가 `is_rehearsal: true` 로 온다.
   * 관중 경로(`?ticket=`)는 그걸 걸러내므로 **우리도 화면을 볼 수 없다.**
   * 그래서 주최자 인증 경로를 따로 둔다 — **경로가 곧 권한**이다.
   *
   * ⚠️ 이 값은 **서버에서만** 넘어온다(대시보드 페이지). 공개 티켓 경로는 안 넘긴다.
   */
  organizerEventId?: string;
  eventTitle: string;
  /** 티켓 탭 내용 — 초대권/유료가 각자 다르므로 페이지가 넘긴다. */
  ticketPanel: React.ReactNode;
  /** 주최자가 등록한 행사 안내(우리 데이터). */
  schedules?: EventScheduleItem[];
}

type TabId = "home" | "leaderboard" | "groups" | "schedule" | "ticket";

const TABS: Array<{ id: TabId; label: string; Icon: typeof House }> = [
  // 🔴 티켓이 맨 앞 — 게이트에서 제일 급한 것이다.
  { id: "ticket", label: "티켓", Icon: Ticket },
  { id: "home", label: "홈", Icon: House },
  { id: "leaderboard", label: "리더보드", Icon: Trophy },
  { id: "groups", label: "조편성", Icon: Users },
  { id: "schedule", label: "이벤트", Icon: CalendarDays },
];

/**
 * 🔴 하단 탭바 높이 + 아이폰 홈 인디케이터 안전영역.
 *
 * 본문 아래 여백을 이 값으로 잡는다 — 안 잡으면 **마지막 항목이 탭바에 가려** 손님이
 * 스크롤 끝에서 무엇을 놓쳤는지도 모른다.
 */
const TABBAR_SPACE_CLASS = "pb-[calc(4.25rem_+_env(safe-area-inset-bottom))]";

export function LiveView({
  ticketNumber,
  organizerEventId,
  eventTitle,
  ticketPanel,
  schedules = [],
}: LiveViewProps) {
  const { summary, loading, failing } = useLiveSummary(
    organizerEventId ? { kind: "organizer", eventId: organizerEventId } : ticketNumber,
  );
  // 🔴 입장한 손님이 티켓 링크로 들어오면 **티켓이 먼저** 보여야 한다 (2026-08-20 현장).
  //    종전 기본값은 "home" 이라, 재입장 때 손님이 5번째 탭을 찾아 눌러야 QR 이 나왔다.
  //    게이트에서 줄이 서는 원인이다 — 라이브는 보고 싶으면 누르면 된다.
  const [tab, setTab] = useState<TabId>("ticket");


  /**
   * 🔴 **리허설 데이터는 관중에게 한 조각도 내보내지 않는다.**
   *
   * 8/6~8/19 에는 다른 대회의 실제 스코어가 온다. BC카드 티켓에 제주삼다수 순위가
   * 뜨면 빈 화면보다 나쁘다. `isSpectatorSafe` 가 아니면 요약을 **아예 안 쓴다** —
   * 여기서 한 번 걸러 아래 모든 탭이 자동으로 비어 있게 만든다(탭마다 판단하지 않는다).
   */
  // 🔴 리허설 통과는 **주최자 경로에서만**. 관중 경로는 그대로 막힌다.
  //    `organizerEventId` 는 서버(대시보드 페이지)에서만 넘어오고, 그 경로 자체가
  //    로그인 뒤에 있다 — 쿼리·헤더로는 켜지지 않는다.
  const safe = summary !== null && (organizerEventId !== undefined || isSpectatorSafe(summary));
  const live = safe ? summary : null;

  /**
   * 「지금」의 기준 시각 — **서버가 준 `updated_at`** 을 쓴다.
   *
   * 🔴 렌더 중 `Date.now()` 는 불순 호출이라 리렌더마다 결과가 흔들린다(React 컴파일러가 막는다).
   *    그렇다고 이펙트로 시계를 돌리면 렌더가 연쇄한다 — 20초마다 도는 폴링이 이미
   *    같은 신호를 주므로 그 값을 그대로 쓴다.
   *
   * ⚠️ 요약이 없으면 `0`(=모름)이다. 호출부는 0 을 시각으로 쓰지 않고 **판단을 보류**한다 —
   *    0 을 1970년으로 읽으면 모든 일정이 「종료」로 보인다.
   */
  const now = live ? Date.parse(live.updated_at) || 0 : 0;

  const liveOn = live !== null && isLiveIndicatorOn(live.status, live.stale);
  const notices = live !== null ? liveNotices(live.status, live.stale, live.content_age_sec) : [];

  return (
    <div className={`min-h-screen bg-background px-4 py-6 ${TABBAR_SPACE_CLASS}`}>
      <div className="mx-auto max-w-md space-y-4">
        <header className="space-y-1">
          <div className="flex items-center gap-2">
            {/* 🔴 stale 이면 초록 점을 끈다 — 멈춘 데이터를 "실시간" 으로 보여주면
                관중이 잘못된 위치로 이동한다(스펙 §6-1). */}
            {liveOn ? (
              <span className="flex items-center gap-1.5" data-testid="live-indicator">
                <span className="size-2 animate-pulse rounded-full bg-success" aria-hidden="true" />
                <span className="text-xs font-bold text-success">LIVE</span>
              </span>
            ) : null}
            <h1 className="min-w-0 flex-1 truncate text-base font-black tracking-[-0.02em] text-foreground">
              {live?.tournament.name?.trim() || eventTitle}
            </h1>
          </div>
        </header>

        {notices.map((n) => (
          <div
            key={n.title}
            role="status"
            data-testid={`live-notice-${n.tone}`}
            className={`rounded-lg border p-3 text-sm ${
              n.tone === "warn" ? "border-warning/40 bg-warning/5" : "border-border bg-card"
            }`}
          >
            <p className="font-semibold text-foreground">{n.title}</p>
            <p className="mt-0.5 text-xs text-content-subtle">{n.body}</p>
          </div>
        ))}

        {loading && !live ? (
          <p className="rounded-lg border border-border bg-card px-4 py-6 text-center text-sm text-content-muted">
            대회 정보를 불러오는 중입니다…
          </p>
        ) : null}

        {!loading && !live ? (
          // 🔴 라이브를 못 받아도 티켓은 봐야 한다. 아래 탭에서 「티켓」이 그대로 열린다.
          // ⚠️ 리허설도 이 문구로 떨어진다 — 관중에게 "리허설 중" 이라고 밝히지 않는다.
          //    발주처 대회 페이지에서 다른 대회 준비 사정을 알릴 이유가 없다.
          <p className="rounded-lg border border-border bg-card px-4 py-6 text-center text-sm text-content-muted">
            대회 정보를 준비하고 있습니다. 아래 「티켓」에서 입장 정보를 확인하실 수 있습니다.
          </p>
        ) : null}

        <Tabs value={tab} onValueChange={(v) => setTab(v as TabId)}>

          <TabsContent value="home" className="mt-4">
            {live ? (
              <LiveHome
                summary={live}
                schedules={schedules}
                onSeeGroups={() => setTab("groups")}
                onSeeSchedule={() => setTab("schedule")}
                now={now}
              />
            ) : null}
          </TabsContent>

          <TabsContent value="leaderboard" className="mt-4">
            {live ? <LiveLeaderboard leaders={live.leaders} /> : null}
          </TabsContent>

          <TabsContent value="groups" className="mt-4">
            {live ? <LiveGroups groups={live.groups} /> : null}
          </TabsContent>

          <TabsContent value="schedule" className="mt-4">
            <LiveSchedule items={schedules} now={now} />
          </TabsContent>

          <TabsContent value="ticket" className="mt-4">
            {ticketPanel}
          </TabsContent>
          {/*
            🔴 **하단 고정 탭바** — 한 손으로 든 폰에서 엄지가 닿는 곳이다.
               골프장에서 **서서 보는** 화면이라 상단 탭은 반대쪽 손을 쓰게 만든다.
            ⚠️ 공용 `TabsList`(알약형 세그먼트)를 안 쓴다 — 성격이 다른 컴포넌트다.
               거기 스타일을 덮어쓰기 시작하면 다음 사람이 어느 쪽이 정본인지 모른다.
            🔴 `env(safe-area-inset-bottom)` — 아이폰 홈 인디케이터에 겹치면 마지막 탭이 안 눌린다.
          */}
          <TabsPrimitive.List
            data-testid="live-tabbar"
            aria-label="대회 화면"
            className="fixed inset-x-0 bottom-0 z-50 grid grid-cols-5 border-t border-border bg-card/95 backdrop-blur pb-[env(safe-area-inset-bottom)]"
          >
            {TABS.map((t) => (
              <TabsPrimitive.Trigger
                key={t.id}
                value={t.id}
                className="flex flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-semibold text-content-muted transition-colors data-[state=active]:text-primary"
              >
                <t.Icon className="size-5" aria-hidden="true" />
                {t.label}
              </TabsPrimitive.Trigger>
            ))}
          </TabsPrimitive.List>
        </Tabs>

        {failing && live ? (
          <p className="text-center text-[11px] text-content-muted">
            갱신이 지연되고 있습니다. 위 내용은 마지막으로 받은 값입니다.
          </p>
        ) : null}
      </div>
    </div>
  );
}
