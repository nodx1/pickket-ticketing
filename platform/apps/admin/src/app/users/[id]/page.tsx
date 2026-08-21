"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { motion } from "motion/react";
import { toast } from "sonner";
import {
  Loader2,
  ArrowLeft,
  Mail,
  Shield,
  Ban,
  CheckCircle,
  Bell,
  User,
} from "lucide-react";
import {
  Button,
  Badge,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Textarea,
} from "@pickket/ui";
import {
  getAdminUserById,
  getAdminUserOrders,
  getAdminUserTickets,
  banUser,
  unbanUser,
  updateAdminRole,
  adminSendNotification,
  isApiCanceled,
  type AdminUser,
  type AdminOrderItem,
  type AdminTicketItem,
} from "@pickket/lib/api";
import { formatDate, formatKRW, maskEmail } from "@pickket/lib";


export default function UserDetailPage() {
  const t = useTranslations("pages.users.detail");
  const params = useParams();
  const router = useRouter();
  const userId = params.id as string;

  const [user, setUser] = useState<AdminUser | null>(null);
  const [orders, setOrders] = useState<AdminOrderItem[]>([]);
  const [ordersTotal, setOrdersTotal] = useState(0);
  const [tickets, setTickets] = useState<AdminTicketItem[]>([]);
  const [ticketsTotal, setTicketsTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const [orderSkip, setOrderSkip] = useState(0);
  const [ticketSkip, setTicketSkip] = useState(0);
  const itemLimit = 20;

  // Notification dialog
  const [showNotifyDialog, setShowNotifyDialog] = useState(false);
  const [notifyTitle, setNotifyTitle] = useState("");
  const [notifyMessage, setNotifyMessage] = useState("");
  const [notifySending, setNotifySending] = useState(false);

  const loadUser = useCallback(async () => {
    try {
      const data = await getAdminUserById(userId);
      setUser(data);
    } catch (err) {
      if (isApiCanceled(err)) return;
      toast.error(t("loadError"));
    }
  }, [userId]);

  const loadOrders = useCallback(async () => {
    try {
      const data = await getAdminUserOrders(userId, {
        skip: orderSkip,
        limit: itemLimit,
      });
      setOrders(data.orders);
      setOrdersTotal(data.total);
    } catch (err) {
      if (isApiCanceled(err)) return;
      // Orders might not exist yet
    }
  }, [userId, orderSkip]);

  const loadTickets = useCallback(async () => {
    try {
      const data = await getAdminUserTickets(userId, {
        skip: ticketSkip,
        limit: itemLimit,
      });
      setTickets(data.tickets);
      setTicketsTotal(data.total);
    } catch (err) {
      if (isApiCanceled(err)) return;
      // Tickets might not exist yet
    }
  }, [userId, ticketSkip]);

  useEffect(() => {
    setLoading(true);
    Promise.allSettled([loadUser(), loadOrders(), loadTickets()]).finally(() =>
      setLoading(false),
    );
  }, [loadUser, loadOrders, loadTickets]);

  const handleBan = async () => {
    if (!user) return;
    setActionLoading("ban");
    try {
      if (user.is_active) {
        await banUser(user.id);
        toast.success(t("banSuccess"));
      } else {
        await unbanUser(user.id);
        toast.success(t("unbanSuccess"));
      }
      loadUser();
    } catch {
      toast.error(t("statusChangeFail"));
    } finally {
      setActionLoading(null);
    }
  };

  const handleRoleToggle = async () => {
    if (!user) return;
    setActionLoading("role");
    try {
      const newRole = user.is_admin ? null : "admin";
      await updateAdminRole(user.id, newRole);
      toast.success(user.is_admin ? t("roleRevokeSuccess") : t("roleGrantSuccess"));
      loadUser();
    } catch {
      toast.error(t("roleChangeFail"));
    } finally {
      setActionLoading(null);
    }
  };

  const handleSendNotification = async () => {
    if (!notifyTitle.trim() || !notifyMessage.trim()) {
      toast.error(t("notifyRequired"));
      return;
    }
    setNotifySending(true);
    try {
      await adminSendNotification({
        user_ids: [userId],
        title: notifyTitle,
        message: notifyMessage,
      });
      toast.success(t("notifySentSuccess"));
      setShowNotifyDialog(false);
      setNotifyTitle("");
      setNotifyMessage("");
    } catch {
      toast.error(t("notifySentFail"));
    } finally {
      setNotifySending(false);
    }
  };

  const orderPages = Math.ceil(ordersTotal / itemLimit);
  const ticketPages = Math.ceil(ticketsTotal / itemLimit);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="p-6">
        <Button
          variant="ghost"
          size="sm"
          className="rounded-full mb-4"
          onClick={() => router.push("/users")}
        >
          <ArrowLeft className="h-4 w-4 mr-1" />
          {t("back")}
        </Button>
        <p className="text-muted-foreground">{t("userNotFound")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4 md:p-6">
      <Button
        variant="ghost"
        size="sm"
        className="rounded-full"
        onClick={() => router.push("/users")}
      >
        <ArrowLeft className="h-4 w-4 mr-1" />
        {t("userList")}
      </Button>

      {/* Profile Card */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-lg border border-border bg-card p-5"
      >
        <div className="flex flex-col sm:flex-row sm:items-start gap-4">
          <div className="h-14 w-14 rounded-full bg-gradient-to-br from-cyan-500 to-blue-500 flex items-center justify-center text-white text-xl font-medium shrink-0">
            {user.name?.charAt(0) || <User className="h-6 w-6" />}
          </div>
          <div className="flex-1 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-semibold">{user.name}</h2>
              {user.is_admin && (
                <Badge
                  className="rounded-full bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                  variant="secondary"
                >
                  Admin
                </Badge>
              )}
              {user.is_organizer && (
                <Badge
                  className="rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
                  variant="secondary"
                >
                  {t("badgeOrganizer")}
                </Badge>
              )}
              <Badge
                className={`rounded-full ${user.is_active ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300" : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300"}`}
                variant="secondary"
              >
                {user.is_active ? t("statusActive") : t("statusBanned")}
              </Badge>
            </div>
            <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
              <span className="flex items-center gap-1">
                <Mail className="h-3.5 w-3.5" />
                {maskEmail(user.email)}
              </span>
            </div>
            <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
              <span>{t("verificationLevel", { level: user.verification_level ?? 0 })}</span>
              <span>{t("abuseScore", { score: user.abuse_score ?? 0 })}</span>
              <span>{t("joinedAt", { date: formatDate(user.created_at) })}</span>
            </div>
          </div>
          <div className="flex gap-2 shrink-0">
            <Button
              variant="outline"
              size="sm"
              className="rounded-full"
              disabled={actionLoading === "role"}
              onClick={handleRoleToggle}
            >
              {actionLoading === "role" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
              ) : (
                <Shield className="h-3.5 w-3.5 mr-1" />
              )}
              {user.is_admin ? t("roleRevoke") : t("roleGrant")}
            </Button>
            <Button
              variant={user.is_active ? "destructive" : "outline"}
              size="sm"
              className="rounded-full"
              disabled={actionLoading === "ban"}
              onClick={handleBan}
            >
              {actionLoading === "ban" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
              ) : user.is_active ? (
                <Ban className="h-3.5 w-3.5 mr-1" />
              ) : (
                <CheckCircle className="h-3.5 w-3.5 mr-1" />
              )}
              {user.is_active ? t("ban") : t("unban")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="rounded-full"
              onClick={() => setShowNotifyDialog(true)}
            >
              <Bell className="h-3.5 w-3.5 mr-1" />
              {t("sendNotification")}
            </Button>
          </div>
        </div>
      </motion.div>

      {/* Organizer Business Info — go BFF 통합 후 import된 주최자 정보 */}
      {user.is_organizer && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
          className="rounded-lg border border-border bg-card p-5"
        >
          <h3 className="text-sm font-semibold mb-4">{t("organizerBusinessInfo")}</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-xs text-muted-foreground mb-1">{t("businessName")}</p>
              <p className="font-medium">
                {(user as { business_name?: string }).business_name || (
                  <span className="text-muted-foreground/50 italic">
                    {t("notEntered")}
                  </span>
                )}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">{t("representative")}</p>
              <p className="font-medium">
                {(user as { business_representative?: string })
                  .business_representative || (
                  <span className="text-muted-foreground/50 italic">
                    {t("notEntered")}
                  </span>
                )}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">
                {t("businessPhone")}
              </p>
              <p className="font-medium">
                {(user as { business_phone?: string }).business_phone || (
                  <span className="text-muted-foreground/50 italic">
                    {t("notEntered")}
                  </span>
                )}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">
                {t("businessRegistrationNumber")}
              </p>
              <p className="font-mono text-xs">
                {(user as { business_registration_number?: string })
                  .business_registration_number ? (
                  "****-**-*****"
                ) : (
                  <span className="text-muted-foreground/50 italic">
                    {t("notEntered")}
                  </span>
                )}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">{t("settlementBank")}</p>
              <p className="font-medium">
                {(user as { settlement_bank?: string }).settlement_bank || (
                  <span className="text-muted-foreground/50 italic">
                    {t("notEntered")}
                  </span>
                )}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">{t("accountHolder")}</p>
              <p className="font-medium">
                {(user as { settlement_account_holder?: string })
                  .settlement_account_holder || (
                  <span className="text-muted-foreground/50 italic">
                    {t("notEntered")}
                  </span>
                )}
              </p>
            </div>
            {(user as { go_organizer_id?: string }).go_organizer_id && (
              <div className="md:col-span-2">
                <p className="text-xs text-muted-foreground mb-1">
                  {t("goOrganizerId")}
                </p>
                <p className="font-mono text-xs text-muted-foreground">
                  {(user as { go_organizer_id?: string }).go_organizer_id}
                </p>
              </div>
            )}
          </div>
        </motion.div>
      )}

      {/* Orders Table */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="rounded-lg border border-border bg-card"
      >
        <div className="px-5 py-3 border-b border-border">
          <h3 className="text-sm font-semibold">{t("ordersTitle", { count: ordersTotal })}</h3>
        </div>
        {orders.length === 0 ? (
          <div className="text-center py-10 text-sm text-muted-foreground">
            {t("ordersEmpty")}
          </div>
        ) : (
          <>
            <div className="hidden md:grid grid-cols-6 gap-2 px-5 py-2.5 text-xs font-medium text-muted-foreground border-b border-border">
              <span>{t("colEvent")}</span>
              <span>{t("colOrderType")}</span>
              <span>{t("colStatus")}</span>
              <span className="text-right">{t("colQuantity")}</span>
              <span className="text-right">{t("colAmount")}</span>
              <span className="text-right">{t("colDate")}</span>
            </div>
            <div className="divide-y divide-border">
              {orders.map((o) => (
                <div
                  key={o.id}
                  className="grid grid-cols-2 md:grid-cols-6 gap-2 px-5 py-3 text-sm items-center"
                >
                  <span className="truncate font-medium">
                    {o.event_title || o.event_id.slice(0, 8)}
                  </span>
                  <span className="text-muted-foreground hidden md:block">
                    {o.order_type}
                  </span>
                  <span className="hidden md:block">
                    <Badge className="rounded-full" variant="secondary">
                      {t(`orderStatus.${o.status}`, { fallback: o.status })}
                    </Badge>
                  </span>
                  <span className="text-right hidden md:block font-tabular">
                    {o.quantity}
                  </span>
                  <span className="text-right hidden md:block font-tabular">
                    {formatKRW(o.total_amount)}
                  </span>
                  <span className="text-right text-xs text-muted-foreground hidden md:block">
                    {formatDate(o.created_at)}
                  </span>
                </div>
              ))}
            </div>
            {orderPages > 1 && (
              <div className="flex items-center justify-center gap-4 py-3 border-t border-border">
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-full"
                  disabled={orderSkip === 0}
                  onClick={() =>
                    setOrderSkip((s) => Math.max(0, s - itemLimit))
                  }
                >
                  {t("prev")}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {Math.floor(orderSkip / itemLimit) + 1} / {orderPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-full"
                  disabled={orderSkip + itemLimit >= ordersTotal}
                  onClick={() => setOrderSkip((s) => s + itemLimit)}
                >
                  {t("next")}
                </Button>
              </div>
            )}
          </>
        )}
      </motion.div>

      {/* Tickets Table */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
        className="rounded-lg border border-border bg-card"
      >
        <div className="px-5 py-3 border-b border-border">
          <h3 className="text-sm font-semibold">{t("ticketsTitle", { count: ticketsTotal })}</h3>
        </div>
        {tickets.length === 0 ? (
          <div className="text-center py-10 text-sm text-muted-foreground">
            {t("ticketsEmpty")}
          </div>
        ) : (
          <>
            <div className="hidden md:grid grid-cols-5 gap-2 px-5 py-2.5 text-xs font-medium text-muted-foreground border-b border-border">
              <span>{t("colEvent")}</span>
              <span>{t("colStatus")}</span>
              <span>{t("colSaleMode")}</span>
              <span className="text-right">{t("colPurchasePrice")}</span>
              <span className="text-right">{t("colDate")}</span>
            </div>
            <div className="divide-y divide-border">
              {tickets.map((tk) => (
                <div
                  key={tk.id}
                  className="grid grid-cols-2 md:grid-cols-5 gap-2 px-5 py-3 text-sm items-center"
                >
                  <span className="truncate font-medium">
                    {tk.event_title || tk.event_id.slice(0, 8)}
                  </span>
                  <span className="hidden md:block">
                    <Badge className="rounded-full" variant="secondary">
                      {t(`ticketStatus.${tk.status}`, { fallback: tk.status })}
                    </Badge>
                  </span>
                  <span className="text-muted-foreground hidden md:block">
                    {tk.sale_mode}
                  </span>
                  <span className="text-right hidden md:block font-tabular">
                    {formatKRW(tk.purchase_price)}
                  </span>
                  <span className="text-right text-xs text-muted-foreground hidden md:block">
                    {formatDate(tk.created_at)}
                  </span>
                </div>
              ))}
            </div>
            {ticketPages > 1 && (
              <div className="flex items-center justify-center gap-4 py-3 border-t border-border">
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-full"
                  disabled={ticketSkip === 0}
                  onClick={() =>
                    setTicketSkip((s) => Math.max(0, s - itemLimit))
                  }
                >
                  {t("prev")}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {Math.floor(ticketSkip / itemLimit) + 1} / {ticketPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-full"
                  disabled={ticketSkip + itemLimit >= ticketsTotal}
                  onClick={() => setTicketSkip((s) => s + itemLimit)}
                >
                  {t("next")}
                </Button>
              </div>
            )}
          </>
        )}
      </motion.div>

      {/* Notification Dialog */}
      <Dialog open={showNotifyDialog} onOpenChange={setShowNotifyDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("notifyDialogTitle")}</DialogTitle>
            <DialogDescription>
              {t("notifyDialogDescription", { name: user.name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              placeholder={t("notifyTitlePlaceholder")}
              value={notifyTitle}
              onChange={(e) => setNotifyTitle(e.target.value)}
            />
            <Textarea
              placeholder={t("notifyMessagePlaceholder")}
              value={notifyMessage}
              onChange={(e) => setNotifyMessage(e.target.value)}
              rows={4}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowNotifyDialog(false)}
            >
              {t("cancel")}
            </Button>
            <Button onClick={handleSendNotification} disabled={notifySending}>
              {notifySending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1" />
              ) : (
                <Bell className="h-4 w-4 mr-1" />
              )}
              {t("send")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
