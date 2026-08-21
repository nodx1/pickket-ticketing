"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { motion } from "motion/react";
import { Heart, ArrowLeft, Search } from "lucide-react";
import { Button } from "@pickket/ui";
import { useAuthStore } from "@pickket/store";
import { getFavorites, type Event } from "@pickket/lib/api";
import { useTranslations } from "next-intl";
import EventCard from "@/components/event/EventCard";
import { useAuthReady } from "@/providers/AuthProvider";

export default function FavoritesPage() {
  const router = useRouter();
  const { user } = useAuthStore();
  const ready = useAuthReady();
  const _t = useTranslations("mypage");
  const [favorites, setFavorites] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    // cookie bootstrap이 완료될 때까지 대기
    if (!ready) return;

    if (!user) {
      router.push("/auth");
      return;
    }

    async function loadFavorites() {
      try {
        const res = await getFavorites();
        setFavorites(res.data);
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    }

    loadFavorites();
  }, [ready, user, router]);

  // bootstrap 중이거나 로딩 중이면 스켈레톤 표시
  if (!ready || loading) {
    return (
      <div className="min-h-screen bg-background">
        <div className="max-w-7xl mx-auto px-8 pt-24 pb-10">
          <div className="flex items-center gap-3 mb-8">
            <div className="h-10 w-10 bg-white/10 rounded-full animate-pulse" />
            <div className="h-6 w-32 bg-white/10 rounded animate-pulse" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="bg-card rounded-2xl border border-white/8 overflow-hidden"
              >
                <div className="aspect-[4/3] bg-white/10 animate-pulse" />
                <div className="p-4 space-y-3">
                  <div className="h-5 bg-white/10 rounded animate-pulse w-3/4" />
                  <div className="h-4 bg-white/10 rounded animate-pulse w-1/2" />
                  <div className="h-4 bg-white/10 rounded animate-pulse w-2/3" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // bootstrap 완료 후 user 없으면 리다이렉트 대기 (useEffect에서 처리)
  if (!user) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
      className="min-h-screen bg-background"
    >
      <div className="max-w-7xl mx-auto px-8 pt-24 pb-10">
        {/* Header */}
        <div className="flex items-center gap-3 mb-8">
          <Link href="/mypage">
            <Button variant="ghost" size="icon" className="rounded-full">
              <ArrowLeft className="h-5 w-5" />
            </Button>
          </Link>
          <div className="flex items-center gap-2">
            <Heart className="h-5 w-5 text-red-500 fill-red-500" />
            <h1 className="text-xl font-bold text-foreground">찜한 이벤트</h1>
            {favorites.length > 0 && (
              <span className="text-sm text-muted-foreground ml-1">
                ({favorites.length})
              </span>
            )}
          </div>
        </div>

        {error ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="h-16 w-16 rounded-2xl bg-destructive/10 flex items-center justify-center mb-4">
              <Heart className="h-8 w-8 text-destructive" />
            </div>
            <h2 className="text-lg font-semibold text-foreground mb-2">
              불러오기 실패
            </h2>
            <p className="text-sm text-muted-foreground mb-6">
              찜 목록을 불러오는 중 오류가 발생했습니다.
            </p>
            <Button
              variant="outline"
              onClick={() => window.location.reload()}
              className="rounded-xl"
            >
              다시 시도
            </Button>
          </div>
        ) : favorites.length === 0 ? (
          /* Empty State */
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.1 }}
            className="flex flex-col items-center justify-center py-20 text-center"
          >
            <div className="relative mb-6">
              <div className="h-20 w-20 rounded-2xl bg-gradient-to-br from-red-100 to-pink-100 dark:from-red-900/20 dark:to-pink-900/20 flex items-center justify-center">
                <Heart className="h-10 w-10 text-red-400 dark:text-red-500" />
              </div>
            </div>
            <h2 className="text-lg font-semibold text-foreground mb-2">
              아직 찜한 이벤트가 없습니다
            </h2>
            <p className="text-sm text-muted-foreground mb-6 max-w-sm">
              마음에 드는 이벤트의 하트를 눌러 찜 목록에 추가해보세요. 관심 있는
              이벤트를 놓치지 않을 수 있습니다.
            </p>
            <Link href="/events">
              <Button className="rounded-xl bg-gradient-to-r from-primary to-primary/70 text-white px-6">
                <Search className="h-4 w-4 mr-2" />
                이벤트 둘러보기
              </Button>
            </Link>
          </motion.div>
        ) : (
          /* Event Grid */
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
            {favorites.map((event, index) => (
              <motion.div
                key={event.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  delay: index * 0.05,
                  duration: 0.3,
                  ease: "easeOut",
                }}
              >
                <EventCard event={event} />
              </motion.div>
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
}
