"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Zap,
  UserPlus,
  Music,
  Building,
  Ticket,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { fetchWithAuth } from "@/lib/fetchWithAuth";
import { useToast } from "@/lib/hooks/useToast";

interface FeatureConfig {
  key: string;
  label: string;
  description: string;
  icon: typeof Zap;
  category: string;
}

const FEATURE_CATALOG: FeatureConfig[] = [
  // 판매 & 할당
  // 공정 추첨(sale_mode) 은 티켓 & 좌석 페이지 "판매 방식" 에서 선택하도록 이동됨 — 토글 제거
  // 보류(Phase2 슬림화): v2 연결 시 카탈로그 복원 — bot_detection(봇탐지) 카탈로그 숨김. 페이지/라우트는 보존.
  // 고객 관리
  { key: "group_booking", label: "단체예약", description: "기업/MICE 단체 티켓 관리", icon: UserPlus, category: "고객 관리" },
  // 이벤트 구성
  { key: "participants", label: "출연진 관리", description: "출연진/스피커 정보 등록 및 관리", icon: Music, category: "이벤트 구성" },
  { key: "facilities", label: "시설 관리", description: "행사장 시설 배치 및 관리", icon: Building, category: "이벤트 구성" },
  // 리허설(rehearsal) 은 게시 준비(publish) 페이지 내 도구로 이동 — 상시 토글에서 제외 (Phase2 슬림화)
  // 운영
  // 컴플라이언스(compliance) 는 계정 설정 레벨로 이동 — 이벤트 토글에서 제외 (Phase2 슬림화)
  // 보류(Phase2 슬림화): v2 연결 시 카탈로그 복원 — bridge_page(브릿지페이지) 카탈로그 숨김. 페이지/라우트는 보존.
  // packages(패키지) 는 부가상품 "번들" 필터로 흡수 — 삭제 (Phase2 슬림화)
  // 보류(Phase2 슬림화): v2 연결 시 카탈로그 복원 — final_call(파이널콜) 카탈로그 숨김. 페이지/라우트는 보존.
  { key: "ticket_issuance", label: "수동발권", description: "초대권/관계자 티켓 수동 발행", icon: Ticket, category: "운영" },
];

const CATEGORIES = [...new Set(FEATURE_CATALOG.map((f) => f.category))];

export function FeatureToggles({ eventId }: { eventId: string }) {
  const [enabledFeatures, setEnabledFeatures] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  // 🔴 로드 실패 시 조작 자체를 막는다 (2026-07-29 감사).
  //    이 화면은 토글을 누르면 즉시 **enabledFeatures 배열 전체**를 PUT 한다.
  //    로드가 실패해 빈 배열로 시작하면, 토글 하나를 켜는 순간 그 하나만 남고
  //    이미 켜져 있던 기능이 전부 꺼진다.
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const { addToast } = useToast();

  const fetchFeatures = useCallback(async () => {
    try {
      const res = await fetchWithAuth<{ success: boolean; data: { enabledFeatures: string[] } }>(`/api/events/${eventId}/features`);
      if (!res.success) throw new Error("기능 설정을 불러오지 못했습니다");
      setEnabledFeatures(res.data.enabledFeatures);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    fetchFeatures();
  }, [fetchFeatures]);

  const toggleFeature = async (featureKey: string) => {
    if (loadFailed || saving) return;
    const isEnabled = enabledFeatures.includes(featureKey);
    const prev = [...enabledFeatures]; // race condition 방지: 이전 상태 캡처
    const updated = isEnabled
      ? enabledFeatures.filter((f) => f !== featureKey)
      : [...enabledFeatures, featureKey];

    setEnabledFeatures(updated);
    setSaving(true);

    try {
      const res = await fetchWithAuth<{ success: boolean; data: { enabledFeatures: string[] } }>(`/api/events/${eventId}/features`, {
        method: "PUT",
        body: JSON.stringify({ enabledFeatures: updated }),
      });

      if (res.success) {
        setEnabledFeatures(res.data.enabledFeatures); // 서버 응답으로 확정
        addToast({
          message: `${FEATURE_CATALOG.find((f) => f.key === featureKey)?.label ?? featureKey}이(가) ${isEnabled ? "비활성화" : "활성화"}되었습니다.`,
          variant: "success",
        });
      } else {
        setEnabledFeatures(prev);
        addToast({ message: "기능 변경에 실패했습니다.", variant: "error" });
      }
    } catch {
      setEnabledFeatures(prev);
      addToast({ message: "네트워크 오류가 발생했습니다.", variant: "error" });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="rounded-lg border border-border bg-card p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-6 w-48 rounded bg-bg-muted" />
          <div className="h-4 w-72 rounded bg-bg-muted" />
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card p-6">
      {loadFailed ? (
        <div className="mb-6 rounded-lg border border-error/30 bg-error/5 p-4 text-sm text-error">
          현재 켜져 있는 기능을 불러오지 못했습니다. 이 상태로 토글하면 <strong>이미 켜둔 기능이
          모두 꺼질 수 있어</strong> 조작을 잠갔습니다. 새로고침해 주세요.
        </div>
      ) : null}
      <div className="mb-6">
        <h3 className="text-xl font-bold text-foreground">기능 관리</h3>
        <p className="mt-1 text-sm text-content-subtle">
          필요한 기능만 켜세요. 켜면 사이드바에 메뉴가 나타나고, 끄면 사라집니다.
        </p>
      </div>

      <div className="space-y-8">
        {CATEGORIES.map((category) => {
          const features = FEATURE_CATALOG.filter((f) => f.category === category);
          return (
            <div key={category}>
              <h4 className="mb-3 text-sm font-semibold uppercase tracking-wider text-content-subtle">{category}</h4>
              <div className="space-y-2">
                {features.map((feature) => {
                  const Icon = feature.icon;
                  const isEnabled = enabledFeatures.includes(feature.key);
                  return (
                    <label
                      key={feature.key}
                      className={`flex w-full cursor-pointer items-center gap-4 rounded-lg border px-4 py-3 text-left transition ${
                        isEnabled
                          ? "border-primary/30 bg-primary/5"
                          : "border-border bg-card hover:border-border-emphasis"
                      } ${saving ? "cursor-not-allowed opacity-50" : ""}`}
                    >
                      <div
                        className={`flex size-9 items-center justify-center rounded-lg ${
                          isEnabled ? "bg-primary/10 text-primary" : "bg-bg-muted text-content-muted"
                        }`}
                      >
                        <Icon className="size-4" />
                      </div>
                      <div className="flex-1">
                        <p className={`text-sm font-medium ${isEnabled ? "text-foreground" : "text-content-subtle"}`}>
                          {feature.label}
                        </p>
                        <p className="text-xs text-content-muted">{feature.description}</p>
                      </div>
                      <Switch
                        checked={isEnabled}
                        onCheckedChange={() => toggleFeature(feature.key)}
                        disabled={saving}
                        aria-label={`${feature.label} ${isEnabled ? "끄기" : "켜기"}`}
                      />
                    </label>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {enabledFeatures.length > 0 && (
        <div className="mt-6 rounded-lg bg-bg-muted px-4 py-3">
          <p className="text-xs text-content-subtle">
            활성화된 기능 {enabledFeatures.length}개 — 사이드바에서 관련 메뉴를 확인하세요.
          </p>
        </div>
      )}
    </div>
  );
}
