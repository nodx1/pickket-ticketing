"use client";

import { useEffect, useRef, useState } from "react";
import { Activity, TrendingUp, Users, Ticket } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatKRW } from "@/lib/format";

interface LiveData {
  orders: number;
  revenue: number;
  totalAttendees: number;
  checkedIn: number;
  totalStock: number;
  remaining: number;
  timestamp: string;
}

export function LiveStats({ eventId }: { eventId: string }) {
  const [data, setData] = useState<LiveData | null>(null);
  const [connected, setConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource(`/api/events/${eventId}/live`);
    eventSourceRef.current = es;

    es.addEventListener("stats", (event) => {
      try {
        const parsed = JSON.parse(event.data) as LiveData;
        setData(parsed);
        setConnected(true);
      } catch {
        // ignore parse errors
      }
    });

    es.onerror = () => {
      setConnected(false);
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [eventId]);

  if (!data) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center p-8">
          <p className="text-sm text-muted-foreground">실시간 데이터 연결 중...</p>
        </CardContent>
      </Card>
    );
  }

  const soldOutWarning = data.totalStock > 0 && data.remaining <= data.totalStock * 0.1;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h3 className="text-lg font-bold text-foreground">실시간 현황</h3>
        <Badge variant={connected ? "default" : "outline"} className="text-xs">
          <Activity className="mr-1 size-3" />
          {connected ? "LIVE" : "연결 끊김"}
        </Badge>
      </div>

      {soldOutWarning && (
        <div className="rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm font-medium text-warning">
          매진 임박! 잔여 {data.remaining}석 ({data.totalStock > 0 ? Math.round((data.remaining / data.totalStock) * 100) : 0}%)
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={TrendingUp}
          label="매출"
          value={formatKRW(data.revenue)}
        />
        <StatCard
          icon={Ticket}
          label="주문"
          value={`${data.orders}건`}
        />
        <StatCard
          icon={Users}
          label="체크인"
          value={`${data.checkedIn} / ${data.totalAttendees}`}
        />
        <StatCard
          icon={Ticket}
          label="잔여석"
          value={`${data.remaining} / ${data.totalStock}`}
        />
      </div>
    </div>
  );
}

function StatCard({ icon: Icon, label, value }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm text-muted-foreground">
          <Icon className="size-4" />
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-black tracking-[-0.04em] text-foreground">{value}</p>
      </CardContent>
    </Card>
  );
}
