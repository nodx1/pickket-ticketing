"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { motion, AnimatePresence } from "motion/react";
import {
  Star,
  ThumbsUp,
  Trash2,
  ChevronDown,
  ShieldCheck,
  MessageSquarePlus,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { Button, Badge, Textarea, Input } from "@pickket/ui";
import {
  getEventReviews,
  getReviewSummary,
  createReview,
  markReviewHelpful,
  deleteReview,
  type ReviewData,
} from "@pickket/lib/api";
import { useAuthStore } from "@pickket/store";
import { useQuery, useQueryClient } from "@tanstack/react-query";

/* ── Star Rating Component ─────────────────────────────────────────────────── */

interface StarRatingProps {
  value: number;
  onChange?: (value: number) => void;
  size?: "sm" | "md" | "lg";
  interactive?: boolean;
}

function StarRating({
  value,
  onChange,
  size = "md",
  interactive = false,
}: StarRatingProps) {
  const [hoverValue, setHoverValue] = useState(0);

  const sizeMap = {
    sm: "h-3.5 w-3.5",
    md: "h-5 w-5",
    lg: "h-7 w-7",
  };

  const iconSize = sizeMap[size];

  return (
    <div className="inline-flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((star) => {
        const filled = star <= (hoverValue || value);
        return (
          <button
            key={star}
            type="button"
            disabled={!interactive}
            onClick={() => onChange?.(star)}
            onMouseEnter={() => interactive && setHoverValue(star)}
            onMouseLeave={() => interactive && setHoverValue(0)}
            className={`${interactive ? "cursor-pointer hover:scale-110 transition-transform" : "cursor-default"} focus:outline-none`}
          >
            <Star
              className={`${iconSize} transition-colors ${
                filled
                  ? "fill-amber-400 text-amber-400"
                  : "fill-none text-muted-foreground/30"
              }`}
            />
          </button>
        );
      })}
    </div>
  );
}

/* ── Rating Distribution Bar ───────────────────────────────────────────────── */

interface RatingBarProps {
  star: number;
  count: number;
  total: number;
}

function RatingBar({ star, count, total }: RatingBarProps) {
  const pct = total > 0 ? (count / total) * 100 : 0;

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-3 text-right text-muted-foreground font-medium">
        {star}
      </span>
      <Star className="h-3 w-3 fill-amber-400 text-amber-400 shrink-0" />
      <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
        <motion.div
          className="h-full bg-amber-400 rounded-full"
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.6, ease: "easeOut" }}
        />
      </div>
      <span className="w-8 text-right text-muted-foreground tabular-nums">
        {count}
      </span>
    </div>
  );
}

/* ── Review Card ───────────────────────────────────────────────────────────── */

interface ReviewCardProps {
  review: ReviewData;
  eventId: string;
  currentUserId?: string;
  onHelpful: (reviewId: string) => void;
  onDelete: (reviewId: string) => void;
}

function ReviewCard({
  review,
  eventId,
  currentUserId,
  onHelpful,
  onDelete,
}: ReviewCardProps) {
  const t = useTranslations("event.reviewSection");
  const [helpfulLoading, setHelpfulLoading] = useState(false);
  const isOwn = currentUserId === review.user_id;

  const formattedDate = new Date(review.created_at).toLocaleDateString(
    "ko-KR",
    {
      year: "numeric",
      month: "long",
      day: "numeric",
    },
  );

  const handleHelpful = async () => {
    if (isOwn) return;
    setHelpfulLoading(true);
    try {
      await markReviewHelpful(eventId, review.id);
      onHelpful(review.id);
    } catch {
      toast.error(t("helpfulFailed"));
    } finally {
      setHelpfulLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(t("deleteConfirm"))) return;
    try {
      await deleteReview(eventId, review.id);
      onDelete(review.id);
      toast.success(t("deleteSuccess"));
    } catch {
      toast.error(t("deleteFailed"));
    }
  };

  // Mask reviewer name for privacy (e.g., "홍길동" -> "홍*동")
  const maskedName =
    review.reviewer_name.length >= 2
      ? review.reviewer_name[0] +
        "*".repeat(review.reviewer_name.length - 2) +
        review.reviewer_name[review.reviewer_name.length - 1]
      : review.reviewer_name || t("anonymous");

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      transition={{ duration: 0.3 }}
      className="border-b border-border/50 last:border-b-0 py-4 first:pt-0"
    >
      {/* Header: name + badge + date */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground">
            {maskedName}
          </span>
          {review.is_verified_attendee && (
            <Badge
              variant="secondary"
              className="text-2xs bg-emerald-50 text-emerald-700 border-emerald-200 gap-0.5"
            >
              <ShieldCheck className="h-2.5 w-2.5" />
              {t("verifiedAttendee")}
            </Badge>
          )}
        </div>
        <span className="text-xs-plus text-muted-foreground">
          {formattedDate}
        </span>
      </div>

      {/* Rating */}
      <div className="mb-2">
        <StarRating value={review.rating} size="sm" />
      </div>

      {/* Title */}
      <h4 className="text-sm font-semibold text-foreground mb-1">
        {review.title}
      </h4>

      {/* Content */}
      <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap">
        {review.content}
      </p>

      {/* Actions */}
      <div className="flex items-center gap-3 mt-3">
        {!isOwn && (
          <button
            onClick={handleHelpful}
            disabled={helpfulLoading}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {helpfulLoading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <ThumbsUp className="h-3 w-3" />
            )}
            {t("helpful")}{" "}
            {review.helpful_count > 0 && `(${review.helpful_count})`}
          </button>
        )}
        {isOwn && (
          <button
            onClick={handleDelete}
            className="inline-flex items-center gap-1 text-xs text-destructive/70 hover:text-destructive transition-colors"
          >
            <Trash2 className="h-3 w-3" />
            {t("delete")}
          </button>
        )}
      </div>
    </motion.div>
  );
}

/* ── Write Review Form ─────────────────────────────────────────────────────── */

interface WriteReviewFormProps {
  eventId: string;
  onSuccess: (review: ReviewData) => void;
  onCancel: () => void;
}

function WriteReviewForm({
  eventId,
  onSuccess,
  onCancel,
}: WriteReviewFormProps) {
  const t = useTranslations("event.reviewSection");
  const [rating, setRating] = useState(0);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const canSubmit =
    rating >= 1 && title.trim().length >= 1 && content.trim().length >= 10;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    setSubmitting(true);
    try {
      const review = await createReview(eventId, {
        rating,
        title: title.trim(),
        content: content.trim(),
      });
      toast.success(t("createSuccess"));
      onSuccess(review);
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })
        ?.response?.data?.detail;
      toast.error(detail || t("createFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <motion.form
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.3 }}
      onSubmit={handleSubmit}
      className="overflow-hidden"
    >
      <div className="bg-muted/30 rounded-xl p-4 space-y-4 border border-border/50">
        <h4 className="text-sm font-semibold text-foreground">{t("writeReview")}</h4>

        {/* Rating selection */}
        <div>
          <label className="text-xs text-muted-foreground mb-1.5 block">
            {t("ratingLabel")}
          </label>
          <StarRating
            value={rating}
            onChange={setRating}
            size="lg"
            interactive
          />
          {rating === 0 && (
            <p className="text-xs-plus text-muted-foreground mt-1">
              {t("ratingPlaceholder")}
            </p>
          )}
        </div>

        {/* Title */}
        <div>
          <label className="text-xs text-muted-foreground mb-1.5 block">
            {t("titleLabel")}
          </label>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("titlePlaceholder")}
            maxLength={200}
            className="rounded-lg"
          />
        </div>

        {/* Content */}
        <div>
          <label className="text-xs text-muted-foreground mb-1.5 block">
            {t("contentLabel")}{" "}
            <span className="text-muted-foreground/50">
              ({content.length}/2000)
            </span>
          </label>
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={t("contentPlaceholder")}
            maxLength={2000}
            rows={4}
            className="rounded-lg resize-none"
          />
          {content.length > 0 && content.length < 10 && (
            <p className="text-xs-plus text-destructive mt-1">
              {t("contentMinLength")}
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 pt-1">
          <Button
            type="submit"
            disabled={!canSubmit || submitting}
            className="rounded-full bg-primary hover:bg-primary/90 text-white px-5 h-9 text-sm"
          >
            {submitting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                {t("submitting")}
              </>
            ) : (
              t("submitReview")
            )}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            className="rounded-full px-5 h-9 text-sm"
          >
            {t("cancel")}
          </Button>
        </div>
      </div>
    </motion.form>
  );
}

/* ── Main ReviewSection ────────────────────────────────────────────────────── */

interface ReviewSectionProps {
  eventId: string;
  /** When set, only show first N reviews (peek mode for bento grid) */
  peek?: number;
}

export default function ReviewSection({
  eventId,
  peek: _peek,
}: ReviewSectionProps) {
  const t = useTranslations("event.reviewSection");
  const user = useAuthStore((s) => s.user);

  const queryClient = useQueryClient();
  const [reviews, setReviews] = useState<ReviewData[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  const PAGE_SIZE = 20;

  /* Initial data fetch */
  const { data: initialData, isLoading: loading } = useQuery({
    queryKey: ["events", eventId, "reviews"],
    queryFn: async () => {
      const [reviewsData, summaryData] = await Promise.all([
        getEventReviews(eventId, 0, PAGE_SIZE),
        getReviewSummary(eventId),
      ]);
      return { reviews: reviewsData, summary: summaryData };
    },
  });

  const summary = initialData?.summary ?? null;

  // Sync initial reviews into local state for pagination/mutations
  useEffect(() => {
    if (initialData?.reviews) {
      setReviews(initialData.reviews);
      setHasMore(initialData.reviews.length >= PAGE_SIZE);
    }
  }, [initialData?.reviews]);

  /* Load more */
  const handleLoadMore = async () => {
    setLoadingMore(true);
    try {
      const more = await getEventReviews(eventId, reviews.length, PAGE_SIZE);
      setReviews((prev) => [...prev, ...more]);
      setHasMore(more.length >= PAGE_SIZE);
    } catch {
      toast.error(t("loadMoreFailed"));
    } finally {
      setLoadingMore(false);
    }
  };

  /* Callbacks */
  const handleReviewCreated = (review: ReviewData) => {
    setReviews((prev) => [review, ...prev]);
    setShowForm(false);
    queryClient.invalidateQueries({ queryKey: ["events", eventId, "reviews"] });
  };

  const handleHelpful = (reviewId: string) => {
    setReviews((prev) =>
      prev.map((r) =>
        r.id === reviewId ? { ...r, helpful_count: r.helpful_count + 1 } : r,
      ),
    );
  };

  const handleDelete = (reviewId: string) => {
    setReviews((prev) => prev.filter((r) => r.id !== reviewId));
    queryClient.invalidateQueries({ queryKey: ["events", eventId, "reviews"] });
  };

  /* Check if user already has a review */
  const userHasReview = user
    ? reviews.some((r) => r.user_id === user.id)
    : false;

  /* Loading skeleton */
  if (loading) {
    return (
      <section className="bg-card/90 backdrop-blur-sm rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] dark:shadow-[0_2px_16px_rgba(0,0,0,0.2)] p-5 lg:p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-6 bg-muted rounded w-32" />
          <div className="flex gap-6">
            <div className="h-20 w-20 bg-muted rounded-lg" />
            <div className="flex-1 space-y-2">
              {[5, 4, 3, 2, 1].map((i) => (
                <div key={i} className="h-2 bg-muted rounded-full" />
              ))}
            </div>
          </div>
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="space-y-2">
                <div className="h-4 bg-muted rounded w-1/3" />
                <div className="h-3 bg-muted rounded w-full" />
                <div className="h-3 bg-muted rounded w-2/3" />
              </div>
            ))}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="bg-card/90 backdrop-blur-sm rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] dark:shadow-[0_2px_16px_rgba(0,0,0,0.2)] p-5 lg:p-6">
      {/* Section header */}
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
          <Star className="h-5 w-5 text-amber-400 fill-amber-400" />
          {t("sectionTitle")}
          {summary && summary.total_reviews > 0 && (
            <span className="text-sm font-normal text-muted-foreground ml-1">
              ({summary.total_reviews})
            </span>
          )}
        </h2>
        {user && !userHasReview && !showForm && (
          <Button
            size="sm"
            onClick={() => setShowForm(true)}
            className="rounded-full bg-primary hover:bg-primary/90 text-white text-xs h-8 px-4"
          >
            <MessageSquarePlus className="h-3.5 w-3.5 mr-1" />
            {t("writeReviewBtn")}
          </Button>
        )}
      </div>

      {/* Summary (avg rating + distribution) */}
      {summary && summary.total_reviews > 0 && (
        <div className="flex flex-col sm:flex-row gap-5 mb-6 pb-5 border-b border-border/50">
          {/* Average score */}
          <div className="flex flex-col items-center justify-center min-w-[100px]">
            <span className="text-2xl sm:text-3xl md:text-4xl font-bold text-foreground tabular-nums">
              {summary.average_rating.toFixed(1)}
            </span>
            <StarRating value={Math.round(summary.average_rating)} size="sm" />
            <span className="text-xs-plus text-muted-foreground mt-1">
              {t("reviewCount", { count: summary.total_reviews ?? 0 })}
            </span>
          </div>

          {/* Distribution bars */}
          <div className="flex-1 space-y-1.5">
            {[5, 4, 3, 2, 1].map((star) => (
              <RatingBar
                key={star}
                star={star}
                count={summary.rating_distribution[star] || 0}
                total={summary.total_reviews}
              />
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {(!summary || summary.total_reviews === 0) && !showForm && (
        <div className="text-center py-8">
          <div className="mx-auto mb-4 w-14 h-14 rounded-2xl bg-gradient-to-br from-amber-50 to-amber-100/50 flex items-center justify-center">
            <Star className="h-7 w-7 text-amber-300" />
          </div>
          <p className="text-sm font-semibold text-foreground mb-1">
            {t("emptyTitle")}
          </p>
          <p className="text-xs text-muted-foreground mb-4">
            {t("emptySubtitle")}
          </p>
          {user && !userHasReview && (
            <Button
              size="sm"
              onClick={() => setShowForm(true)}
              className="rounded-full bg-primary hover:bg-primary/90 text-white text-xs h-8 px-4"
            >
              <MessageSquarePlus className="h-3.5 w-3.5 mr-1" />
              {t("writeReviewBtn")}
            </Button>
          )}
        </div>
      )}

      {/* Write review form */}
      <AnimatePresence>
        {showForm && (
          <div className="mb-5">
            <WriteReviewForm
              eventId={eventId}
              onSuccess={handleReviewCreated}
              onCancel={() => setShowForm(false)}
            />
          </div>
        )}
      </AnimatePresence>

      {/* Review list */}
      {reviews.length > 0 && (
        <div>
          <AnimatePresence mode="popLayout">
            {reviews.map((review) => (
              <ReviewCard
                key={review.id}
                review={review}
                eventId={eventId}
                currentUserId={user?.id}
                onHelpful={handleHelpful}
                onDelete={handleDelete}
              />
            ))}
          </AnimatePresence>

          {/* Load more */}
          {hasMore && (
            <div className="pt-4 text-center">
              <Button
                variant="outline"
                size="sm"
                onClick={handleLoadMore}
                disabled={loadingMore}
                className="rounded-full px-5 h-8 text-xs"
              >
                {loadingMore ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin mr-1.5" />
                    {t("loadingMore")}
                  </>
                ) : (
                  <>
                    <ChevronDown className="h-3 w-3 mr-1" />{t("loadMore")}
                  </>
                )}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Login prompt for non-authenticated users */}
      {!user && reviews.length > 0 && (
        <div className="mt-4 pt-4 border-t border-border/50 text-center">
          <p className="text-xs text-muted-foreground">
            {t("loginRequired")}
          </p>
        </div>
      )}
    </section>
  );
}
