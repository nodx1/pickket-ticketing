"use client";

import { useEffect, useMemo, useState } from "react";
import { mergeKeepingManualPortrait } from "@/lib/images/merge-variants";
import { fetchWithRefresh } from "@/lib/fetchWithAuth";
import { useRouter } from "next/navigation";
import { useUnsavedChanges } from "@/lib/hooks/useUnsavedChanges";
import { z } from "zod";
import { ImageUpload } from "@/components/shared/image-upload";
import { GalleryUpload, type GalleryItem } from "@/components/shared/gallery-upload";
import { GALLERY_MAX_IMAGES } from "@/lib/public/gallery-item";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { OrganizerRoleSelector, type OrganizerEntry } from "@/components/forms/_components/organizer-role-selector";
import {
  AGE_RATING_LABELS,
  EVENT_STATUS,
  EVENT_TYPE_LABELS,
  EVENT_TYPES,
} from "@/lib/constants";
import { showError } from "@/lib/hooks/useToast";
import { slugify } from "@/lib/slug";

const eventSchema = z.object({
  title: z.string().min(2, "이벤트 제목은 2자 이상이어야 합니다"),
  slug: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  startsAt: z.string().min(1, "시작 일시는 필수입니다"),
  endsAt: z.string().min(1, "종료 일시는 필수입니다"),
  venueName: z.string().optional(),
  venueAddress: z.string().optional(),
  eventType: z.enum(EVENT_TYPES),
  ageRating: z.string().min(1, "연령 제한을 선택해주세요"),
  maxAttendees: z.string().optional(),
  isOnline: z.boolean(),
  status: z.enum(EVENT_STATUS),
  heroImageUrl: z.string().optional(),
  transportInfo: z.string().optional(),
  programNotes: z.string().optional(),
  stageInfo: z.string().optional(),
  parkingInfo: z.string().optional(),
  rsvpEnabled: z.boolean().optional(),
  groupBookingEnabled: z.boolean().optional(),
  contextBanner: z.string().optional(),
  admissionMode: z.enum(["single", "daypass", "allpass"]),
  seatType: z.enum(["assigned", "unassigned"]),
  raffleEnabled: z.boolean(),
});

interface OrganizerOption {
  id: string;
  name: string;
}

export interface EventFormValue {
  organizerId: string;
  organizers: OrganizerEntry[];
  title: string;
  slug: string;
  summary: string;
  description: string;
  startsAt: string;
  endsAt: string;
  venueName: string;
  venueAddress: string;
  eventType: "concert" | "festival" | "conference" | "exhibition" | "mice" | "workshop" | "fan_meeting" | "flea_market" | "lecture" | "preview" | "local_festival" | "party" | "networking";
  ageRating: string;
  maxAttendees: string;
  isOnline: boolean;
  status: (typeof EVENT_STATUS)[number];
  heroImageUrl: string;
  imageVariants: Record<string, string> | null;
  galleryImages: GalleryItem[];
  transportInfo: string;
  programNotes: string;
  stageInfo: string;
  parkingInfo: string;
  runtimeMinutes: number | null;
  intermissionMinutes: number | null;
  rsvpEnabled: boolean;
  groupBookingEnabled: boolean;
  contextBanner: string;
  admissionMode: "single" | "daypass" | "allpass";
  /** 좌석 판매 방식 — assigned=지정석(배치도), unassigned=자유입장(등급 수량만). */
  seatType: "assigned" | "unassigned";
  raffleEnabled: boolean;
}

const emptyValue: EventFormValue = {
  organizerId: "",
  organizers: [],
  title: "",
  slug: "",
  summary: "",
  description: "",
  startsAt: "",
  endsAt: "",
  venueName: "",
  venueAddress: "",
  eventType: "conference",
  ageRating: "all",
  maxAttendees: "",
  isOnline: false,
  status: "draft",
  heroImageUrl: "",
  imageVariants: null,
  galleryImages: [],
  transportInfo: "",
  programNotes: "",
  stageInfo: "",
  parkingInfo: "",
  runtimeMinutes: null,
  intermissionMinutes: null,
  rsvpEnabled: false,
  groupBookingEnabled: false,
  contextBanner: "",
  admissionMode: "single",
  seatType: "assigned",
  raffleEnabled: false,
};

interface EventFormProps {
  mode: "create" | "edit";
  eventId?: string;
  initialValue?: Partial<EventFormValue>;
}

export function EventForm({ mode, eventId, initialValue }: EventFormProps) {
  const router = useRouter();
  const [organizers, setOrganizers] = useState<OrganizerOption[]>([]);
  const [form, setForm] = useState<EventFormValue>({ ...emptyValue, ...initialValue });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // 수정 모드에서만 미저장 이탈 경고를 활성화한다. 생성 모드는 이탈이 자연스럽다.
  useUnsavedChanges(mode === "edit" && dirty);

  const [organizerError, setOrganizerError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function loadOrganizers() {
      try {
        const response = await fetchWithRefresh("/api/organizers", { credentials: "include" });
        if (!response.ok) {
          if (!isMounted) return;
          // 주최자가 아직 없는 새 계정이면 빈 배열로 처리 (403 포함)
          if (response.status === 403) {
            setOrganizerError("주최자 프로필이 없습니다. 먼저 주최자를 등록해주세요.");
          } else {
            setOrganizerError("주최자 목록을 불러오지 못했습니다.");
          }
          setOrganizers([]);
          return;
        }
        const payload = (await response.json()) as { data?: OrganizerOption[] };
        if (!isMounted) return;
        const nextOrganizers = payload.data ?? [];
        setOrganizers(nextOrganizers);
        if (nextOrganizers.length === 0) {
          setOrganizerError("주최자 프로필이 없습니다. 먼저 주최자를 등록해주세요.");
        }
        setForm((prev) => {
          if (prev.organizers.length === 0 && prev.organizerId) {
            return { ...prev, organizers: [{ organizerId: prev.organizerId, role: "host" as const, displayOrder: 0 }] };
          }
          if (prev.organizers.length === 0 && nextOrganizers[0]) {
            return {
              ...prev,
              organizerId: nextOrganizers[0].id,
              organizers: [{ organizerId: nextOrganizers[0].id, role: "host" as const, displayOrder: 0 }],
            };
          }
          return prev;
        });
      } catch {
        if (!isMounted) return;
        setOrganizerError("주최자 목록을 불러오지 못했습니다. 네트워크를 확인해주세요.");
        setOrganizers([]);
      }
    }

    void loadOrganizers();

    return () => {
      isMounted = false;
    };
  }, []);

  /** setForm + 미저장 표시. 사용자가 직접 편집하는 모든 필드 핸들러에서 사용한다. */
  function editForm(updater: Parameters<typeof setForm>[0]) {
    setForm(updater);
    setDirty(true);
  }

  const titleLabel = useMemo(() => (mode === "create" ? "이벤트 만들기" : "이벤트 설정"), [mode]);

  // 다일 이벤트 판정 — 시작·종료 날짜(YYYY-MM-DD)가 다를 때. daypass/allpass 선택 가능 여부의 근거.
  const isMultiDay = useMemo(() => {
    if (!form.startsAt || !form.endsAt) return false;
    return form.startsAt.slice(0, 10) < form.endsAt.slice(0, 10);
  }, [form.startsAt, form.endsAt]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);

    if (!form.organizers.some((o) => o.role === "host")) {
      setSaving(false);
      setError("주최(host) 역할이 최소 1개 필요합니다");
      return;
    }

    const parsed = eventSchema.safeParse(form);
    if (!parsed.success) {
      setSaving(false);
      setError(parsed.error.issues[0]?.message ?? "입력값을 확인해주세요");
      return;
    }

    // F1: 지정일권·전일권은 다일 이벤트에만 사용 가능(종료일이 시작일보다 뒤여야 함).
    if (form.admissionMode !== "single" && !isMultiDay) {
      setSaving(false);
      setError("지정일권·전일권은 다일 이벤트에만 사용할 수 있습니다. 종료 일시를 시작일 다음 날 이후로 설정해주세요.");
      return;
    }

    // 상태는 심사/일시중지/보관 같은 전용 액션으로만 변경되므로 폼 payload 에서 제외.
    const formPayload = {
      organizerId: form.organizers.find((o) => o.role === "host")?.organizerId ?? form.organizerId,
      organizers: form.organizers,
      title: form.title,
      slug: slugify(form.slug || form.title),
      summary: form.summary,
      description: form.description,
      startsAt: form.startsAt,
      endsAt: form.endsAt,
      venueName: form.venueName,
      venueAddress: form.venueAddress,
      eventType: form.eventType,
      ageRating: form.ageRating,
      // maxAttendees 는 좌석 배치도에서 자동 산출되므로 폼 payload 에서 제외
      isOnline: form.isOnline,
      heroImageUrl: form.heroImageUrl,
      // 항상 전송(heroImageUrl 과 동일 정책). 편집 시 기존 맵을 하이드레이트해 왕복하므로 미터치도 안전,
      // 삭제 시 {} 로 클리어가 go DB(NOT NULL DEFAULT '{}') + v2 로 전파됨.
      imageVariants: form.imageVariants ?? {},
      galleryImages: form.galleryImages,
      transportInfo: form.transportInfo,
      programNotes: form.programNotes,
      stageInfo: form.stageInfo,
      parkingInfo: form.parkingInfo,
      runtimeMinutes: form.runtimeMinutes,
      intermissionMinutes: form.intermissionMinutes,
      rsvpEnabled: form.rsvpEnabled,
      groupBookingEnabled: form.groupBookingEnabled,
      // 빈문자열=배너 해제(서버가 null 로 수렴). trim 으로 공백만 입력 방지.
      contextBanner: form.contextBanner.trim(),
      admissionMode: form.admissionMode,
      seatType: form.seatType,
      raffleEnabled: form.raffleEnabled,
    };

    try {
      const response = await fetchWithRefresh(mode === "create" ? "/api/events" : `/api/events/${eventId}`, {
        method: mode === "create" ? "POST" : "PATCH",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(formPayload),
      });

      const payload = (await response.json()) as {
        data?: { id: string };
        error?: string;
      };

      if (!response.ok) {
        throw new Error(payload.error ?? "이벤트 저장에 실패했습니다");
      }

      setDirty(false);

      if (typeof window !== "undefined") {
        window.sessionStorage.setItem(
          "pickket:event-flash",
          mode === "create" ? "이벤트가 생성되었습니다" : "이벤트가 수정되었습니다",
        );
      }

      router.push(mode === "create" ? `/events/${payload.data?.id}/dashboard` : `/events/${eventId}/dashboard`);
      router.refresh();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "이벤트 저장에 실패했습니다";
      setError(message);
      showError(message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="border-border bg-card/95">
      <CardHeader>
        <CardTitle className="text-2xl text-foreground">{titleLabel}</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="space-y-6" onSubmit={handleSubmit}>
          <div className="border-t border-border pt-6 first:border-0 first:pt-0">
            <h3 className="text-lg font-bold text-foreground">기본 정보</h3>
            <p className="mt-1 text-sm text-content-subtle">행사를 식별하는 정보입니다. 제목은 공개 페이지와 티켓에 그대로 쓰입니다.</p>
          </div>

          {organizerError && organizers.length === 0 ? (
            <div className="rounded-lg border border-warning/40 bg-warning/5 p-4 text-sm">
              <p className="font-bold text-warning">{organizerError}</p>
              <p className="mt-1 text-muted-foreground">
                <a href="/organizers" className="font-medium text-primary underline">주최자 관리</a>에서 주최자를 먼저 등록하면 이벤트를 생성할 수 있습니다.
              </p>
            </div>
          ) : (
            <OrganizerRoleSelector
              organizers={organizers}
              value={form.organizers}
              onChange={(organizers) => editForm((prev) => ({ ...prev, organizers }))}
            />
          )}

          <div className="grid gap-5 lg:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="event-title">이벤트 제목</Label>
              <Input
                id="event-title"
                value={form.title}
                onChange={(event) =>
                  editForm((prev) => ({
                    ...prev,
                    title: event.target.value,
                    slug: mode === "create" ? slugify(event.target.value) : (prev.slug ? prev.slug : slugify(event.target.value)),
                  }))
                }
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="event-summary">짧은 소개</Label>
            <Input
              id="event-summary"
              value={form.summary}
              onChange={(event) => editForm((prev) => ({ ...prev, summary: event.target.value }))}
            />
          </div>

          {/* 공개 주소 — 수정 모드에서만 표시, 생성 시 자동 생성 */}
          {mode === "edit" && (
            <div className="space-y-2">
              <Label htmlFor="event-slug">공개 주소</Label>
              <Input
                id="event-slug"
                placeholder="이벤트-제목에서-자동-생성"
                value={form.slug}
                onChange={(event) => editForm((prev) => ({ ...prev, slug: slugify(event.target.value) }))}
              />
              <p className="text-xs text-muted-foreground">
                이벤트 페이지 URL에 사용됩니다. 비워두면 제목에서 자동 생성합니다.
              </p>
            </div>
          )}

          <div className="grid gap-5 lg:grid-cols-4">
            <div className="space-y-2">
              <Label>이벤트 유형</Label>
              <Select
                value={form.eventType}
                onValueChange={(value: EventFormValue["eventType"]) =>
                  editForm((prev) => ({ ...prev, eventType: value }))
                }
              >
                <SelectTrigger aria-label="행사 유형">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(EVENT_TYPE_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>연령 제한</Label>
              <Select
                value={AGE_RATING_LABELS[form.ageRating] ? form.ageRating : "custom"}
                onValueChange={(value) => {
                  if (value === "custom") {
                    editForm((prev) => ({ ...prev, ageRating: "" }));
                  } else {
                    editForm((prev) => ({ ...prev, ageRating: value }));
                  }
                }}
              >
                <SelectTrigger aria-label="연령 제한">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(AGE_RATING_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!AGE_RATING_LABELS[form.ageRating] || form.ageRating === "" ? (
                <Input
                  placeholder="예: 만 5세 이상, 48개월 이상"
                  value={form.ageRating === "custom" ? "" : form.ageRating}
                  onChange={(e) => editForm((prev) => ({ ...prev, ageRating: e.target.value }))}
                />
              ) : null}
            </div>
            <div className="space-y-2">
              <Label>최대 참석자 수</Label>
              <div className="flex items-center justify-between rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                <span>
                  {form.maxAttendees ? `${form.maxAttendees}명` : "좌석 배치도 저장 후 자동 산출"}
                </span>
                <span className="text-xs">자동 계산</span>
              </div>
              <p className="text-xs text-muted-foreground">
                좌석 배치도의 활성 좌석 + 스탠딩 수용 인원 합산값. 배치도 저장 시 자동 갱신됩니다.
              </p>
            </div>
          </div>

          <div className="border-t border-border pt-6 first:border-0 first:pt-0">
            <h3 className="text-lg font-bold text-foreground">일정</h3>
            <p className="mt-1 text-sm text-content-subtle">시작·종료 시각은 환불 정책 기준일이 되므로 정확히 입력해 주세요.</p>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="event-starts-at">시작 일시</Label>
              <Input
                id="event-starts-at"
                type="datetime-local"
                value={form.startsAt}
                onChange={(event) => editForm((prev) => ({ ...prev, startsAt: event.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="event-ends-at">종료 일시</Label>
              <Input
                id="event-ends-at"
                type="datetime-local"
                value={form.endsAt}
                onChange={(event) => editForm((prev) => ({ ...prev, endsAt: event.target.value }))}
              />
            </div>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="event-runtime">공연시간 (분)</Label>
              <Input
                id="event-runtime"
                type="number"
                min="1"
                placeholder="예: 120 (인터미션 포함)"
                value={form.runtimeMinutes ?? ""}
                onChange={(event) => editForm((prev) => ({ ...prev, runtimeMinutes: event.target.value ? Number(event.target.value) : null }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="event-intermission">인터미션 (분)</Label>
              <Input
                id="event-intermission"
                type="number"
                min="0"
                placeholder="예: 20"
                value={form.intermissionMinutes ?? ""}
                onChange={(event) => editForm((prev) => ({ ...prev, intermissionMinutes: event.target.value ? Number(event.target.value) : null }))}
              />
            </div>
          </div>

          <div className="border-t border-border pt-6 first:border-0 first:pt-0">
            <h3 className="text-lg font-bold text-foreground">장소</h3>
            <p className="mt-1 text-sm text-content-subtle">장소를 정한 뒤 가는 길을 안내합니다. 안내물 이미지는 아래 「상세 안내 이미지」에서 이 자리로 보낼 수 있습니다.</p>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="event-venue-name">장소명</Label>
              <Input
                id="event-venue-name"
                value={form.venueName}
                onChange={(event) => editForm((prev) => ({ ...prev, venueName: event.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="event-venue-address">주소</Label>
              <Input
                id="event-venue-address"
                value={form.venueAddress}
                onChange={(event) => editForm((prev) => ({ ...prev, venueAddress: event.target.value }))}
              />
            </div>
          </div>

          <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 px-4 py-3">
            <Checkbox
              id="event-is-online"
              checked={form.isOnline}
              onCheckedChange={(checked) => editForm((prev) => ({ ...prev, isOnline: checked === true }))}
            />
            <Label htmlFor="event-is-online" className="cursor-pointer">
              온라인 이벤트입니다
            </Label>
          </div>

          {/* 행사 유형 — 무료 참석(RSVP) vs 유료 티켓 판매. 켜면 랜딩에 참석 등록 폼이 노출된다. */}

          {mode === "edit" ? (
            <div className="grid gap-5 lg:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="event-transport-info">대중교통 안내</Label>
                <Textarea
                  id="event-transport-info"
                  rows={4}
                  value={form.transportInfo}
                  onChange={(event) => editForm((prev) => ({ ...prev, transportInfo: event.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="event-parking-info">주차 안내</Label>
                <Textarea
                  id="event-parking-info"
                  rows={4}
                  value={form.parkingInfo}
                  onChange={(event) => editForm((prev) => ({ ...prev, parkingInfo: event.target.value }))}
                />
              </div>
              {/*
                🔴 프로그램 탭 자유문구 (2026-08-02).
                종전엔 주최자가 쓸 칸이 없어 **이미지로 때우고 있었다** — 그러면 확대·복사·
                검색·번역·낭독기가 전부 안 되고, 값을 바꾸려면 이미지를 다시 만들어야 한다.
              */}
              <div className="space-y-2">
                <Label htmlFor="event-program-notes">프로그램 안내</Label>
                <Textarea
                  id="event-program-notes"
                  rows={4}
                  placeholder="줄바꿈으로 항목을 나눕니다"
                  value={form.programNotes}
                  onChange={(event) => editForm((prev) => ({ ...prev, programNotes: event.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="event-stage-info">무대·구역 안내</Label>
                <Textarea
                  id="event-stage-info"
                  rows={4}
                  value={form.stageInfo}
                  onChange={(event) => editForm((prev) => ({ ...prev, stageInfo: event.target.value }))}
                />
              </div>
            </div>
          ) : null}

          <div className="border-t border-border pt-6 first:border-0 first:pt-0">
            <h3 className="text-lg font-bold text-foreground">소개 내용</h3>
            <p className="mt-1 text-sm text-content-subtle">공개 페이지 「이벤트 안내」에 표시됩니다.</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="event-description">상세 설명</Label>
            <Textarea
              id="event-description"
              rows={6}
              value={form.description}
              onChange={(event) => editForm((prev) => ({ ...prev, description: event.target.value }))}
            />
          </div>

          <div className="border-t border-border pt-6 first:border-0 first:pt-0">
            <h3 className="text-lg font-bold text-foreground">판매 방식</h3>
            <p className="mt-1 text-sm text-content-subtle">판매·입장 방식은 티켓 발급과 게이트 동작을 결정합니다.</p>
          </div>

          <div className="space-y-4 rounded-lg border border-border bg-muted/30 p-4">
            <div>
              <p className="text-sm font-semibold text-foreground">좌석 판매 방식</p>
              <p className="mt-1 text-xs text-muted-foreground">
                좌석을 지정해서 파는 행사인지, 좌석 없이 입장권만 파는 행사인지 선택합니다.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="event-seat-type">판매 방식</Label>
              <Select
                value={form.seatType}
                onValueChange={(value: EventFormValue["seatType"]) =>
                  editForm((prev) => ({ ...prev, seatType: value }))
                }
              >
                <SelectTrigger id="event-seat-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="assigned">지정석 판매 (좌석배치도를 그려서 판매)</SelectItem>
                  <SelectItem value="unassigned">자유 입장 (좌석 없이 등급·수량만)</SelectItem>
                </SelectContent>
              </Select>
              {form.seatType === "unassigned" ? (
                <p className="text-xs text-muted-foreground">
                  골프 갤러리·페스티벌·박람회처럼 좌석이 없는 행사입니다. 배치도를 그리지 않고
                  등급별 수량만 입력하면 됩니다.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  공연장처럼 좌석을 지정해 파는 행사입니다. `티켓 &amp; 좌석` 화면에서 배치도를 그리면
                  등급별 수량이 채워집니다.
                </p>
              )}
              <p className="text-xs text-amber-700">
                이미 좌석이 배정된 티켓이 있으면 자유 입장으로 바꿀 수 없습니다.
              </p>
            </div>
          </div>

          {/* F1/F4 입장 규칙 · 경품 — 다일 입장방식(single/daypass/allpass) + 경품 추첨 사용 */}

          <div className="space-y-4 rounded-lg border border-border bg-muted/30 p-4">
            <div>
              <p className="text-sm font-semibold text-foreground">입장 규칙 · 경품</p>
              <p className="mt-1 text-xs text-muted-foreground">
                다일 행사의 입장 방식과 현장 경품 추첨 사용 여부를 설정합니다.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="event-admission-mode">입장 방식</Label>
              <Select
                value={form.admissionMode}
                onValueChange={(value: EventFormValue["admissionMode"]) =>
                  editForm((prev) => ({ ...prev, admissionMode: value }))
                }
              >
                <SelectTrigger id="event-admission-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="single">단일일 입장 (하루, 입장 1회)</SelectItem>
                  <SelectItem value="daypass" disabled={!isMultiDay}>
                    지정일권 (다일 중 지정한 하루만)
                  </SelectItem>
                  <SelectItem value="allpass" disabled={!isMultiDay}>
                    전일권 (기간 내 매일 재입장)
                  </SelectItem>
                </SelectContent>
              </Select>
              {!isMultiDay ? (
                <p className="text-xs text-amber-700">
                  지정일권·전일권은 다일 이벤트에만 사용할 수 있습니다. 종료 일시를 시작일 다음 날 이후로 설정하면 선택할 수 있습니다.
                </p>
              ) : form.admissionMode === "daypass" ? (
                <p className="text-xs text-muted-foreground">
                  발권 시 참석자마다 대회 기간 내 입장 지정일을 선택합니다(수동발권·대량 초대 화면).
                </p>
              ) : form.admissionMode === "allpass" ? (
                <p className="text-xs text-muted-foreground">
                  참석자는 행사 기간 내 매일 재입장할 수 있습니다.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">기존 방식 — 하루 입장, 입장 시 사용 완료 처리됩니다.</p>
              )}
            </div>

            <div className="flex items-start gap-3 rounded-lg border border-border bg-card px-4 py-3">
              <Checkbox
                id="event-raffle-enabled"
                checked={form.raffleEnabled}
                onCheckedChange={(checked) => editForm((prev) => ({ ...prev, raffleEnabled: checked === true }))}
              />
              <div className="space-y-1">
                <Label htmlFor="event-raffle-enabled" className="cursor-pointer">
                  경품 추첨(래플) 사용
                </Label>
                <p className="text-xs text-muted-foreground">
                  체크하면 발권 시 티켓마다 <span className="font-medium text-foreground">경품 번호</span>가 부여되고, 체크인한 참석자 중에서 추첨할 수 있습니다.
                </p>
              </div>
            </div>
          </div>

          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}

          <div className="rounded-lg border border-border bg-muted/30 px-4 py-3">
            <div className="flex items-start gap-3">
              <Checkbox
                id="event-rsvp-enabled"
                checked={form.rsvpEnabled}
                onCheckedChange={(checked) => editForm((prev) => ({ ...prev, rsvpEnabled: checked === true }))}
              />
              <div className="space-y-1">
                <Label htmlFor="event-rsvp-enabled" className="cursor-pointer">
                  무료 참석(RSVP) 이벤트입니다
                </Label>
                <p className="text-xs text-muted-foreground">
                  체크하면 티켓 판매 대신 <span className="font-medium text-foreground">참석 등록(RSVP) 폼</span>이 노출됩니다. 유료 티켓을 판매하려면 체크를 해제하세요.
                </p>
              </div>
            </div>
          </div>

          {/* U3 단체 예약 문의 — 켜면 공개 상세페이지에 단체 예약 문의 폼이 노출된다. */}

          <div className="rounded-lg border border-border bg-muted/30 px-4 py-3">
            <div className="flex items-start gap-3">
              <Checkbox
                id="event-group-booking-enabled"
                checked={form.groupBookingEnabled}
                onCheckedChange={(checked) => editForm((prev) => ({ ...prev, groupBookingEnabled: checked === true }))}
              />
              <div className="space-y-1">
                <Label htmlFor="event-group-booking-enabled" className="cursor-pointer">
                  단체 예약 문의를 받습니다
                </Label>
                <p className="text-xs text-muted-foreground">
                  체크하면 공개 상세페이지에 <span className="font-medium text-foreground">단체 예약 문의 폼</span>이 노출됩니다. 접수된 문의는 이벤트 관리에서 확인할 수 있습니다.
                </p>
              </div>
            </div>
          </div>

          {/* U3 상단 배너 — 공개 상세페이지 최상단에 노출되는 주최자 안내 문구(공지·프로모션 등). */}

          <div className="border-t border-border pt-6 first:border-0 first:pt-0">
            <h3 className="text-lg font-bold text-foreground">상단 배너</h3>
            <p className="mt-1 text-sm text-content-subtle">공개 페이지 최상단에 띠로 표시됩니다. 비우면 배너가 나오지 않습니다.</p>
          </div>

          <div className="space-y-2 rounded-lg border border-border bg-muted/30 px-4 py-3">
            <Label htmlFor="event-context-banner">상단 안내 배너 (선택)</Label>
            <Textarea
              id="event-context-banner"
              value={form.contextBanner}
              maxLength={500}
              placeholder="예: 얼리버드 티켓 판매 중! 3월 31일까지 20% 할인"
              onChange={(e) => editForm((prev) => ({ ...prev, contextBanner: e.target.value }))}
            />
            <p className="text-xs text-muted-foreground">
              공개 상세페이지 최상단에 노출됩니다. 비워두면 배너가 표시되지 않습니다.
            </p>
          </div>

          {/* 좌석 판매 방식 — 지정석(배치도)인지 자유입장(등급 수량만)인지. `티켓 & 좌석` 화면이
              이 값으로 배치도 에디터 노출을 가른다. 기존 이벤트 기본값은 assigned(현행 유지). */}

          <div className="border-t border-border pt-6 first:border-0 first:pt-0">
            <h3 className="text-lg font-bold text-foreground">이미지</h3>
            <p className="mt-1 text-sm text-content-subtle">대표 이미지는 히어로(가로 2520×1080 권장), 세로는 모바일용입니다.</p>
          </div>

          <ImageUpload
            value={form.heroImageUrl}
            onChange={(heroImageUrl) => editForm((prev) => ({ ...prev, heroImageUrl }))}
            /*
             * 🔴 대표 이미지를 바꿔도 **직접 올린 세로는 지키다** (2026-08-04 대표 지적).
             *
             * 종전엔 `imageVariants` 를 통째로 덮었다. 대표를 올리면 서버가 렌디션 4종
             * (wide·**portrait**·thumb·og)을 만들어 돌려주는데, 그게 손으로 올린 세로를
             * 밀어내고 **자동 중앙크롭본**으로 바꿔버렸다. 포스터처럼 좌우로 퍼진 그림은
             * 그 크롭에서 한쪽이 잘린다 — 세로를 따로 올리게 만든 이유가 그거였는데,
             * 대표를 한 번 갈아끼우면 원상복구됐다.
             *
             * 구분 방법: 자동 렌디션은 `{base}-portrait.webp` 이고, 손으로 올린 세로는
             * 그 업로드의 **마스터 URL**(`{base}.webp`)이라 접미사가 없다.
             */
            onVariantsChange={(imageVariants) =>
              editForm((prev) => ({ ...prev, imageVariants: mergeKeepingManualPortrait(prev.imageVariants, imageVariants) }))
            }
            label="대표 이미지 (가로)"
            uploadType="event"
          />

          {/* 🔴 세로 이미지 별도 업로드.
           *
           * 자동 변환은 가로 원본을 **중앙 크롭**해 세로본을 만든다. 포스터처럼 글자·정보가
           * 좌우로 퍼진 이미지는 그 크롭에서 잘려나간다(KLPGA 포스터는 제목이 왼쪽, 선수가
           * 오른쪽이라 세로본에서 한쪽이 사라졌다).
           * 모바일 히어로는 이 값을 그대로 쓰므로, 올리면 크롭 없이 의도한 화면이 나온다.
           * 미업로드면 종전대로 자동 크롭본이 쓰인다(하위호환).
           */}

          <ImageUpload
            value={form.imageVariants?.portrait ?? ""}
            onChange={(url) =>
              editForm((prev) => ({
                ...prev,
                imageVariants: url
                  ? { ...(prev.imageVariants ?? {}), portrait: url }
                  : Object.fromEntries(
                      Object.entries(prev.imageVariants ?? {}).filter(([k]) => k !== "portrait"),
                    ),
              }))
            }
            label="세로 이미지 (모바일용, 선택)"
            uploadType="event"
            hint={{
              size: "세로 1080 × 1440 (3:4) 권장",
              tip: "모바일 화면의 히어로에 쓰입니다. 안 올리면 가로 이미지를 중앙 기준으로 잘라 씁니다.",
            }}
          />

          <GalleryUpload
            value={form.galleryImages}
            onChange={(galleryImages) => editForm((prev) => ({ ...prev, galleryImages }))}
            label={`갤러리 이미지 (선택, 최대 ${GALLERY_MAX_IMAGES}장)`}
            max={4}
            uploadType="event"
          />

          {/* 대중교통/주차 안내 — 설정(수정) 모드에서만 표시 */}

          <div className="flex justify-end">
            <Button type="submit" className="min-w-36" disabled={saving}>
              {saving ? "저장 중..." : mode === "create" ? "이벤트 만들기" : "저장하기"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
