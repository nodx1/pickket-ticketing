"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, Users } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { useAuthStore } from "@pickket/store";
import { createFanRequest } from "@pickket/lib/api";
import { api } from "@pickket/lib";

interface FanRequestArtist {
  id: string;
  name: string;
  image_url: string;
  genre: string;
  request_count: number;
  is_live: boolean;
  user_requested: boolean;
}

const RANK_COLORS = ["text-amber-500", "text-slate-400", "text-orange-600 dark:text-orange-400"];

export default function FanRequestsPage() {
  const t = useTranslations("fanRequests");
  const [artists, setArtists] = useState<FanRequestArtist[]>([]);
  const [loading, setLoading] = useState(true);
  const [genre, setGenre] = useState("");
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const user = useAuthStore((s) => s.user);

  const GENRE_TABS = [
    { label: t("genreAll"), value: "" },
    { label: "K-POP", value: "K-POP" },
    { label: t("genreTrot"), value: "트로트" },
    { label: t("genreClassic"), value: "클래식" },
    { label: t("genreSports"), value: "스포츠" },
    { label: t("genreEsports"), value: "e스포츠" },
  ];

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ limit: "100" });
    if (genre) params.set("genre", genre);

    api
      .get(`/fan-requests/ranking?${params}`)
      .then((res) => setArtists(res.data?.items ?? res.data ?? []))
      .catch(() => toast.error(t("errorLoadFailed")))
      .finally(() => setLoading(false));
  }, [genre]);

  const handleRequest = useCallback(
    async (artistId: string) => {
      if (!user) {
        toast.error(t("errorLoginRequired"), {
          action: {
            label: t("loginAction"),
            onClick: () => {
              window.location.href = "/auth";
            },
          },
        });
        return;
      }
      if (pendingIds.has(artistId)) return;
      setPendingIds((p) => new Set(p).add(artistId));

      try {
        await createFanRequest(artistId);
        setArtists((prev) =>
          prev.map((a) =>
            a.id === artistId
              ? { ...a, request_count: a.request_count + 1 }
              : a,
          ),
        );
        toast.success(t("successRequested"));
      } catch (err: unknown) {
        const axiosErr = err as { response?: { status?: number } };
        if (axiosErr?.response?.status === 409) {
          toast.info(t("infoAlreadyRequested"));
        } else {
          toast.error(t("errorRequestFailed"));
        }
      } finally {
        setPendingIds((p) => {
          const n = new Set(p);
          n.delete(artistId);
          return n;
        });
      }
    },
    [user, pendingIds],
  );

  const fmt = (n: number) => n.toLocaleString("ko-KR");

  return (
    <div className="min-h-screen bg-background pt-20">
      <div className="max-w-7xl mx-auto px-8 py-8">
        {/* 헤더 */}
        <div className="flex items-center gap-3 mb-8">
          <Link
            href="/"
            className="p-2 rounded-xl hover:bg-muted transition-colors"
          >
            <ArrowLeft className="h-5 w-5 text-muted-foreground" />
          </Link>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-foreground">
              {t("title")}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              {t("subtitle")}
            </p>
          </div>
        </div>

        {/* 장르 탭 */}
        <div className="flex gap-2 mb-6 overflow-x-auto scrollbar-hide">
          {GENRE_TABS.map((tab) => (
            <button
              key={tab.value}
              onClick={() => setGenre(tab.value)}
              className={`shrink-0 px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                genre === tab.value
                  ? "bg-primary text-white"
                  : "bg-muted text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* 리스트 */}
        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="h-20 rounded-2xl bg-muted animate-pulse"
              />
            ))}
          </div>
        ) : artists.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <Users className="h-12 w-12 mb-4 opacity-40" />
            <p className="text-sm">{t("emptyGenre")}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {artists.map((artist, index) => (
              <article
                key={artist.id}
                className="flex items-center gap-4 p-4 rounded-2xl bg-muted/30 border border-border hover:bg-muted/50 transition-colors"
              >
                <span
                  className={`text-lg font-black w-8 text-center ${RANK_COLORS[index] ?? "text-muted-foreground"}`}
                >
                  {index + 1}
                </span>

                <div className="relative w-12 h-12 rounded-full overflow-hidden bg-muted border border-border shrink-0">
                  {artist.image_url ? (
                    <Image
                      src={artist.image_url}
                      alt={artist.name}
                      fill
                      sizes="48px"
                      className="object-cover"
                    />
                  ) : (
                    <span className="absolute inset-0 flex items-center justify-center text-sm font-bold text-primary">
                      {artist.name.charAt(0)}
                    </span>
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-bold text-foreground">
                    {artist.name}
                  </h3>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-2xs font-medium text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                      {artist.genre}
                    </span>
                    <span className="text-xs font-bold text-primary font-tabular">
                      {t("requestCount", { count: artist.request_count ?? 0, formatted: fmt(artist.request_count ?? 0) })}
                    </span>
                  </div>
                </div>

                <button
                  type="button"
                  disabled={pendingIds.has(artist.id)}
                  onClick={() => handleRequest(artist.id)}
                  className="shrink-0 px-5 py-2.5 rounded-full text-xs font-bold transition-all active:scale-95 disabled:opacity-60 bg-primary text-white shadow-sm hover:shadow-md"
                >
                  {t("requestButton")}
                </button>
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
