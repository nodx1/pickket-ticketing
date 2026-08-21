"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useTranslations } from "next-intl";
import { motion } from "motion/react";
import { toast } from "sonner";
import {
  Shield,
  Crown,
  DollarSign,
  Headphones,
  Loader2,
  Search,
  Check,
  Save,
} from "lucide-react";
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
  updateAdminRole,
  isApiCanceled,
  type AdminUser,
} from "@pickket/lib/api";
import { maskEmail } from "@pickket/lib";

const ROLES = [
  {
    value: "super_admin",
    labelKey: "roleSuperAdmin" as const,
    icon: Crown,
    color: "text-amber-500",
    bgColor: "bg-amber-100 dark:bg-amber-900/30",
    textColor: "text-amber-700 dark:text-amber-400",
  },
  {
    value: "moderator",
    labelKey: "roleModerator" as const,
    icon: Shield,
    color: "text-blue-500",
    bgColor: "bg-blue-100 dark:bg-blue-900/30",
    textColor: "text-blue-700 dark:text-blue-400",
  },
  {
    value: "finance_admin",
    labelKey: "roleFinanceAdmin" as const,
    icon: DollarSign,
    color: "text-emerald-500",
    bgColor: "bg-emerald-100 dark:bg-emerald-900/30",
    textColor: "text-emerald-700 dark:text-emerald-400",
  },
  {
    value: "cs_agent",
    labelKey: "roleCsAgent" as const,
    icon: Headphones,
    color: "text-violet-500",
    bgColor: "bg-violet-100 dark:bg-violet-900/30",
    textColor: "text-violet-700 dark:text-violet-400",
  },
] as const;

function getRoleMeta(role: string | null | undefined) {
  return ROLES.find((r) => r.value === role) || null;
}

interface RoleEditState {
  [userId: string]: string;
}

export default function AdminRolesPage() {
  const t = useTranslations("roles");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [editedRoles, setEditedRoles] = useState<RoleEditState>({});
  const [inputValue, setInputValue] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [skip, setSkip] = useState(0);
  const [confirmTarget, setConfirmTarget] = useState<{
    userId: string;
    userName: string;
    newRole: string;
  } | null>(null);
  const limit = 50;

  const requestIdRef = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(inputValue), 300);
    return () => clearTimeout(timer);
  }, [inputValue]);

  useEffect(() => {
    setSkip(0);
  }, [debouncedQ]);

  const load = useCallback(async () => {
    const reqId = ++requestIdRef.current;
    setLoading(true);
    try {
      const params: Record<string, unknown> = { skip, limit };
      if (debouncedQ) params.q = debouncedQ;
      // We load all users, not just admins, since we might want to promote users
      const data = await getAdminUsers(
        params as Parameters<typeof getAdminUsers>[0],
      );
      if (reqId !== requestIdRef.current) return;
      setUsers(data.users);
      setTotal(data.total);
    } catch (err) {
      if (isApiCanceled(err)) return;
      if (reqId !== requestIdRef.current) return;
      toast.error(t("errorLoadUsers"));
    } finally {
      if (reqId === requestIdRef.current) setLoading(false);
    }
  }, [debouncedQ, skip]);

  useEffect(() => {
    load();
  }, [load]);

  const handleRoleChange = (userId: string, role: string) => {
    setEditedRoles((prev) => ({ ...prev, [userId]: role }));
  };

  const handleSave = async (user: AdminUser) => {
    const newRole = editedRoles[user.id];
    if (!newRole) return;

    // Show confirmation dialog
    setConfirmTarget({
      userId: user.id,
      userName: user.name || maskEmail(user.email),
      newRole,
    });
  };

  const confirmSave = async () => {
    if (!confirmTarget) return;
    const { userId, newRole } = confirmTarget;

    setSaving(userId);
    try {
      await updateAdminRole(userId, newRole === "remove" ? null : newRole);
      toast.success(t("successRoleChanged"));
      setEditedRoles((prev) => {
        const next = { ...prev };
        delete next[userId];
        return next;
      });
      load();
    } catch {
      toast.error(t("errorRoleChangeFailed"));
    } finally {
      setSaving(null);
      setConfirmTarget(null);
    }
  };

  const totalPages = Math.ceil(total / limit);

  // Filter to show admin users primarily, but search results may include non-admins
  const adminUsers = users.filter((u) => u.is_admin);
  const displayUsers = debouncedQ ? users : adminUsers;

  return (
    <div className="space-y-5 p-4 md:p-6">
      <h1 className="sr-only">{t("pageTitle")}</h1>

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <p className="text-muted-foreground text-sm">
            {t("pageSubtitle")}
          </p>
        </div>
      </div>

      {/* Role Legend */}
      <motion.div
        className="flex flex-wrap gap-3"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.05 }}
      >
        {ROLES.map((role) => {
          const Icon = role.icon;
          return (
            <div
              key={role.value}
              className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2"
            >
              <Icon className={`h-4 w-4 ${role.color}`} />
              <span className="text-xs font-medium">{t(role.labelKey)}</span>
            </div>
          );
        })}
      </motion.div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder={t("searchPlaceholder")}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          className="pl-9 rounded-full"
        />
      </div>

      {/* Users Table */}
      <div className="rounded-lg border border-border bg-card">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : displayUsers.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            {debouncedQ ? t("emptySearchResult") : t("emptyAdminUsers")}
          </div>
        ) : (
          <>
            <div className="hidden md:grid grid-cols-6 gap-2 px-5 py-3 text-xs font-medium text-muted-foreground border-b border-border">
              <span>{t("colName")}</span>
              <span>{t("colEmail")}</span>
              <span className="text-center">{t("colCurrentRole")}</span>
              <span className="text-center">{t("colStatus")}</span>
              <span className="text-center">{t("colChangeRole")}</span>
              <span className="text-right">{t("colAction")}</span>
            </div>
            <div className="divide-y divide-border">
              {displayUsers.map((u, idx) => {
                const currentRole = getRoleMeta(u.admin_role);
                const editedRole = editedRoles[u.id];
                const hasChange =
                  editedRole !== undefined &&
                  editedRole !== (u.admin_role || "remove");
                const isSaving = saving === u.id;

                return (
                  <motion.div
                    key={u.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: idx * 0.02 }}
                    className="grid grid-cols-2 md:grid-cols-6 gap-2 px-5 py-3.5 text-sm items-center hover:bg-muted/50 transition-colors"
                  >
                    {/* Name */}
                    <span className="font-medium truncate flex items-center gap-2">
                      {currentRole && (
                        <currentRole.icon
                          className={`h-3.5 w-3.5 ${currentRole.color} shrink-0`}
                        />
                      )}
                      {u.name}
                    </span>

                    {/* Email */}
                    <span className="text-muted-foreground truncate hidden md:block">
                      {maskEmail(u.email)}
                    </span>

                    {/* Current Role */}
                    <span className="text-center hidden md:flex justify-center">
                      {currentRole ? (
                        <Badge
                          variant="secondary"
                          className={`rounded-full ${currentRole.bgColor} ${currentRole.textColor}`}
                        >
                          {t(currentRole.labelKey)}
                        </Badge>
                      ) : u.is_admin ? (
                        <Badge
                          variant="secondary"
                          className="rounded-full bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400"
                        >
                          {t("roleAdmin")}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground text-xs">
                          {t("roleRegularUser")}
                        </span>
                      )}
                    </span>

                    {/* Status */}
                    <span className="text-center hidden md:flex justify-center">
                      <Badge
                        variant="secondary"
                        className={`rounded-full ${
                          u.is_active
                            ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300"
                            : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300"
                        }`}
                      >
                        {u.is_active ? t("statusActive") : t("statusSuspended")}
                      </Badge>
                    </span>

                    {/* Role Selector */}
                    <span className="flex justify-center">
                      <Select
                        value={editedRole || u.admin_role || "remove"}
                        onValueChange={(v) => handleRoleChange(u.id, v)}
                      >
                        <SelectTrigger className="w-[140px] rounded-full h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ROLES.map((role) => (
                            <SelectItem key={role.value} value={role.value}>
                              <span className="flex items-center gap-1.5">
                                <role.icon
                                  className={`h-3 w-3 ${role.color}`}
                                />
                                {t(role.labelKey)}
                              </span>
                            </SelectItem>
                          ))}
                          <SelectItem value="remove">
                            <span className="text-muted-foreground">
                              {t("roleRemove")}
                            </span>
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </span>

                    {/* Save Button */}
                    <span className="text-right flex justify-end">
                      <Button
                        variant={hasChange ? "default" : "ghost"}
                        size="sm"
                        className="rounded-full gap-1 h-8"
                        disabled={!hasChange || isSaving}
                        onClick={() => handleSave(u)}
                      >
                        {isSaving ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : hasChange ? (
                          <Save className="h-3.5 w-3.5" />
                        ) : (
                          <Check className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                        {hasChange ? t("btnSave") : t("btnNoChange")}
                      </Button>
                    </span>
                  </motion.div>
                );
              })}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-4 py-4 border-t border-border">
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-full"
                  disabled={skip === 0}
                  onClick={() => setSkip((s) => Math.max(0, s - limit))}
                >
                  {t("btnPrev")}
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
                  {t("btnNext")}
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Confirmation Dialog */}
      <AlertDialog
        open={!!confirmTarget}
        onOpenChange={(open) => !open && setConfirmTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("dialogTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{confirmTarget?.userName}</strong>{t("dialogDescPre")}{" "}
              <strong>
                {confirmTarget?.newRole === "remove"
                  ? t("roleRemove")
                  : t(getRoleMeta(confirmTarget?.newRole)?.labelKey ?? "roleNoRole")}
              </strong>
              {t("dialogDescPost")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("btnCancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmSave}>{t("btnConfirm")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
