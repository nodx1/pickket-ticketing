"use client";

import { useTranslations } from "next-intl";
import { useState, useRef, useEffect, useCallback, useContext } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion, AnimatePresence, useInView } from "motion/react";
import {
  Heart,
  MessageCircle,
  Send,
  ThumbsUp,
  Users,
  Share2,
  Copy,
  Clock,
  PartyPopper,
  Archive,
  Star,
} from "lucide-react";
import {
  submitSurveyResponse,
  getSurveyStats,
  getEventComments,
  createComment,
  toggleCommentLike,
  type EventComment as ApiComment,
} from "@pickket/lib/api";
import { toast } from "sonner";
import { getCommunityWidgetConfig } from "@pickket/lib";
import { useAuthStore } from "@pickket/store";
import { DetailPageContext } from "../detail-context";
import { type FeedFilterTab, type UnifiedFeedItem } from "../community-data";
import { fmt, fadeUp, stagger } from "../detail-helpers";
import { RoleBadge } from "./RoleBadge";
import { FeedFilterTabs } from "./FeedFilterTabs";
import { OrganizerPost } from "./OrganizerPost";
import { ArtistMessageCard } from "./ArtistMessageCard";
import { ShareCardPreview } from "./ShareCardPreview";
import { FanWeightWidget } from "./FanWeightWidget";
import { UserProfileCard } from "./UserProfileCard";
import { CommunityLeaderboard } from "./CommunityLeaderboard";

/* ── API → UI 어댑터 ── */
function apiCommentToFeedItem(c: ApiComment): UnifiedFeedItem {
  return {
    id: c.id,
    userId: c.user_id,
    role: c.role as UnifiedFeedItem["role"],
    user: c.user_name,
    avatar:
      c.user_avatar ??
      "https://ui-avatars.com/api/?name=" + encodeURIComponent(c.user_name),
    text: c.content,
    likes: c.likes_count,
    replies: c.replies_count,
    createdAt: new Date(c.created_at).toLocaleDateString("ko-KR", {
      month: "long",
      day: "numeric",
      timeZone: "Asia/Seoul",
    }),
    pinned: c.is_pinned,
    isVerifiedAttendee: c.role === "verified_attendee",
  };
}

/* ── Zone 래퍼 — 스크롤 진입 시 stagger 애니메이션 ── */
function ScrollZone({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, margin: "-60px" });

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 16 }}
      animate={isInView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.5, ease: [0.25, 0.1, 0.25, 1] }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

/* ── 상태 배너 (Section 9-2) ── */
function StatusBanner({
  status,
  eventDate,
}: {
  status: string;
  eventDate?: string;
}) {
  const t = useTranslations("event.communityFeed");

  if (status === "upcoming") {
    const targetDate = eventDate ? new Date(eventDate) : null;
    const now = new Date();
    const daysLeft = targetDate
      ? Math.max(
          0,
          Math.ceil(
            (targetDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
          ),
        )
      : null;

    return (
      <div
        className="flex items-center gap-3 px-4 py-3 rounded-2xl border border-border"
        style={{
          background:
            "linear-gradient(135deg, rgba(10,10,10,0.12) 0%, rgba(0,210,160,0.08) 100%)",
        }}
      >
        <Clock className="h-4 w-4 text-primary/70" />
        <div className="text-sm">
          <span className="font-semibold text-foreground">{t("statusUpcoming")}</span>
          {daysLeft !== null && (
            <span className="text-muted-foreground ml-2">D-{daysLeft}</span>
          )}
        </div>
      </div>
    );
  }

  // 🔴 응모 진행 중에는 이 상태 띠가 **아무것도 그리지 않는다** (2026-08-02 확인).
  //    종전 주석은 "LiveBuzz handles this" 였는데, 그 `_LiveBuzz` 는 **어디서도
  //    렌더되지 않는 죽은 코드**였다(밑줄 접두로 unused 경고만 눌러둔 상태이고,
  //    그 탓에 React Hook 규칙 위반이 lint error 로 남아 있었다).
  //    지우면서 주석도 사실대로 고친다 — **대체 UI 는 없다.**
  // ⚠️ 응모가 열린 시점이 손님에게 가장 중요한 구간인데 표시가 비어 있다.
  //    무엇을 보여줄지는 제품 판단이라 여기서 만들지 않았다(별건으로 보고).
  if (status === "bidding_open") return null;

  if (status === "bidding_closed") {
    return (
      <div
        className="flex items-center gap-3 px-4 py-3 rounded-2xl border border-border"
        style={{
          background:
            "linear-gradient(135deg, rgba(251,191,36,0.12) 0%, rgba(245,158,11,0.08) 100%)",
        }}
      >
        <Clock className="h-4 w-4 text-amber-400" />
        <span className="text-sm font-semibold text-foreground">
          {t("statusBiddingClosed")}
        </span>
      </div>
    );
  }

  if (status === "allocated") {
    return (
      <div
        className="flex items-center gap-3 px-4 py-3 rounded-2xl border border-border"
        style={{
          background:
            "linear-gradient(135deg, rgba(16,185,129,0.12) 0%, rgba(52,211,153,0.08) 100%)",
        }}
      >
        <PartyPopper className="h-4 w-4 text-emerald-400" />
        <span className="text-sm font-semibold text-foreground">
          {t("statusAllocated")}
        </span>
      </div>
    );
  }

  if (status === "completed") {
    return (
      <div
        className="flex flex-col gap-2 px-4 py-3 rounded-2xl border border-border"
        style={{
          background:
            "linear-gradient(135deg, rgba(10,10,10,0.08) 0%, rgba(168,85,247,0.08) 100%)",
        }}
      >
        <div className="flex items-center gap-3">
          <Archive className="h-4 w-4 text-primary/70" />
          <div className="flex items-center gap-2 text-sm">
            <span className="font-semibold text-foreground">{t("statusCompleted")}</span>
            <span className="text-muted-foreground">|</span>
            <button className="flex items-center gap-1 text-primary/70 hover:underline">
              <Star className="h-3.5 w-3.5" />
              {t("writeReview")}
            </button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground pl-7">
          {t("completedDescription")}
        </p>
      </div>
    );
  }

  return null;
}

/* ── 기대 투표 ── */
function ExpectationVote({
  eventId,
  expectationLabel,
}: {
  eventId: string;
  expectationLabel?: string;
}) {
  const t = useTranslations("event.communityFeed");
  const resolvedLabel = expectationLabel ?? t("expectationLabel");
  const surveyId = `expectation-${eventId}`;
  const localKey = `pickket:voted:${surveyId}`;
  const [voted, setVoted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [count, setCount] = useState(0);

  // localStorage 에 투표 기록 있으면 즉시 voted=true (새로고침 후에도 유지).
  // backend 가 fingerprint(IP+UA) 로 dedup 하므로 사용자별 fetch endpoint 가 없어
  // 클라이언트 캐시로 대체.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.localStorage.getItem(localKey)) {
      setVoted(true);
    }
  }, [localKey]);

  const { data: surveyData } = useQuery({
    queryKey: ["surveyStats", surveyId],
    queryFn: async () => {
      const res = await getSurveyStats(surveyId);
      return res.data as {
        total_responses: number;
        answers_distribution: Record<string, Record<string, number>>;
      };
    },
  });

  useEffect(() => {
    if (surveyData) setCount(surveyData.total_responses);
  }, [surveyData]);

  const pct =
    count > 0 ? Math.min(Math.round((count / (count + 10)) * 100), 99) : 0;

  const handleVote = useCallback(async () => {
    if (voted || submitting) return;
    setSubmitting(true);
    setVoted(true);
    setCount((c) => c + 1);
    try {
      await submitSurveyResponse(surveyId, { excited: true });
      if (typeof window !== "undefined") {
        window.localStorage.setItem(localKey, "1");
      }
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response
        ?.status;
      if (status === 409) {
        // 이미 투표 (backend fingerprint 매칭) — voted 유지 + localStorage 저장
        setVoted(true);
        if (typeof window !== "undefined") {
          window.localStorage.setItem(localKey, "1");
        }
      } else {
        setVoted(false);
        setCount((c) => c - 1);
        toast.error(t("voteError"));
      }
    } finally {
      setSubmitting(false);
    }
  }, [voted, submitting, surveyId, localKey]);

  return (
    <div
      className="p-5 rounded-2xl text-white relative overflow-hidden"
      style={{
        background:
          "linear-gradient(135deg, #0a0a0a 0%, #404040 60%, #00C9A7 100%)",
      }}
    >
      <div className="relative z-10">
        <div className="flex items-center justify-between mb-3">
          <span className="text-base font-bold">{resolvedLabel}</span>
          <span className="text-xs text-white/70">{t("participantCount", { count: fmt(count) })}</span>
        </div>
        <div className="flex items-center gap-3 mb-4">
          <div className="flex-1 h-3 rounded-full bg-white/20 overflow-hidden">
            <motion.div
              className="h-full rounded-full bg-white"
              initial={{ width: 0 }}
              animate={{ width: `${pct}%` }}
              transition={{ duration: 1.2, ease: "easeOut" }}
            />
          </div>
          <span className="text-lg font-bold">{pct}%</span>
        </div>
        <button
          onClick={handleVote}
          disabled={voted || submitting}
          className={`w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold transition-all min-h-[44px] ${
            voted
              ? "bg-white text-primary"
              : "bg-white/20 text-white hover:bg-white/30 backdrop-blur-sm"
          }`}
        >
          <ThumbsUp className={`h-4 w-4 ${voted ? "fill-primary" : ""}`} />
          {voted ? t("expectationVoted") : t("expectationButton")}
        </button>
      </div>
    </div>
  );
}

/* ── 소셜 스트립 ── */
function SocialStrip({
  totalParticipants,
  commentCount,
}: {
  totalParticipants: number;
  commentCount: number;
}) {
  const t = useTranslations("event.communityFeed");
  return (
    <div className="flex items-center justify-between p-3 rounded-xl bg-muted border border-border">
      <div className="flex items-center gap-4">
        <span className="flex items-center gap-1.5 text-xs">
          <Users className="h-3.5 w-3.5 text-primary/70" />
          <span className="font-semibold text-foreground">
            {t("countPeople", { count: fmt(totalParticipants) })}
          </span>
          <span className="text-muted-foreground">{t("participating")}</span>
        </span>
        <span className="flex items-center gap-1.5 text-xs">
          <MessageCircle className="h-3.5 w-3.5 text-primary/70" />
          <span className="font-semibold text-foreground">
            {t("countItems", { count: fmt(commentCount) })}
          </span>
          <span className="text-muted-foreground">{t("comments")}</span>
        </span>
      </div>
    </div>
  );
}

/* ── 일반 피드 아이템 (팬/예매자) — Heart 애니메이션 + 숫자 flip ── */
function FeedItem({
  item,
  liked,
  onLike,
  onShare,
  onUserClick,
}: {
  item: UnifiedFeedItem;
  liked: boolean;
  onLike: () => void;
  onShare: () => void;
  onUserClick?: (item: UnifiedFeedItem) => void;
}) {
  const likeCount = item.likes + (liked ? 1 : 0);
  const isVerified = item.role === "verified_attendee";

  return (
    <motion.div
      variants={fadeUp}
      className={`py-4 first:pt-0 ${
        isVerified ? "border-l-2 border-emerald-400 pl-3" : ""
      }`}
    >
      <div className="flex items-center gap-2.5 mb-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={item.avatar}
          alt=""
          className="h-8 w-8 rounded-full object-cover cursor-pointer"
          onClick={() => onUserClick?.(item)}
        />
        <button
          type="button"
          onClick={() => onUserClick?.(item)}
          className="text-sm font-medium text-foreground hover:text-primary/70 transition-colors"
        >
          {item.user}
        </button>
        <RoleBadge role={item.role} fanLevel={item.fanLevel} />
        <span className="text-xs-plus text-muted-foreground">
          {item.createdAt}
        </span>
      </div>

      <p className="text-sm text-foreground/85 leading-relaxed mb-2.5 pl-[42px]">
        {item.text}
      </p>

      {/* 액션 — 터치 타겟 44px */}
      <div className="flex items-center gap-3 pl-[42px]">
        <button
          onClick={onLike}
          className={`flex items-center gap-1.5 text-xs transition-colors min-h-[44px] min-w-[44px] justify-center ${
            liked
              ? "text-red-500"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <motion.span
            animate={liked ? { scale: [1, 1.3, 1] } : { scale: 1 }}
            transition={{ duration: 0.3 }}
          >
            <Heart className={`h-4 w-4 ${liked ? "fill-red-500" : ""}`} />
          </motion.span>
          <motion.span
            key={likeCount}
            initial={{ y: liked ? 8 : 0, opacity: liked ? 0 : 1 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.2 }}
          >
            {likeCount}
          </motion.span>
        </button>
        <button className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors min-h-[44px]">
          <MessageCircle className="h-4 w-4" />
          {item.replies}
        </button>
        <button
          onClick={onShare}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors ml-auto min-h-[44px] min-w-[44px] justify-center"
        >
          <Share2 className="h-4 w-4" />
        </button>
      </div>
    </motion.div>
  );
}

/* ══════════════════════════════════════════════════════════════
   메인 커뮤니티 피드
   ══════════════════════════════════════════════════════════════ */

export function CommunityFeed({
  eventTitle,
  eventId,
  eventDate,
  venue,
  eventStatus,
  category,
  viewCount: _viewCount = 0,
  bidCount = 0,
  totalSeats,
  peek: _peek,
}: {
  eventTitle: string;
  eventId: string;
  eventDate?: string;
  venue?: string;
  eventStatus?: string;
  category?: string;
  viewCount?: number;
  bidCount?: number;
  totalSeats?: number;
  /** When set, only show first N items (peek mode for bento grid) */
  peek?: number;
}) {
  const communityConfig = getCommunityWidgetConfig(category);
  const { setActiveTab: _setActiveTab } = useContext(DetailPageContext);
  const [feedFilter, setFeedFilter] = useState<FeedFilterTab>("all");
  const [likedIds, setLikedIds] = useState<Set<string>>(new Set());
  const [newComment, setNewComment] = useState("");
  const [shareMenuId, setShareMenuId] = useState<string | null>(null);
  const [comments, setComments] = useState<UnifiedFeedItem[]>([]);
  const [totalComments, setTotalComments] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [profileTarget, setProfileTarget] = useState<{
    userId: string;
    userName: string;
    avatar: string;
    role: string;
    fanLevel?: number;
  } | null>(null);
  const t = useTranslations("event.communityFeed");
  const user = useAuthStore((s) => s.user);

  // 전체 댓글 (카운트용)
  const [allComments, setAllComments] = useState<UnifiedFeedItem[]>([]);

  // Fetch comments from API
  const fetchComments = useCallback(
    async (filter: string) => {
      try {
        const apiFilter = filter === "all" ? "all" : filter;
        const res = await getEventComments(eventId, {
          filter: apiFilter,
          limit: 50,
        });
        const items = res.data.items.map(apiCommentToFeedItem);
        // Mark liked items
        const likedSet = new Set<string>();
        res.data.items.forEach((c) => {
          if (c.is_liked_by_me) likedSet.add(c.id);
        });
        setLikedIds(likedSet);
        setComments(items);
        setTotalComments(res.data.total);
        // 전체 탭일 때 카운트용 저장
        if (filter === "all") setAllComments(items);
      } catch {
        // API not available yet — show empty state
        setComments([]);
      }
    },
    [eventId],
  );

  useEffect(() => {
    fetchComments(feedFilter);
  }, [feedFilter, fetchComments]);

  const handleSubmitComment = useCallback(async () => {
    if (!newComment.trim() || submitting) return;
    if (!user) {
      toast.error(t("loginRequired"));
      return;
    }
    setSubmitting(true);
    try {
      const res = await createComment(eventId, { content: newComment.trim() });
      const item = apiCommentToFeedItem(res.data);
      setComments((prev) => [item, ...prev]);
      setTotalComments((t) => t + 1);
      setNewComment("");
    } catch {
      toast.error(t("commentError"));
    } finally {
      setSubmitting(false);
    }
  }, [newComment, submitting, user, eventId]);

  const toggleLike = useCallback(
    async (id: string) => {
      // Optimistic update
      setLikedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        return next;
      });
      setComments((prev) =>
        prev.map((c) =>
          c.id === id
            ? { ...c, likes: c.likes + (likedIds.has(id) ? -1 : 1) }
            : c,
        ),
      );
      try {
        await toggleCommentLike(eventId, id);
      } catch {
        // Rollback
        setLikedIds((prev) => {
          const next = new Set(prev);
          if (next.has(id)) {
            next.delete(id);
          } else {
            next.add(id);
          }
          return next;
        });
        fetchComments(feedFilter);
      }
    },
    [eventId, likedIds, feedFilter, fetchComments],
  );

  // 필터링 (already filtered by API, but separate pinned)
  const pinnedPosts = comments.filter((i) => i.pinned);
  const regularPosts = comments.filter((i) => !i.pinned);
  const filteredPosts = regularPosts;

  const showPinned = feedFilter === "all" || feedFilter === "official";

  // 공유 시 선택된 아이템의 텍스트 찾기
  const shareItem = shareMenuId
    ? comments.find((i) => i.id === shareMenuId)
    : null;

  const totalParticipants = totalSeats ?? bidCount;

  return (
    <div className="space-y-5">
      {/* ──── Zone 1: 분위기 ──── */}
      <ScrollZone className="space-y-5">
        <StatusBanner
          status={eventStatus ?? "upcoming"}
          eventDate={eventDate}
        />
        <ExpectationVote
          eventId={eventId}
          expectationLabel={communityConfig.expectationLabel}
        />
        <SocialStrip
          totalParticipants={totalParticipants}
          commentCount={totalComments}
        />
      </ScrollZone>

      {/* ──── Zone 1.5: Fan Weight + Quest Widget ──── */}
      <FanWeightWidget />

      {/* ──── Zone 1.7: Leaderboard ──── */}
      <CommunityLeaderboard eventId={eventId} />

      {/* ──── Zone 2: 아티스트 메시지 — API 연동 ──── */}
      <ArtistMessageCard eventId={eventId} />

      {/* ──── Zone 3: 필터 + 댓글 입력 ──── */}
      <ScrollZone className="space-y-4">
        <FeedFilterTabs
          active={feedFilter}
          onChange={setFeedFilter}
          items={allComments.length > 0 ? allComments : comments}
        />

        {/* 댓글 입력 — 모바일 하단 고정 */}
        <div className="flex items-center gap-3 lg:relative lg:bottom-auto lg:bg-transparent lg:border-none lg:p-0 max-lg:fixed max-lg:bottom-0 max-lg:left-0 max-lg:right-0 max-lg:z-40 max-lg:bg-background/85 max-lg:backdrop-blur-xl max-lg:border-t max-lg:border-border/60 max-lg:px-4 max-lg:py-3 max-lg:shadow-[0_-4px_16px_rgba(0,0,0,0.15)]">
          <div className="h-9 w-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
            <span className="text-xs font-bold text-primary/70">{t("avatarMe")}</span>
          </div>
          <div className="flex-1 flex items-center gap-2">
            <input
              type="text"
              value={newComment}
              onChange={(e) => setNewComment(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmitComment();
                }
              }}
              placeholder={communityConfig.commentPlaceholder}
              className="flex-1 h-10 px-4 rounded-full bg-card border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40"
            />
            <button
              onClick={handleSubmitComment}
              disabled={submitting || !newComment.trim()}
              className="h-10 w-10 rounded-full bg-primary text-white flex items-center justify-center shrink-0 hover:brightness-110 transition-colors shadow-sm min-h-[44px] min-w-[44px] disabled:opacity-50"
            >
              <Send className="h-4 w-4" />
            </button>
            {communityConfig.showBuddyFinder && (
              <button className="h-10 px-3 rounded-full border border-primary/30 text-xs font-medium text-primary/70 hover:bg-primary/10 transition-colors shrink-0 whitespace-nowrap">
                <Users className="inline h-3.5 w-3.5 mr-1" />
                {t("buddyFinder")}
              </button>
            )}
          </div>
        </div>
      </ScrollZone>

      {/* ──── Zone 4: 핀 고정 포스트 ──── */}
      <AnimatePresence mode="wait">
        {showPinned &&
          pinnedPosts.map((post) => (
            <motion.div
              key={post.id}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: 0.2 }}
            >
              <OrganizerPost
                item={post}
                onShare={(id) => setShareMenuId(shareMenuId === id ? null : id)}
              />
            </motion.div>
          ))}
      </AnimatePresence>

      {/* ──── Zone 4: 통합 피드 ──── */}
      <ScrollZone>
        <AnimatePresence mode="wait">
          <motion.div
            key={feedFilter}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            <motion.div
              className="divide-y divide-border/40"
              variants={stagger}
              initial="hidden"
              animate="visible"
            >
              {filteredPosts.map((item) => {
                if (item.role === "organizer") {
                  return (
                    <motion.div
                      key={item.id}
                      variants={fadeUp}
                      className="py-4 first:pt-0"
                    >
                      <OrganizerPost
                        item={item}
                        onShare={(id) =>
                          setShareMenuId(shareMenuId === id ? null : id)
                        }
                      />
                    </motion.div>
                  );
                }

                return (
                  <FeedItem
                    key={item.id}
                    item={item}
                    liked={likedIds.has(item.id)}
                    onLike={() => toggleLike(item.id)}
                    onShare={() =>
                      setShareMenuId(shareMenuId === item.id ? null : item.id)
                    }
                    onUserClick={(fi) =>
                      setProfileTarget({
                        userId: fi.userId ?? fi.id,
                        userName: fi.user,
                        avatar: fi.avatar,
                        role: fi.role,
                        fanLevel: fi.fanLevel,
                      })
                    }
                  />
                );
              })}
            </motion.div>
          </motion.div>
        </AnimatePresence>
      </ScrollZone>

      {/* 플로팅 응모 CTA 제거 — MobileStickyBottom과 중복 */}

      {/* 모바일 댓글 입력 여백 (하단 고정 바 높이만큼) */}
      <div className="h-16 lg:hidden" />

      {/* ──── 공유 바텀시트 (카드 프리뷰 포함) ──── */}
      <AnimatePresence>
        {shareMenuId && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50"
            onClick={() => setShareMenuId(null)}
          >
            <div className="fixed inset-0 bg-black/20" />
            <div className="fixed bottom-0 left-0 right-0 z-50">
              <motion.div
                initial={{ y: "100%" }}
                animate={{ y: 0 }}
                exit={{ y: "100%" }}
                transition={{ type: "spring", stiffness: 400, damping: 35 }}
                className="bg-card rounded-t-2xl border-t border-border p-4 pb-8 space-y-4"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="w-10 h-1 rounded-full bg-muted mx-auto" />

                {/* 공유 카드 프리뷰 */}
                <ShareCardPreview
                  userComment={shareItem?.text}
                  userName={shareItem?.user}
                  eventTitle={eventTitle}
                  eventDate={eventDate ?? ""}
                  venue={venue ?? ""}
                  eventId={eventId}
                  participantCount={totalComments}
                />

                {/* 공유 옵션 */}
                <div className="space-y-1">
                  <button
                    onClick={() => {
                      const url = `https://pickket.kr/events/${eventId}#${shareMenuId}`;
                      if (navigator.share) {
                        navigator
                          .share({ title: eventTitle, url })
                          .catch(() => {
                            // Web Share API 취소/거부는 사용자 액션 — 조용히 무시
                          });
                      } else {
                        window.open(
                          `https://www.instagram.com/`,
                          "_blank",
                          "noopener,noreferrer",
                        );
                      }
                      setShareMenuId(null);
                    }}
                    className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm text-foreground hover:bg-card transition-colors min-h-[48px]"
                  >
                    <span className="text-lg">📱</span>
                    {t("shareInstagram")}
                  </button>
                  <button
                    onClick={() => {
                      const url = `https://pickket.kr/events/${eventId}#${shareMenuId}`;
                      const text = shareItem?.text
                        ? `${shareItem.text} — ${eventTitle}`
                        : eventTitle;
                      window.open(
                        `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`,
                        "_blank",
                        "noopener,noreferrer",
                      );
                      setShareMenuId(null);
                    }}
                    className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm text-foreground hover:bg-card transition-colors min-h-[48px]"
                  >
                    <span className="text-lg">🐦</span>{t("shareX")}
                  </button>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(
                        `https://pickket.kr/events/${eventId}#${shareMenuId}`,
                      );
                      setShareMenuId(null);
                    }}
                    className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm text-foreground hover:bg-card transition-colors min-h-[48px]"
                  >
                    <Copy className="h-4 w-4 text-muted-foreground" />
                    {t("copyLink")}
                  </button>
                </div>
              </motion.div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ──── 유저 프로필 카드 ──── */}
      <UserProfileCard
        userId={profileTarget?.userId ?? ""}
        userName={profileTarget?.userName ?? ""}
        userAvatar={profileTarget?.avatar}
        role={profileTarget?.role ?? "fan"}
        fanLevel={profileTarget?.fanLevel}
        isOpen={!!profileTarget}
        onClose={() => setProfileTarget(null)}
      />
    </div>
  );
}
