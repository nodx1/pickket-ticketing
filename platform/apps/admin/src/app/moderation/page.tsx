"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { motion } from "motion/react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import {
  Search,
  Trash2,
  Loader2,
  MessageSquare,
  ThumbsUp,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import {
  Button,
  Badge,
  Input,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@pickket/ui";
import {
  getAdminEvents,
  getEventComments,
  deleteComment,
  isApiCanceled,
  type EventComment,
} from "@pickket/lib/api";
import { formatDate } from "@pickket/lib";

const ROLE_LABEL_KEYS: Record<string, string> = {
  organizer: "roleOrganizer",
  artist: "roleArtist",
  fan: "roleFan",
  verified: "roleVerified",
};

const ROLE_VARIANTS: Record<string, string> = {
  organizer:
    "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  artist: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  fan: "bg-gray-100 text-gray-700 dark:bg-gray-800/60 dark:text-gray-300",
  verified:
    "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
};

const PAGE_SIZE = 20;

export default function ModerationPage() {
  const t = useTranslations("moderation");
  const [eventSearch, setEventSearch] = useState("");
  const [events, setEvents] = useState<{ id: string; title: string }[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<{
    id: string;
    title: string;
  } | null>(null);

  const [comments, setComments] = useState<EventComment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<"recent" | "popular">("recent");
  const [roleFilter, setRoleFilter] = useState("all");

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Search events
  useEffect(() => {
    if (!eventSearch.trim()) {
      setEvents([]);
      return;
    }
    const timeout = setTimeout(async () => {
      setEventsLoading(true);
      try {
        const data = await getAdminEvents({ q: eventSearch, limit: 10 });
        setEvents(data.events ?? []);
      } catch (err) {
        if (isApiCanceled(err)) return;
        toast.error(t("errorEventSearch"));
      } finally {
        setEventsLoading(false);
      }
    }, 300);
    return () => clearTimeout(timeout);
  }, [eventSearch]);

  // Load comments when event/sort/filter/page changes
  const loadComments = useCallback(async () => {
    if (!selectedEvent) return;
    setCommentsLoading(true);
    try {
      const { data: res } = await getEventComments(selectedEvent.id, {
        skip: page * PAGE_SIZE,
        limit: PAGE_SIZE,
        sort,
        filter: roleFilter === "all" ? undefined : roleFilter,
      });
      setComments(res.items ?? []);
      setTotal(res.total ?? 0);
    } catch (err) {
      if (isApiCanceled(err)) return;
      toast.error(t("errorLoadComments"));
    } finally {
      setCommentsLoading(false);
    }
  }, [selectedEvent, page, sort, roleFilter]);

  useEffect(() => {
    loadComments();
  }, [loadComments]);

  // Reset page on filter/sort change
  useEffect(() => {
    setPage(0);
  }, [sort, roleFilter]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const allSelected = useMemo(
    () => comments.length > 0 && comments.every((c) => selected.has(c.id)),
    [comments, selected],
  );

  const toggleAll = () => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(comments.map((c) => c.id)));
    }
  };

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleBulkDelete = async () => {
    setDeleting(true);
    try {
      await Promise.all(
        [...selected].map((id) => deleteComment(selectedEvent!.id, id)),
      );
      toast.success(t("toastDeleteSuccess", { count: selected.size ?? 0 }));
      setSelected(new Set());
      setDeleteOpen(false);
      loadComments();
    } catch {
      toast.error(t("errorDeletePartial"));
    } finally {
      setDeleting(false);
    }
  };

  const selectEvent = (ev: { id: string; title: string }) => {
    setSelectedEvent(ev);
    setEventSearch("");
    setEvents([]);
    setPage(0);
    setSelected(new Set());
  };

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex items-center gap-3">
        <MessageSquare className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-bold">{t("pageTitle")}</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {t("pageDescription")}
          </p>
        </div>
      </div>

      {/* Event Search */}
      <div className="rounded-lg border border-border bg-card p-5">
        <div className="relative max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t("searchPlaceholder")}
            value={eventSearch}
            onChange={(e) => setEventSearch(e.target.value)}
            className="pl-9 rounded-lg"
          />
          {eventsLoading && (
            <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin" />
          )}
        </div>
        {events.length > 0 && (
          <ul className="mt-2 rounded-lg border border-border bg-popover max-h-48 overflow-y-auto">
            {events.map((ev) => (
              <li
                key={ev.id}
                className="px-4 py-2 text-sm cursor-pointer hover:bg-muted/50 transition-colors"
                onClick={() => selectEvent(ev)}
              >
                {ev.title}
              </li>
            ))}
          </ul>
        )}
        {selectedEvent && (
          <p className="mt-3 text-sm">
            {t("selectedEvent")}{" "}
            <span className="font-medium">{selectedEvent.title}</span>
          </p>
        )}
      </div>

      {/* Controls & Table */}
      {selectedEvent && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-4"
        >
          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-3">
            <Select
              value={sort}
              onValueChange={(v) => setSort(v as "recent" | "popular")}
            >
              <SelectTrigger className="w-32 rounded-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="recent">{t("sortRecent")}</SelectItem>
                <SelectItem value="popular">{t("sortPopular")}</SelectItem>
              </SelectContent>
            </Select>

            <Select value={roleFilter} onValueChange={setRoleFilter}>
              <SelectTrigger className="w-32 rounded-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("filterAllRoles")}</SelectItem>
                <SelectItem value="organizer">{t("roleOrganizer")}</SelectItem>
                <SelectItem value="artist">{t("roleArtist")}</SelectItem>
                <SelectItem value="fan">{t("roleFan")}</SelectItem>
                <SelectItem value="verified">{t("roleVerified")}</SelectItem>
              </SelectContent>
            </Select>

            {selected.size > 0 && (
              <Button
                variant="destructive"
                size="sm"
                className="rounded-lg gap-1.5"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t("btnDeleteCount", { count: selected.size ?? 0 })}
              </Button>
            )}
          </div>

          {/* Comment Table */}
          <div className="rounded-lg border border-border bg-card">
            {commentsLoading ? (
              <div className="flex justify-center py-16">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : comments.length === 0 ? (
              <div className="text-center py-16 text-muted-foreground">
                {t("emptyComments")}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="px-4 py-2.5 w-10">
                        <input
                          type="checkbox"
                          checked={allSelected}
                          onChange={toggleAll}
                          className="rounded"
                        />
                      </th>
                      <th className="text-left px-4 py-2.5 font-medium text-xs text-muted-foreground">
                        {t("colAuthor")}
                      </th>
                      <th className="text-left px-4 py-2.5 font-medium text-xs text-muted-foreground">
                        {t("colRole")}
                      </th>
                      <th className="text-left px-4 py-2.5 font-medium text-xs text-muted-foreground min-w-[240px]">
                        {t("colContent")}
                      </th>
                      <th className="text-left px-4 py-2.5 font-medium text-xs text-muted-foreground">
                        {t("colLikes")}
                      </th>
                      <th className="text-left px-4 py-2.5 font-medium text-xs text-muted-foreground">
                        {t("colCreatedAt")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {comments.map((c, idx) => (
                      <motion.tr
                        key={c.id}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: idx * 0.015 }}
                        className="border-b last:border-b-0 hover:bg-muted/30 transition-colors"
                      >
                        <td className="px-4 py-2.5">
                          <input
                            type="checkbox"
                            checked={selected.has(c.id)}
                            onChange={() => toggleOne(c.id)}
                            className="rounded"
                          />
                        </td>
                        <td className="px-4 py-2.5 whitespace-nowrap font-medium">
                          {c.user_name}
                        </td>
                        <td className="px-4 py-2.5">
                          <Badge
                            variant="secondary"
                            className={
                              ROLE_VARIANTS[c.role] ?? ROLE_VARIANTS.fan
                            }
                          >
                            {ROLE_LABEL_KEYS[c.role] ? t(ROLE_LABEL_KEYS[c.role]) : c.role}
                          </Badge>
                        </td>
                        <td
                          className="px-4 py-2.5 max-w-xs truncate"
                          title={c.content}
                        >
                          {c.content}
                        </td>
                        <td className="px-4 py-2.5 whitespace-nowrap font-tabular">
                          <span className="inline-flex items-center gap-1">
                            <ThumbsUp className="h-3.5 w-3.5 text-muted-foreground" />
                            {c.likes_count}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 whitespace-nowrap text-muted-foreground">
                          {formatDate(c.created_at)}
                        </td>
                      </motion.tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Pagination */}
            {total > PAGE_SIZE && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-border">
                <span className="text-xs text-muted-foreground">
                  {t("paginationRange", {
                    total: total ?? 0,
                    from: (page ?? 0) * PAGE_SIZE + 1,
                    to: Math.min(((page ?? 0) + 1) * PAGE_SIZE, total ?? 0),
                  })}
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 w-8 p-0 rounded-lg"
                    disabled={page === 0}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <span className="text-sm px-2 font-tabular">
                    {page + 1} / {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 w-8 p-0 rounded-lg"
                    disabled={page >= totalPages - 1}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </div>
        </motion.div>
      )}

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("dialogDeleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("dialogDeleteDescription", { count: selected.size ?? 0 })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{t("btnCancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleBulkDelete}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              {t("btnDelete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
