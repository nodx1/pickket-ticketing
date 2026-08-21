"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { motion } from "motion/react";
import { toast } from "sonner";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Loader2,
  Plus,
  Shield,
  ShieldCheck,
  Users,
  Pencil,
  Trash2,
  Check,
  UserPlus,
} from "lucide-react";
import {
  Button,
  Input,
  Badge,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Label,
} from "@pickket/ui";
import api from "@pickket/lib/api";
import { isApiCanceled } from "@pickket/lib/api";

// ── Types ──────────────────────────────────────────────────────────────

interface ScopeCategory {
  category: string;
  scopes: string[];
}

interface RoleItem {
  name: string;
  scopes: string[];
  is_builtin: boolean;
  user_count: number;
}

interface RoleListResponse {
  roles: RoleItem[];
  scope_categories: ScopeCategory[];
}

// ── Scope label mapping ────────────────────────────────────────────────

const SCOPE_LABELS_KEYS: Record<string, string> = {
  "*": "scopeLabels.all",
  "events.manage": "scopeLabels.eventsManage",
  "events.view": "scopeLabels.eventsView",
  "events.approve": "scopeLabels.eventsApprove",
  "events.feature": "scopeLabels.eventsFeature",
  "users.manage": "scopeLabels.usersManage",
  "users.view": "scopeLabels.usersView",
  "users.ban": "scopeLabels.usersBan",
  "finance.view": "scopeLabels.financeView",
  "finance.manage": "scopeLabels.financeManage",
  "orders.manage": "scopeLabels.ordersManage",
  "refunds.request": "scopeLabels.refundsRequest",
  "refunds.approve": "scopeLabels.refundsApprove",
  "settlements.review": "scopeLabels.settlementsReview",
  "settlements.approve": "scopeLabels.settlementsApprove",
  "notifications.send": "scopeLabels.notificationsSend",
  "communities.manage": "scopeLabels.communitiesManage",
  "audit.view": "scopeLabels.auditView",
  "organizers.manage": "scopeLabels.organizersManage",
  "system.settings": "scopeLabels.systemSettings",
};

const CATEGORY_LABELS_KEYS: Record<string, string> = {
  events: "categoryLabels.events",
  users: "categoryLabels.users",
  finance: "categoryLabels.finance",
  cs: "categoryLabels.cs",
  system: "categoryLabels.system",
};

const ROLE_LABELS_KEYS: Record<string, string> = {
  super_admin: "roleLabels.superAdmin",
  admin: "roleLabels.admin",
  moderator: "roleLabels.moderator",
  finance_admin: "roleLabels.financeAdmin",
  cs_agent: "roleLabels.csAgent",
  viewer: "roleLabels.viewer",
};

// ── Component ──────────────────────────────────────────────────────────

export default function AdminRolesPage() {
  const t = useTranslations("settings.roles");
  const [roles, setRoles] = useState<RoleItem[]>([]);
  const [scopeCategories, setScopeCategories] = useState<ScopeCategory[]>([]);
  const [loading, setLoading] = useState(true);

  // Create/Edit dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRole, setEditingRole] = useState<string | null>(null);
  const [roleName, setRoleName] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  // Assign dialog state
  const [assignDialogOpen, setAssignDialogOpen] = useState(false);
  const [assignUserId, setAssignUserId] = useState("");
  const [assignRole, setAssignRole] = useState("");
  const [assigning, setAssigning] = useState(false);

  const loadRoles = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get<RoleListResponse>("/admin/roles");
      setRoles(data.roles);
      setScopeCategories(data.scope_categories);
    } catch (err) {
      if (isApiCanceled(err)) return;
      toast.error(t("toast.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRoles();
  }, [loadRoles]);

  // ── Create / Edit ─────────────────────────────────────────────────

  const openCreateDialog = () => {
    setEditingRole(null);
    setRoleName("");
    setSelectedScopes(new Set());
    setDialogOpen(true);
  };

  const openEditDialog = (role: RoleItem) => {
    setEditingRole(role.name);
    setRoleName(role.name);
    setSelectedScopes(new Set(role.scopes));
    setDialogOpen(true);
  };

  const toggleScope = (scope: string) => {
    setSelectedScopes((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) {
        next.delete(scope);
      } else {
        next.add(scope);
      }
      return next;
    });
  };

  const toggleCategory = (category: ScopeCategory) => {
    const allSelected = category.scopes.every((s) => selectedScopes.has(s));
    setSelectedScopes((prev) => {
      const next = new Set(prev);
      for (const scope of category.scopes) {
        if (allSelected) {
          next.delete(scope);
        } else {
          next.add(scope);
        }
      }
      return next;
    });
  };

  const handleSave = async () => {
    if (!roleName.trim()) {
      toast.error(t("toast.nameRequired"));
      return;
    }
    if (selectedScopes.size === 0) {
      toast.error(t("toast.scopeRequired"));
      return;
    }

    setSaving(true);
    try {
      const scopes = Array.from(selectedScopes);
      if (editingRole) {
        await api.patch(`/admin/roles/${editingRole}`, { scopes });
        toast.success(t("toast.updateSuccess"));
      } else {
        await api.post("/admin/roles", { name: roleName, scopes });
        toast.success(t("toast.createSuccess"));
      }
      setDialogOpen(false);
      loadRoles();
    } catch (err: unknown) {
      const message =
        (err as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail ?? t("toast.saveFailed");
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (roleName: string) => {
    if (
      !confirm(
        t("confirm.deleteRole", { name: roleName ?? "" }),
      )
    ) {
      return;
    }
    try {
      await api.delete(`/admin/roles/${roleName}`);
      toast.success(t("toast.deleteSuccess"));
      loadRoles();
    } catch {
      toast.error(t("toast.deleteFailed"));
    }
  };

  // ── Assign ────────────────────────────────────────────────────────

  const handleAssign = async () => {
    if (!assignUserId.trim() || !assignRole) {
      toast.error(t("toast.assignRequired"));
      return;
    }
    setAssigning(true);
    try {
      await api.post(`/admin/users/${assignUserId}/roles`, {
        role: assignRole,
      });
      toast.success(t("toast.assignSuccess"));
      setAssignDialogOpen(false);
      setAssignUserId("");
      setAssignRole("");
      loadRoles();
    } catch (err: unknown) {
      const message =
        (err as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail ?? t("toast.assignFailed");
      toast.error(message);
    } finally {
      setAssigning(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4 md:p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">{t("heading")}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t("description")}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAssignDialogOpen(true)}
          >
            <UserPlus className="h-4 w-4 mr-1.5" />
            {t("btn.assignRole")}
          </Button>
          <Button size="sm" onClick={openCreateDialog}>
            <Plus className="h-4 w-4 mr-1.5" />{t("btn.newRole")}
          </Button>
        </div>
      </div>

      {/* Role cards */}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {roles.map((role) => (
          <motion.div
            key={role.name}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-lg border border-border bg-card overflow-hidden"
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <div className="flex items-center gap-2">
                {role.is_builtin ? (
                  <ShieldCheck className="h-4 w-4 text-primary" />
                ) : (
                  <Shield className="h-4 w-4 text-muted-foreground" />
                )}
                <span className="font-semibold text-sm">
                  {ROLE_LABELS_KEYS[role.name] ? t(ROLE_LABELS_KEYS[role.name] as Parameters<typeof t>[0]) : role.name}
                </span>
                {role.is_builtin && (
                  <Badge variant="secondary" className="text-[10px] px-1.5">
                    {t("badge.builtin")}
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-1">
                <div className="flex items-center gap-1 text-xs text-muted-foreground mr-2">
                  <Users className="h-3 w-3" />
                  {role.user_count}
                </div>
                {!role.is_builtin && (
                  <>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => openEditDialog(role)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-destructive"
                      onClick={() => handleDelete(role.name)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </>
                )}
              </div>
            </div>
            <div className="px-4 py-3">
              {role.scopes.includes("*") ? (
                <Badge variant="default" className="text-xs">
                  {t("scopeLabels.all")}
                </Badge>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {role.scopes.map((scope) => (
                    <Badge
                      key={scope}
                      variant="outline"
                      className="text-[10px] font-mono"
                    >
                      {SCOPE_LABELS_KEYS[scope] ? t(SCOPE_LABELS_KEYS[scope] as Parameters<typeof t>[0]) : scope}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        ))}
      </div>

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingRole ? t("dialog.editTitle", { name: editingRole ?? "" }) : t("dialog.createTitle")}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {!editingRole && (
              <div className="space-y-1.5">
                <Label>{t("label.roleName")}</Label>
                <Input
                  value={roleName}
                  onChange={(e) => setRoleName(e.target.value)}
                  placeholder="예: event_reviewer"
                  className="font-mono text-sm"
                />
              </div>
            )}

            <div className="space-y-3">
              <Label>{t("label.scopePermissions")}</Label>
              {scopeCategories.map((cat) => {
                const allSelected = cat.scopes.every((s) =>
                  selectedScopes.has(s),
                );
                const someSelected =
                  !allSelected && cat.scopes.some((s) => selectedScopes.has(s));

                return (
                  <div
                    key={cat.category}
                    className="rounded-md border border-border p-3"
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <Checkbox
                        checked={allSelected}
                        ref={
                          someSelected
                            ? (el) => {
                                if (el)
                                  (
                                    el as unknown as HTMLInputElement
                                  ).indeterminate = true;
                              }
                            : undefined
                        }
                        onCheckedChange={() => toggleCategory(cat)}
                      />
                      <span className="text-sm font-semibold">
                        {CATEGORY_LABELS_KEYS[cat.category] ? t(CATEGORY_LABELS_KEYS[cat.category] as Parameters<typeof t>[0]) : cat.category}
                      </span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 ml-6">
                      {cat.scopes.map((scope) => (
                        <label
                          key={scope}
                          className="flex items-center gap-2 cursor-pointer text-sm"
                        >
                          <Checkbox
                            checked={selectedScopes.has(scope)}
                            onCheckedChange={() => toggleScope(scope)}
                          />
                          <span className="text-muted-foreground">
                            {SCOPE_LABELS_KEYS[scope] ? t(SCOPE_LABELS_KEYS[scope] as Parameters<typeof t>[0]) : scope}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDialogOpen(false)}
              disabled={saving}
            >
              {t("btn.cancel")}
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
              ) : (
                <Check className="h-4 w-4 mr-1.5" />
              )}
              {editingRole ? t("btn.update") : t("btn.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Assign Role Dialog */}
      <Dialog open={assignDialogOpen} onOpenChange={setAssignDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("dialog.assignTitle")}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>{t("label.userId")}</Label>
              <Input
                value={assignUserId}
                onChange={(e) => setAssignUserId(e.target.value)}
                placeholder="UUID"
                className="font-mono text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("label.role")}</Label>
              <Select value={assignRole} onValueChange={setAssignRole}>
                <SelectTrigger>
                  <SelectValue placeholder={t("placeholder.selectRole")} />
                </SelectTrigger>
                <SelectContent>
                  {roles.map((r) => (
                    <SelectItem key={r.name} value={r.name}>
                      {ROLE_LABELS_KEYS[r.name] ? t(ROLE_LABELS_KEYS[r.name] as Parameters<typeof t>[0]) : r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setAssignDialogOpen(false)}
              disabled={assigning}
            >
              {t("btn.cancel")}
            </Button>
            <Button onClick={handleAssign} disabled={assigning}>
              {assigning ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
              ) : (
                <UserPlus className="h-4 w-4 mr-1.5" />
              )}
              {t("btn.assign")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
