"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Search, Loader2, Shield, Ban, CheckCircle } from "lucide-react";
import {
  Button,
  Badge,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@pickket/ui";
import {
  getAdminUsers,
  updateUserRoles,
  banUser,
  unbanUser,
  bulkBanUsers,
  bulkUnbanUsers,
  isApiCanceled,
  type AdminUser,
} from "@pickket/lib/api";
import { formatDate, maskEmail } from "@pickket/lib";

// i18n: 모든 사용자 표시 문자열은 next-intl messages/(ko|en).json 경유.
export default function AdminUsersPage() {
  const router = useRouter();
  const tCommon = useTranslations("common");
  const tActions = useTranslations("actions");
  const tTable = useTranslations("table");
  const tPage = useTranslations("pages.users");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [inputValue, setInputValue] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [filter, setFilter] = useState("all");
  const [skip, setSkip] = useState(0);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionTarget, setActionTarget] = useState<{
    user: AdminUser;
    action: "organizer" | "ban";
  } | null>(null);
  const limit = 50;

  // Bulk selection
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showBulkBanConfirm, setShowBulkBanConfirm] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(inputValue), 300);
    return () => clearTimeout(timer);
  }, [inputValue]);

  useEffect(() => {
    setSkip(0);
  }, [debouncedQ]);

  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const reqId = ++requestIdRef.current;
    setLoading(true);
    try {
      const params: Record<string, unknown> = { skip, limit };
      if (debouncedQ) params.q = debouncedQ;
      if (filter === "organizer") params.is_organizer = true;
      if (filter === "banned") params.is_active = false;
      const data = await getAdminUsers(
        params as Parameters<typeof getAdminUsers>[0],
      );
      if (reqId !== requestIdRef.current) return;
      setUsers(data.users);
      setTotal(data.total);
    } catch (err) {
      if (isApiCanceled(err)) return;
      if (reqId !== requestIdRef.current) return;
      toast.error(tPage("loadError"));
    } finally {
      if (reqId === requestIdRef.current) setLoading(false);
    }
  }, [debouncedQ, filter, skip, tPage]);

  useEffect(() => {
    load();
  }, [load]);

  const handleToggleOrganizer = async (u: AdminUser) => {
    setActionLoading(`org-${u.id}`);
    try {
      await updateUserRoles(u.id, { is_organizer: !u.is_organizer });
      toast.success(
        u.is_organizer
          ? tPage("organizerRevokeSuccess", { name: u.name })
          : tPage("organizerGrantSuccess", { name: u.name }),
      );
      load();
    } catch {
      toast.error(tPage("roleChangeFail"));
    } finally {
      setActionLoading(null);
    }
  };

  const handleToggleBan = async (u: AdminUser) => {
    setActionLoading(`ban-${u.id}`);
    try {
      if (u.is_active) {
        await banUser(u.id);
        toast.success(tPage("banSuccess", { name: u.name }));
      } else {
        await unbanUser(u.id);
        toast.success(tPage("unbanSuccess", { name: u.name }));
      }
      load();
    } catch {
      toast.error(tPage("statusChangeFail"));
    } finally {
      setActionLoading(null);
    }
  };

  // Bulk actions
  const handleBulkBan = async () => {
    try {
      const result = await bulkBanUsers(Array.from(selected));
      toast.success(
        result.detail ||
          tPage("bulkBanSuccess", { count: result.success_count }),
      );
      setSelected(new Set());
      load();
      setShowBulkBanConfirm(false);
    } catch {
      toast.error(tPage("bulkBanFail"));
    }
  };

  const handleBulkUnban = async () => {
    try {
      const result = await bulkUnbanUsers(Array.from(selected));
      toast.success(
        result.detail ||
          tPage("bulkUnbanSuccess", { count: result.success_count }),
      );
      setSelected(new Set());
      load();
    } catch {
      toast.error(tPage("bulkUnbanFail"));
    }
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selected.size === users.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(users.map((u) => u.id)));
    }
  };

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="space-y-5 p-4 md:p-6">
      <h1 className="sr-only">{tPage("title")}</h1>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={tPage("searchPlaceholder")}
            value={inputValue}
            onChange={(e) => {
              setInputValue(e.target.value);
            }}
            className="pl-9 rounded-full"
          />
        </div>
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
            <SelectItem value="all">{tCommon("all")}</SelectItem>
            <SelectItem value="organizer">
              {tPage("filterOrganizer")}
            </SelectItem>
            <SelectItem value="banned">{tPage("filterBanned")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Bulk Action Bar */}
      {selected.size > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-4 py-2.5"
        >
          <span className="text-sm font-medium">
            {tCommon("selectedCount", { count: selected.size })}
          </span>
          <div className="flex gap-2 ml-auto">
            <Button
              size="sm"
              variant="destructive"
              className="rounded-full"
              onClick={() => setShowBulkBanConfirm(true)}
            >
              <Ban className="h-3.5 w-3.5 mr-1" />
              {tPage("bulkBan")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="rounded-full"
              onClick={handleBulkUnban}
            >
              <CheckCircle className="h-3.5 w-3.5 mr-1" />
              {tPage("bulkUnban")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="rounded-full"
              onClick={() => setSelected(new Set())}
            >
              {tActions("deselect")}
            </Button>
          </div>
        </motion.div>
      )}

      <div className="rounded-lg border border-border bg-card">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : users.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            {tPage("empty")}
          </div>
        ) : (
          <>
            <div className="hidden md:grid grid-cols-8 gap-2 px-5 py-3 text-xs font-medium text-muted-foreground border-b border-border">
              <span className="flex items-center">
                <input
                  type="checkbox"
                  checked={selected.size === users.length && users.length > 0}
                  onChange={toggleSelectAll}
                  className="h-3.5 w-3.5 rounded border-muted-foreground"
                />
              </span>
              <span>{tTable("name")}</span>
              <span>{tTable("email")}</span>
              <span className="text-center">{tTable("role")}</span>
              <span className="text-center">{tTable("status")}</span>
              <span className="text-center">{tPage("verification")}</span>
              <span className="text-right">{tTable("createdAt")}</span>
              <span className="text-right">{tTable("actions")}</span>
            </div>
            <div className="divide-y divide-border">
              {users.map((u, idx) => (
                <motion.div
                  key={u.id}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: idx * 0.02 }}
                  className="grid grid-cols-2 md:grid-cols-8 gap-2 px-5 py-3.5 text-sm items-center hover:bg-muted/50 transition-colors cursor-pointer"
                  onClick={(ev) => {
                    const target = ev.target as HTMLElement;
                    if (target.tagName === "INPUT" || target.closest("button"))
                      return;
                    router.push(`/users/${u.id}`);
                  }}
                >
                  <span
                    className="flex items-center"
                    onClick={(ev) => ev.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(u.id)}
                      onChange={() => toggleSelect(u.id)}
                      className="h-3.5 w-3.5 rounded border-muted-foreground"
                    />
                  </span>
                  <span className="font-medium truncate">{u.name}</span>
                  <span className="text-muted-foreground truncate hidden md:block">
                    {maskEmail(u.email)}
                  </span>
                  <span className="text-center flex gap-1 justify-center">
                    {u.is_admin && (
                      <Badge
                        className="rounded-full bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                        variant="secondary"
                      >
                        {tPage("roleAdmin")}
                      </Badge>
                    )}
                    {u.is_organizer && (
                      <Badge
                        className="rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
                        variant="secondary"
                      >
                        {tPage("roleOrganizer")}
                      </Badge>
                    )}
                  </span>
                  <span className="text-center hidden md:block">
                    <Badge
                      className={`rounded-full ${u.is_active ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300" : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300"}`}
                      variant="secondary"
                    >
                      {u.is_active
                        ? tPage("statusActive")
                        : tPage("statusBanned")}
                    </Badge>
                  </span>
                  <span className="text-center hidden md:block text-xs text-muted-foreground">
                    Lv.{u.verification_level}
                  </span>
                  <span className="text-right text-muted-foreground text-xs hidden md:block">
                    {formatDate(u.created_at)}
                  </span>
                  <span
                    className="text-right flex gap-1 justify-end"
                    onClick={(ev) => ev.stopPropagation()}
                  >
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9"
                      title={tPage("organizerToggleTooltip")}
                      disabled={actionLoading === `org-${u.id}`}
                      onClick={() =>
                        setActionTarget({ user: u, action: "organizer" })
                      }
                    >
                      {actionLoading === `org-${u.id}` ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Shield className="h-4 w-4" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9"
                      title={
                        u.is_active
                          ? tPage("banTooltip")
                          : tPage("unbanTooltip")
                      }
                      disabled={actionLoading === `ban-${u.id}`}
                      onClick={() =>
                        setActionTarget({ user: u, action: "ban" })
                      }
                    >
                      {actionLoading === `ban-${u.id}` ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : u.is_active ? (
                        <Ban className="h-4 w-4 text-red-500" />
                      ) : (
                        <CheckCircle className="h-4 w-4 text-green-500" />
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
                  {tCommon("prev")}
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
                  {tCommon("next")}
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Bulk Ban Confirm Dialog */}
      <AlertDialog
        open={showBulkBanConfirm}
        onOpenChange={setShowBulkBanConfirm}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tPage("bulkBanTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {tPage("bulkBanDescription", { count: selected.size })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tActions("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleBulkBan}>
              {tPage("bulkBanConfirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!actionTarget}
        onOpenChange={(open) => !open && setActionTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {actionTarget?.action === "ban"
                ? actionTarget.user.is_active
                  ? tPage("confirmBanTitle")
                  : tPage("confirmUnbanTitle")
                : actionTarget?.user.is_organizer
                  ? tPage("confirmOrganizerRevokeTitle")
                  : tPage("confirmOrganizerGrantTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {actionTarget?.action === "ban"
                ? actionTarget.user.is_active
                  ? tPage("confirmBanDescription")
                  : tPage("confirmUnbanDescription")
                : actionTarget?.user.is_organizer
                  ? tPage("confirmOrganizerRevokeDescription")
                  : tPage("confirmOrganizerGrantDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tActions("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!actionTarget) return;
                if (actionTarget.action === "organizer") {
                  handleToggleOrganizer(actionTarget.user);
                } else {
                  handleToggleBan(actionTarget.user);
                }
                setActionTarget(null);
              }}
            >
              {tActions("confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
