"use client";

import { useState } from "react";
import { InvitationTransferDialog } from "./invitation-transfer-dialog";
import Image from "next/image";
import { CalendarPlus, Gift, MapPin, ShieldAlert, Ticket, Trophy } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { RotatingTicketQR } from "./rotating-ticket-qr";

export interface InvitationTicketDesign {
  backgroundColor?: string;
  textColor?: string;
  accentColor?: string;
  logoUrl?: string;
  headerText?: string;
  showEventName?: boolean;
  showDate?: boolean;
  showVenue?: boolean;
  showAttendeeName?: boolean;
  showRaffleNumber?: boolean;
  showGallery?: boolean;
}

export interface InvitationTicketViewProps {
  ticketNumber: string;
  qrImage: string;
  /** 딥링크 토큰 — 접근 쿠키 교환용. 없으면 QR 갱신·PDF 가 403 이 된다. */
  accessToken?: string | null;
  eventTitle: string;
  recipientName: string;
  /** "초대권" | "초청장" 등 등급 라벨. */
  gradeLabel: string;
  /** 발권 일시(표시용, YYYY-MM-DD HH:mm). */
  issuedAtText: string | null;
  /** 대회 일정(기간 텍스트). */
  scheduleText: string;
  /** 입장 가능 일자 요약. */
  admissionText: string;
  admissionBadge: string;
  venueText: string | null;
  /** F4 경품번호(있을 때만). */
  raffleNumber: number | null;
  heroImageUrl: string | null;
  /** 하단 행사 이미지 URL 목록(캐러셀). */
  galleryImages: string[];
  calendarUrl: string;
  mapUrl: string | null;
  design: InvitationTicketDesign;
}

/**
 * F5 수신자 대면 "초대권" 화면.
 *
 * 일반 유료 티켓과 분기되는 초대권 등급 렌더 — 초대권 헤더/배지, 발권일시, 대회일정,
 * 입장 가능 일자(F1), 경품번호(F4), 회전 QR(기존 유지·강조), "초대권 양도하기"(소유권 이전 — 옛 링크 사망),
 * 캡처 불가 안내 밴드, 하단 행사 이미지 캐러셀. 주최자 design 설정으로 색·로고·문구·표시항목 커스터마이즈.
 */
export function InvitationTicketView({
  ticketNumber,
  qrImage,
  accessToken,
  eventTitle,
  recipientName,
  gradeLabel,
  issuedAtText,
  scheduleText,
  admissionText,
  admissionBadge,
  venueText,
  raffleNumber,
  heroImageUrl,
  galleryImages,
  calendarUrl,
  mapUrl,
  design,
}: InvitationTicketViewProps) {
  const [transferOpen, setTransferOpen] = useState(false);
  const [galleryIndex, setGalleryIndex] = useState(0);
  // 로고 파일이 404 면 깨진 이미지 대신 감춘다(폴백 ②).
  const [logoBroken, setLogoBroken] = useState(false);

  const accent = design.accentColor?.trim() || "#6C5CE7";
  const headerText = design.headerText?.trim() || gradeLabel;
  const showGallery = design.showGallery !== false && galleryImages.length > 0;


  return (
    <div className="min-h-screen bg-background px-4 py-8">
      <div className="mx-auto max-w-md">
        <Card
          className="overflow-hidden border-border"
          style={{ backgroundColor: design.backgroundColor?.trim() || "#FFFFFF", color: design.textColor?.trim() || "#1A1D2E" }}
        >
          {/* 행사 배너(히어로) */}
          <div
            className="relative h-52"
            style={{
              background: heroImageUrl
                ? `url(${heroImageUrl}) center/cover no-repeat`
                : "linear-gradient(135deg,rgba(108,92,231,0.15),rgba(139,92,246,0.10),rgba(5,150,105,0.08))",
            }}
          >
            {design.logoUrl?.trim() && !logoBroken ? (
              <div className="absolute left-4 top-4 rounded-lg bg-white/90 p-1.5 shadow-sm">
                <Image
                  src={design.logoUrl.trim()}
                  alt="주최자 로고"
                  width={72}
                  height={28}
                  unoptimized
                  className="h-7 w-auto object-contain"
                  // 폴백 ② — URL 은 있는데 파일이 404 인 경우(`lib/ticket/logo.ts` 주석).
                  //          문자열만 보고는 알 수 없어 렌더 시점에만 잡힌다. 감추지 않으면
                  //          손님이 받는 초대권에 깨진 이미지 아이콘이 박힌 채 나간다.
                  onError={() => setLogoBroken(true)}
                />
              </div>
            ) : null}
          </div>

          <CardContent className="space-y-6 p-6">
            {/* 초대권 헤더 + 배지 */}
            <div>
              <div className="flex items-center gap-2">
                <span
                  className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold uppercase tracking-[0.18em]"
                  style={{ backgroundColor: `${accent}22`, color: accent }}
                >
                  <Ticket className="size-3.5" />
                  {headerText}
                </span>
                <Badge variant="outline">{admissionBadge}</Badge>
              </div>
              {design.showEventName !== false ? (
                <h1 className="mt-3 text-2xl font-black tracking-[-0.04em]">{eventTitle}</h1>
              ) : null}
              {design.showAttendeeName !== false && recipientName ? (
                <p className="mt-2 text-sm font-semibold text-foreground">{recipientName} 님</p>
              ) : null}
            </div>

            {/* 정보 표 — 발권일시 / 대회일정 / 입장 가능 일자 / 경품번호 */}
            <dl className="space-y-3 rounded-xl border border-border bg-muted p-5 text-sm">
              {issuedAtText ? (
                <div className="flex items-start justify-between gap-3">
                  <dt className="shrink-0 text-muted-foreground">발권일시</dt>
                  <dd className="text-right font-medium text-foreground">{issuedAtText}</dd>
                </div>
              ) : null}
              {design.showDate !== false ? (
                <div className="flex items-start justify-between gap-3">
                  <dt className="shrink-0 text-muted-foreground">대회일정</dt>
                  <dd className="text-right font-medium text-foreground">{scheduleText}</dd>
                </div>
              ) : null}
              <div className="flex items-start justify-between gap-3">
                <dt className="shrink-0 text-muted-foreground">입장 가능 일자</dt>
                <dd className="text-right font-semibold" style={{ color: accent }}>
                  {admissionText}
                </dd>
              </div>
              {design.showVenue !== false && venueText ? (
                <div className="flex items-start justify-between gap-3">
                  <dt className="shrink-0 text-muted-foreground">장소</dt>
                  <dd className="text-right font-medium text-foreground">{venueText}</dd>
                </div>
              ) : null}
              {design.showRaffleNumber !== false && raffleNumber !== null ? (
                <div className="flex items-center justify-between gap-3 border-t border-dashed border-border pt-3">
                  <dt className="flex items-center gap-1.5 text-muted-foreground">
                    <Trophy className="size-4" style={{ color: accent }} />
                    경품번호
                  </dt>
                  <dd className="font-mono text-lg font-black tracking-wider" style={{ color: accent }}>
                    {raffleNumber}
                  </dd>
                </div>
              ) : null}
            </dl>

            {/* 회전 QR (기존 유지·강조) */}
            <div className="rounded-xl border border-border bg-white p-5">
              <RotatingTicketQR ticketNumber={ticketNumber} initialImage={qrImage} accessToken={accessToken} />
              <p className="mt-2 text-center font-mono text-xs text-muted-foreground">{ticketNumber}</p>
            </div>

            {/* 캡처 불가 안내 밴드 */}
            <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs">
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
              <p className="text-foreground">
                <span className="font-semibold">캡처·스크린샷은 입장에 사용할 수 없습니다.</span>{" "}
                QR은 30초마다 자동 갱신되며, 입장 시 실시간 화면을 스태프에게 보여주세요.
              </p>
            </div>

            {/* 초대권 양도 + 캘린더/길찾기 */}
            <div className="space-y-2">
              {/*
                ✅ 앞선 주석("양도 기능이 나오면 그때 동작이 이름에 맞춘다")대로 이름에 동작을
                   맞췄다. 이제 이 버튼은 링크를 복사하지 않고 **소유권을 넘긴다** —
                   받는 분 정보를 받아 서버가 새 링크를 발송하고, 이 화면의 링크는 죽는다.
                🔴 링크 복사 버튼은 없앴다. 그게 "3명이 같은 티켓을 보는" 문제의 원인이었다.
                   주소창 링크는 여전히 복사할 수 있지만, 우리가 권하는 경로는 아니다.
              */}
              {transferOpen ? (
                <InvitationTransferDialog
                  ticketNumber={ticketNumber}
                  token={accessToken ?? ""}
                  accentColor={accent}
                  onClose={() => setTransferOpen(false)}
                />
              ) : (
                <>
                  <Button
                    className="w-full"
                    onClick={() => setTransferOpen(true)}
                    disabled={!accessToken}
                  >
                    <Gift className="mr-2 size-4" />
                    초대권 양도하기
                  </Button>
                  <p className="text-center text-xs text-muted-foreground">
                    {accessToken
                      ? "받는 분 성함·번호를 넣으면 그분께 새 초대권이 발송되고, 이 초대권은 사용할 수 없게 됩니다."
                      : "이 화면에서는 양도할 수 없습니다. 받으신 초대권 링크로 다시 열어주세요."}
                  </p>
                </>
              )}
              <div className="grid grid-cols-2 gap-2">
                <Button variant="outline" size="sm" asChild>
                  <a href={calendarUrl} target="_blank" rel="noopener noreferrer">
                    <CalendarPlus className="mr-1.5 size-3.5" />
                    캘린더 추가
                  </a>
                </Button>
                {mapUrl ? (
                  <Button variant="outline" size="sm" asChild>
                    <a href={mapUrl} target="_blank" rel="noopener noreferrer">
                      <MapPin className="mr-1.5 size-3.5" />
                      길찾기
                    </a>
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" disabled>
                    <MapPin className="mr-1.5 size-3.5" />
                    길찾기
                  </Button>
                )}
              </div>
            </div>

            {/* 하단 행사 이미지 캐러셀 */}
            {showGallery ? (
              <div className="space-y-2">
                <div className="overflow-hidden rounded-xl border border-border">
                  <Image
                    src={galleryImages[galleryIndex]}
                    alt={`행사 이미지 ${galleryIndex + 1}`}
                    width={640}
                    height={360}
                    unoptimized
                    className="h-auto w-full object-cover"
                  />
                </div>
                {galleryImages.length > 1 ? (
                  <div className="flex items-center justify-center gap-1.5">
                    {galleryImages.map((url, i) => (
                      <button
                        key={url}
                        type="button"
                        aria-label={`행사 이미지 ${i + 1} 보기`}
                        aria-current={i === galleryIndex}
                        onClick={() => setGalleryIndex(i)}
                        className="size-2 rounded-full transition-colors"
                        style={{ backgroundColor: i === galleryIndex ? accent : "var(--border-emphasis)" }}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
