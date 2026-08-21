"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { motion } from "motion/react";
import { toast } from "sonner";
import { Loader2, Award, Search } from "lucide-react";
import {
  Button,
  Badge,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@pickket/ui";
import {
  getAdminCommunities,
  toggleCommunityOfficial,
  isApiCanceled,
  type AdminCommunity,
} from "@pickket/lib/api";
import { formatDate } from "@pickket/lib";

export default function AdminCommunitiesPage() {
  const tl = useTranslations("communities");

  const COMMUNITY_TYPE_LABEL: Record<string, string> = {
    fanclub: tl("typeFanclub"),
    supporter: tl("typeSupporter"),
    guild: tl("typeGuild"),
    association: tl("typeAssociation"),
    society: tl("typeSociety"),
    general: tl("typeGeneral"),
  };

  const TYPE_OPTIONS = [
    { value: "all", label: tl("typeAll") },
    { value: "fanclub", label: tl("typeFanclub") },
    { value: "supporter", label: tl("typeSupporter") },
    { value: "guild", label: tl("typeGuild") },
    { value: "association", label: tl("typeAssociation") },
    { value: "society", label: tl("typeSociety") },
    { value: "general", label: tl("typeGeneral") },
  ];

  const [communities, setCommunities] = useState<AdminCommunity[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [skip, setSkip] = useState(0);
  const limit = 50;

  // Sheet detail
  const [detailCommunity, setDetailCommunity] = useState<AdminCommunity | null>(
    null,
  );

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    setSkip(0);
  }, [debouncedSearch, filter, typeFilter]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, unknown> = { skip, limit };
      if (filter === "official") params.is_official = true;
      if (filter === "unofficial") params.is_official = false;
      if (typeFilter !== "all") params.community_type = typeFilter;
      if (debouncedSearch) params.q = debouncedSearch;
      const data = await getAdminCommunities(
        params as Parameters<typeof getAdminCommunities>[0],
      );
      setCommunities(data.communities);
      setTotal(data.total);
    } catch (err) {
      if (isApiCanceled(err)) return;
      toast.error(tl("loadError"));
    } finally {
      setLoading(false);
    }
  }, [filter, typeFilter, debouncedSearch, skip]);

  useEffect(() => {
    load();
  }, [load]);

  const handleOfficial = async (c: AdminCommunity) => {
    setActionLoading(c.id);
    try {
      await toggleCommunityOfficial(c.id);
      toast.success(
        c.is_official
          ? tl("officialRevoked", { name: c.name ?? "" })
          : tl("officialGranted", { name: c.name ?? "" }),
      );
      load();
    } catch {
      toast.error(tl("officialToggleError"));
    } finally {
      setActionLoading(null);
    }
  };

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="space-y-5 p-4 md:p-6">
      <h1 className="sr-only">{tl("pageTitle")}</h1>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={tl("searchPlaceholder")}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-9 rounded-full"
          />
        </div>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-[140px] rounded-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TYPE_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={filter}
          onValueChange={(v) => {
            setFilter(v);
            setSkip(0);
          }}
        >
          <SelectTrigger className="w-[140px] rounded-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{tl("filterAll")}</SelectItem>
            <SelectItem value="official">{tl("filterOfficial")}</SelectItem>
            <SelectItem value="unofficial">{tl("filterUnofficial")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-lg border border-border bg-card">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : communities.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            {tl("empty")}
          </div>
        ) : (
          <>
            <div className="hidden md:grid grid-cols-7 gap-2 px-5 py-3 text-xs font-medium text-muted-foreground border-b border-border">
              <span>{tl("colName")}</span>
              <span>{tl("colSubject")}</span>
              <span>{tl("colType")}</span>
              <span className="text-center">{tl("colMembers")}</span>
              <span className="text-center">{tl("colOfficial")}</span>
              <span className="text-right">{tl("colCreatedAt")}</span>
              <span className="text-right">{tl("colAction")}</span>
            </div>
            <div className="divide-y divide-border">
              {communities.map((c, idx) => (
                <motion.div
                  key={c.id}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: idx * 0.02 }}
                  className="grid grid-cols-2 md:grid-cols-7 gap-2 px-5 py-3.5 text-sm items-center hover:bg-muted/50 transition-colors cursor-pointer"
                  onClick={(ev) => {
                    const target = ev.target as HTMLElement;
                    if (target.closest("button")) return;
                    setDetailCommunity(c);
                  }}
                >
                  <span className="font-medium truncate">{c.name}</span>
                  <span className="text-muted-foreground truncate hidden md:block">
                    {c.subject_name || c.artist_name}
                  </span>
                  <span className="hidden md:block">
                    <Badge className="rounded-full" variant="secondary">
                      {COMMUNITY_TYPE_LABEL[c.community_type] ??
                        c.community_type}
                    </Badge>
                  </span>
                  <span className="text-center hidden md:block font-tabular">
                    {c.member_count.toLocaleString()}
                  </span>
                  <span className="text-center hidden md:block">
                    {c.is_official ? (
                      <Badge
                        className="rounded-full bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300"
                        variant="secondary"
                      >
                        {tl("filterOfficial")}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">-</span>
                    )}
                  </span>
                  <span className="text-right text-xs text-muted-foreground hidden md:block">
                    {formatDate(c.created_at)}
                  </span>
                  <span
                    className="text-right"
                    onClick={(ev) => ev.stopPropagation()}
                  >
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9"
                      title={tl("officialToggleTitle")}
                      disabled={actionLoading === c.id}
                      onClick={() => handleOfficial(c)}
                    >
                      {actionLoading === c.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Award
                          className={`h-4 w-4 ${c.is_official ? "text-green-500" : "text-muted-foreground"}`}
                        />
                      )}
                    </Button>
                  </span>
                </motion.div>
              ))}
            </div>
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-4 py-4 border-t border-border">
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-full"
                  disabled={skip === 0}
                  onClick={() => setSkip((s) => Math.max(0, s - limit))}
                >
                  {tl("pagePrev")}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {Math.floor(skip / limit) + 1} / {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-full"
                  disabled={skip + limit >= total}
                  onClick={() => setSkip((s) => s + limit)}
                >
                  {tl("pageNext")}
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Community Detail Sheet */}
      <Sheet
        open={!!detailCommunity}
        onOpenChange={(open) => {
          if (!open) setDetailCommunity(null);
        }}
      >
        <SheetContent className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{detailCommunity?.name}</SheetTitle>
            <SheetDescription>{tl("detailDescription")}</SheetDescription>
          </SheetHeader>
          {detailCommunity && (
            <div className="space-y-4 mt-6 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">{tl("detailId")}</span>
                <span className="font-mono text-xs truncate max-w-[200px]">
                  {detailCommunity.id}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">{tl("colName")}</span>
                <span>{detailCommunity.name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">{tl("colSubject")}</span>
                <span>
                  {detailCommunity.subject_name ||
                    detailCommunity.artist_name ||
                    "-"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">{tl("colType")}</span>
                <Badge className="rounded-full" variant="secondary">
                  {COMMUNITY_TYPE_LABEL[detailCommunity.community_type] ??
                    detailCommunity.community_type}
                </Badge>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">{tl("detailMemberCount")}</span>
                <span className="font-tabular">
                  {detailCommunity.member_count.toLocaleString()}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">{tl("detailOfficialLabel")}</span>
                <span>{detailCommunity.is_official ? tl("filterOfficial") : tl("filterUnofficial")}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">{tl("detailDomain")}</span>
                <span>{detailCommunity.domain || "-"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">{tl("colCreatedAt")}</span>
                <span>{formatDate(detailCommunity.created_at)}</span>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
