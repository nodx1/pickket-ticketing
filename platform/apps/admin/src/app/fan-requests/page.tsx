"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { motion } from "motion/react";
import { toast } from "sonner";
import {
  Loader2,
  Star,
  Search,
  Plus,
  ToggleLeft,
  ToggleRight,
} from "lucide-react";
import { Button, Badge, Input, Label } from "@pickket/ui";
import {
  getAdminFanRequests,
  updateFanRequestArtist,
  createFanRequestArtist,
  type FanRequestArtistRanking,
} from "@pickket/lib/api";

interface AdminFanRequestArtist extends FanRequestArtistRanking {
  is_featured?: boolean;
  is_active?: boolean;
}

export default function AdminFanRequestsPage() {
  const t = useTranslations("fanRequests");
  const [artists, setArtists] = useState<AdminFanRequestArtist[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Create sheet
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({
    name: "",
    genre: "",
    image_url: "",
  });
  const [creating, setCreating] = useState(false);

  // Debounce
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getAdminFanRequests(true);
      const data = Array.isArray(res) ? res : [];
      setArtists(data as AdminFanRequestArtist[]);
    } catch (err) {
      if ((err as Error)?.name === "CanceledError") return;
      toast.error(t("loadError"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = debouncedSearch
    ? artists.filter((a) =>
        a.name.toLowerCase().includes(debouncedSearch.toLowerCase()),
      )
    : artists;

  const handleFeatureToggle = async (artist: AdminFanRequestArtist) => {
    setActionLoading(`feature-${artist.id}`);
    try {
      await updateFanRequestArtist(artist.id, {
        is_featured: !artist.is_featured,
      });
      toast.success(
        t("featuredToggleSuccess", {
          name: artist.name ?? "",
          action: artist.is_featured ? t("featuredOff") : t("featuredOn"),
        }),
      );
      load();
    } catch {
      toast.error(t("featuredUpdateError"));
    } finally {
      setActionLoading(null);
    }
  };

  const handleActiveToggle = async (artist: AdminFanRequestArtist) => {
    setActionLoading(`active-${artist.id}`);
    try {
      const nextActive = artist.is_active === false ? true : false;
      await updateFanRequestArtist(artist.id, { is_active: nextActive });
      toast.success(
        t("activeToggleSuccess", {
          name: artist.name ?? "",
          action: nextActive ? t("activated") : t("deactivated"),
        }),
      );
      load();
    } catch {
      toast.error(t("activeUpdateError"));
    } finally {
      setActionLoading(null);
    }
  };

  const handleCreate = async () => {
    if (!createForm.name.trim()) {
      toast.error(t("nameRequired"));
      return;
    }
    setCreating(true);
    try {
      await createFanRequestArtist({
        name: createForm.name.trim(),
        genre: createForm.genre.trim() || undefined,
        image_url: createForm.image_url.trim() || undefined,
      });
      toast.success(t("createSuccess"));
      setShowCreate(false);
      setCreateForm({ name: "", genre: "", image_url: "" });
      load();
    } catch {
      toast.error(t("createError"));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-5 p-4 md:p-6">
      <h1 className="sr-only">{t("pageTitle")}</h1>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t("searchPlaceholder")}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-9 rounded-full"
          />
        </div>
        <Button className="rounded-full" onClick={() => setShowCreate(true)}>
          <Plus className="h-4 w-4 mr-1.5" />
          {t("registerArtist")}
        </Button>
      </div>

      <div className="rounded-lg border border-border bg-card">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            {debouncedSearch
              ? t("noSearchResults")
              : t("noArtists")}
          </div>
        ) : (
          <>
            <div className="hidden md:grid grid-cols-7 gap-2 px-5 py-3 text-xs font-medium text-muted-foreground border-b border-border">
              <span>{t("colRank")}</span>
              <span className="col-span-2">{t("colArtist")}</span>
              <span>{t("colGenre")}</span>
              <span className="text-right">{t("colRequestCount")}</span>
              <span className="text-center">{t("colFeatured")}</span>
              <span className="text-center">{t("colStatus")}</span>
            </div>
            <div className="divide-y divide-border">
              {filtered.map((artist, idx) => (
                <motion.div
                  key={artist.id}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: idx * 0.02 }}
                  className="grid grid-cols-2 md:grid-cols-7 gap-2 px-5 py-3.5 text-sm items-center hover:bg-muted/50 transition-colors"
                >
                  <span className="font-tabular text-muted-foreground">
                    {idx + 1}
                  </span>
                  <span className="col-span-2 font-medium truncate flex items-center gap-2">
                    {artist.image_url && (
                      <>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={artist.image_url}
                          alt=""
                          className="h-7 w-7 rounded-full object-cover shrink-0"
                        />
                      </>
                    )}
                    {artist.name}
                  </span>
                  <span className="hidden md:block text-muted-foreground">
                    {artist.genre || "-"}
                  </span>
                  <span className="text-right hidden md:block font-tabular">
                    {artist.request_count.toLocaleString()}
                  </span>
                  <span className="text-center hidden md:flex justify-center">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9"
                      title={t("featuredToggleTitle")}
                      disabled={actionLoading === `feature-${artist.id}`}
                      onClick={() => handleFeatureToggle(artist)}
                    >
                      {actionLoading === `feature-${artist.id}` ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Star
                          className={`h-4 w-4 ${
                            artist.is_featured
                              ? "text-amber-500 fill-amber-500"
                              : "text-muted-foreground"
                          }`}
                        />
                      )}
                    </Button>
                  </span>
                  <span className="text-center hidden md:flex justify-center items-center gap-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9"
                      title={t("activeToggleTitle")}
                      disabled={actionLoading === `active-${artist.id}`}
                      onClick={() => handleActiveToggle(artist)}
                    >
                      {actionLoading === `active-${artist.id}` ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : artist.is_active === false ? (
                        <ToggleLeft className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <ToggleRight className="h-4 w-4 text-green-500" />
                      )}
                    </Button>
                    <Badge
                      className="rounded-full"
                      variant={
                        artist.is_active === false ? "outline" : "secondary"
                      }
                    >
                      {artist.is_active === false ? t("inactive") : t("active")}
                    </Badge>
                  </span>
                </motion.div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Create Artist Modal (inline) */}
      {showCreate && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center"
        >
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => {
              setShowCreate(false);
              setCreateForm({ name: "", genre: "", image_url: "" });
            }}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ type: "spring", stiffness: 400, damping: 30 }}
            className="relative z-10 bg-card border border-border rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden"
          >
            {/* 헤더 */}
            <div
              style={{
                borderBottom: "1px solid var(--border)",
                padding: "20px 24px",
                background: "var(--muted)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <div>
                  <h2
                    style={{
                      fontSize: "18px",
                      fontWeight: 700,
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                    }}
                  >
                    <Star className="h-5 w-5 text-primary" />
                    {t("registerArtist")}
                  </h2>
                  <p
                    style={{
                      fontSize: "14px",
                      color: "var(--muted-foreground)",
                      marginTop: "4px",
                    }}
                  >
                    {t("registerArtistDesc")}
                  </p>
                </div>
                <button
                  onClick={() => {
                    setShowCreate(false);
                    setCreateForm({ name: "", genre: "", image_url: "" });
                  }}
                  style={{
                    padding: "6px",
                    borderRadius: "8px",
                    cursor: "pointer",
                  }}
                >
                  <Plus className="h-4 w-4 rotate-45" />
                </button>
              </div>
            </div>
            {/* 바디 */}
            <div
              style={{
                padding: "20px 24px",
                display: "flex",
                flexDirection: "column",
                gap: "16px",
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="artist-name">{t("labelName")}</Label>
                <Input
                  id="artist-name"
                  placeholder={t("placeholderName")}
                  value={createForm.name}
                  onChange={(e) =>
                    setCreateForm((f) => ({ ...f, name: e.target.value }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="artist-genre">{t("labelGenre")}</Label>
                <Input
                  id="artist-genre"
                  placeholder={t("placeholderGenre")}
                  value={createForm.genre}
                  onChange={(e) =>
                    setCreateForm((f) => ({ ...f, genre: e.target.value }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="artist-image">{t("labelImageUrl")}</Label>
                <Input
                  id="artist-image"
                  placeholder="https://..."
                  value={createForm.image_url}
                  onChange={(e) =>
                    setCreateForm((f) => ({ ...f, image_url: e.target.value }))
                  }
                />
              </div>
            </div>
            {/* 푸터 */}
            <div
              style={{
                borderTop: "1px solid var(--border)",
                padding: "16px 24px",
                display: "flex",
                gap: "8px",
              }}
            >
              <Button
                variant="outline"
                className="flex-1 rounded-full"
                onClick={() => {
                  setShowCreate(false);
                  setCreateForm({ name: "", genre: "", image_url: "" });
                }}
              >
                {t("cancel")}
              </Button>
              <Button
                className="flex-1 rounded-full"
                disabled={creating || !createForm.name.trim()}
                onClick={handleCreate}
              >
                {creating && (
                  <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
                )}
                {t("register")}
              </Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </div>
  );
}
