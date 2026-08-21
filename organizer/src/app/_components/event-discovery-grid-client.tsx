"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, MapPin, Store, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EVENT_TYPE_LABELS } from "@/lib/constants";
import { formatDate } from "@/lib/format";

const PICKKET_MARKET_URL = "https://pickket.kr";

export interface EventCardData {
  id: string;
  slug: string;
  title: string;
  startsAt: string | null;
  venueName: string | null;
  heroImageUrl: string | null;
  eventType: string;
  attendeeCount: number;
}

interface Props {
  events: EventCardData[];
  types: Array<[string, string]>;
  /**
   * W2-PUB: v2 공개 목록 조회 실패. "판매중 이벤트 0건"과 **반드시 구분**해서 안내한다
   * (조용한 빈 목록은 판매중 이벤트가 사라진 화면을 정상처럼 보이게 한다).
   */
  degraded?: boolean;
}

const ALL_KEY = "__all__";

export function EventDiscoveryGridClient({ events, types, degraded = false }: Props) {
  const [selected, setSelected] = useState<string>(ALL_KEY);

  const filtered = useMemo(() => {
    if (selected === ALL_KEY) return events;
    return events.filter((e) => e.eventType === selected);
  }, [events, selected]);

  return (
    <section id="events" className="mx-auto max-w-7xl px-6 py-4 lg:px-10">
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Badge variant="secondary" className="mb-4">live events</Badge>
          <h2 className="text-3xl font-black tracking-[-0.04em] text-foreground">진행 중인 이벤트</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            PICKKET 마켓에서 더 많은 이벤트를 만나보세요.
          </p>
        </div>
        <Link
          href={PICKKET_MARKET_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 self-start rounded-full border border-primary/30 bg-primary/5 px-4 py-2 text-sm font-semibold text-primary transition-all hover:-translate-y-0.5 hover:border-primary hover:bg-primary hover:text-primary-foreground hover:shadow-lg hover:shadow-primary/20 sm:self-auto"
        >
          <Store className="size-4" />
          PICKKET 마켓에서 전체 보기
          <ArrowUpRight className="size-4" />
        </Link>
      </div>

      <div className="mb-8 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setSelected(ALL_KEY)}
          className={`rounded-full border px-3.5 py-1.5 text-xs transition ${
            selected === ALL_KEY
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border bg-muted text-muted-foreground hover:border-primary/40 hover:text-foreground"
          }`}
        >
          전체
        </button>
        {types.map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setSelected(key)}
            className={`rounded-full border px-3.5 py-1.5 text-xs transition ${
              selected === key
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-muted text-muted-foreground hover:border-primary/40 hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {filtered.map((event) => (
          <Link key={event.id} href={`/e/${event.slug}`} className="flex">
            <Card className="flex h-full w-full flex-col overflow-hidden border-border bg-card/95 transition hover:-translate-y-1 hover:border-primary/40">
              <div
                className="h-40 shrink-0 bg-cover bg-center"
                style={{
                  backgroundImage: event.heroImageUrl
                    ? `url(${event.heroImageUrl})`
                    : "linear-gradient(135deg,rgba(30,42,120,0.92),rgba(74,91,196,0.82),rgba(0,201,167,0.72))",
                }}
              />
              <CardHeader className="flex-1">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-[10px]">
                    {EVENT_TYPE_LABELS[event.eventType as keyof typeof EVENT_TYPE_LABELS] ?? event.eventType}
                  </Badge>
                  {event.attendeeCount > 0 ? (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Users className="size-3" />
                      {event.attendeeCount.toLocaleString("ko-KR")}명 참여
                    </span>
                  ) : null}
                </div>
                <CardTitle className="mt-2 line-clamp-2 min-h-[calc(2*1.5rem)] text-base leading-6">
                  {event.title}
                </CardTitle>
                <CardDescription>{formatDate(event.startsAt) || "일정 미정"}</CardDescription>
              </CardHeader>
              <CardContent className="flex items-center gap-2 text-sm text-muted-foreground">
                <MapPin className="size-4 shrink-0 text-primary" />
                <span className="line-clamp-1">{event.venueName ?? "장소 미정"}</span>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="py-12 text-center text-muted-foreground">
          {degraded
            ? "이벤트 목록을 불러오지 못했습니다. 잠시 후 새로고침해주세요."
            : selected === ALL_KEY
              ? "현재 진행 중인 이벤트가 없습니다."
              : "이 카테고리에 해당하는 이벤트가 없습니다."}
        </p>
      ) : (
        <div className="mt-12 flex justify-center">
          <Link
            href={PICKKET_MARKET_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="group inline-flex items-center gap-3 rounded-full bg-gradient-to-r from-primary to-accent px-8 py-4 text-base font-bold text-primary-foreground shadow-lg shadow-primary/25 transition-all hover:-translate-y-0.5 hover:shadow-xl hover:shadow-primary/40"
          >
            <Store className="size-5" />
            PICKKET 마켓에서 더 많은 이벤트 보기
            <ArrowUpRight className="size-5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
          </Link>
        </div>
      )}
    </section>
  );
}
