"use client";

import { useEffect, useState, useCallback } from "react";
import { motion } from "motion/react";
import { toast } from "sonner";
import { Loader2, Send, Users, Bell } from "lucide-react";
import {
  Button,
  Badge,
  Input,
  Textarea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@pickket/ui";
import {
  adminSendNotification,
  adminBroadcastNotification,
  getAdminNotificationHistory,
  isApiCanceled,
  type AdminNotificationHistoryItem,
} from "@pickket/lib/api";
import { formatDate } from "@pickket/lib";
import { useTranslations } from "next-intl";

export default function AdminNotificationsPage() {
  const t = useTranslations("notifications");

  // Individual send
  const [userIds, setUserIds] = useState("");
  const [sendTitle, setSendTitle] = useState("");
  const [sendMessage, setSendMessage] = useState("");
  const [sendType, setSendType] = useState("info");
  const [sending, setSending] = useState(false);

  // Broadcast
  const [broadcastTarget, setBroadcastTarget] = useState("all");
  const [broadcastTitle, setBroadcastTitle] = useState("");
  const [broadcastMessage, setBroadcastMessage] = useState("");
  const [broadcasting, setBroadcasting] = useState(false);

  // History
  const [history, setHistory] = useState<AdminNotificationHistoryItem[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historySkip, setHistorySkip] = useState(0);
  const historyLimit = 20;

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const data = await getAdminNotificationHistory({
        skip: historySkip,
        limit: historyLimit,
      });
      setHistory(data.notifications);
      setHistoryTotal(data.total);
    } catch (err) {
      if (isApiCanceled(err)) return;
      toast.error(t("historyLoadError"));
    } finally {
      setHistoryLoading(false);
    }
  }, [historySkip, t]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const handleSend = async () => {
    if (!userIds.trim() || !sendTitle.trim() || !sendMessage.trim()) {
      toast.error(t("sendValidationError"));
      return;
    }
    setSending(true);
    try {
      const ids = userIds
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      await adminSendNotification({
        user_ids: ids,
        title: sendTitle,
        message: sendMessage,
        notification_type: sendType,
      });
      toast.success(t("sendSuccess"));
      setUserIds("");
      setSendTitle("");
      setSendMessage("");
      loadHistory();
    } catch {
      toast.error(t("sendError"));
    } finally {
      setSending(false);
    }
  };

  const handleBroadcast = async () => {
    if (!broadcastTitle.trim() || !broadcastMessage.trim()) {
      toast.error(t("broadcastValidationError"));
      return;
    }
    setBroadcasting(true);
    try {
      await adminBroadcastNotification({
        target: broadcastTarget,
        title: broadcastTitle,
        message: broadcastMessage,
      });
      toast.success(t("broadcastSuccess"));
      setBroadcastTitle("");
      setBroadcastMessage("");
      loadHistory();
    } catch {
      toast.error(t("broadcastError"));
    } finally {
      setBroadcasting(false);
    }
  };

  const historyPages = Math.ceil(historyTotal / historyLimit);

  const TARGET_LABEL: Record<string, string> = {
    all: t("targetAll"),
    organizers: t("targetOrganizers"),
    users: t("targetUsers"),
  };

  return (
    <div className="space-y-5 p-4 md:p-6">
      <h1 className="sr-only">{t("pageTitle")}</h1>

      <Tabs defaultValue="individual">
        <TabsList>
          <TabsTrigger value="individual">{t("tabIndividual")}</TabsTrigger>
          <TabsTrigger value="broadcast">{t("tabBroadcast")}</TabsTrigger>
          <TabsTrigger value="history">{t("tabHistory")}</TabsTrigger>
        </TabsList>

        {/* Individual Send */}
        <TabsContent value="individual">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-lg border border-border bg-card p-5 space-y-4 mt-4"
          >
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <Bell className="h-4 w-4" />
              {t("individualSendTitle")}
            </h2>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">
                  {t("labelUserIds")}
                </label>
                <Input
                  placeholder="user-id-1, user-id-2, ..."
                  value={userIds}
                  onChange={(e) => setUserIds(e.target.value)}
                  className="rounded-lg"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">
                  {t("labelNotificationType")}
                </label>
                <Select value={sendType} onValueChange={setSendType}>
                  <SelectTrigger className="w-[160px] rounded-lg">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="info">{t("typeInfo")}</SelectItem>
                    <SelectItem value="warning">{t("typeWarning")}</SelectItem>
                    <SelectItem value="promotion">{t("typePromotion")}</SelectItem>
                    <SelectItem value="system">{t("typeSystem")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">
                  {t("labelTitle")}
                </label>
                <Input
                  placeholder={t("placeholderNotificationTitle")}
                  value={sendTitle}
                  onChange={(e) => setSendTitle(e.target.value)}
                  className="rounded-lg"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">
                  {t("labelMessage")}
                </label>
                <Textarea
                  placeholder={t("placeholderNotificationMessage")}
                  value={sendMessage}
                  onChange={(e) => setSendMessage(e.target.value)}
                  rows={4}
                />
              </div>
              <Button
                className="rounded-full"
                disabled={sending}
                onClick={handleSend}
              >
                {sending ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-1" />
                ) : (
                  <Send className="h-4 w-4 mr-1" />
                )}
                {t("buttonSend")}
              </Button>
            </div>
          </motion.div>
        </TabsContent>

        {/* Broadcast */}
        <TabsContent value="broadcast">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-lg border border-border bg-card p-5 space-y-4 mt-4"
          >
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <Users className="h-4 w-4" />
              {t("broadcastSendTitle")}
            </h2>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">
                  {t("labelTarget")}
                </label>
                <Select
                  value={broadcastTarget}
                  onValueChange={setBroadcastTarget}
                >
                  <SelectTrigger className="w-[160px] rounded-lg">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("targetAll")}</SelectItem>
                    <SelectItem value="organizers">{t("targetOrganizers")}</SelectItem>
                    <SelectItem value="users">{t("targetUsers")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">
                  {t("labelTitle")}
                </label>
                <Input
                  placeholder={t("placeholderBroadcastTitle")}
                  value={broadcastTitle}
                  onChange={(e) => setBroadcastTitle(e.target.value)}
                  className="rounded-lg"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">
                  {t("labelMessage")}
                </label>
                <Textarea
                  placeholder={t("placeholderBroadcastMessage")}
                  value={broadcastMessage}
                  onChange={(e) => setBroadcastMessage(e.target.value)}
                  rows={4}
                />
              </div>
              <Button
                className="rounded-full"
                disabled={broadcasting}
                onClick={handleBroadcast}
              >
                {broadcasting ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-1" />
                ) : (
                  <Send className="h-4 w-4 mr-1" />
                )}
                {t("buttonBroadcastSend")}
              </Button>
            </div>
          </motion.div>
        </TabsContent>

        {/* History */}
        <TabsContent value="history">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-lg border border-border bg-card mt-4"
          >
            <div className="px-5 py-3 border-b border-border">
              <h3 className="text-sm font-semibold">
                {t("historyTitle", { count: historyTotal ?? 0 })}
              </h3>
            </div>
            {historyLoading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
            ) : history.length === 0 ? (
              <div className="text-center py-16 text-muted-foreground text-sm">
                {t("historyEmpty")}
              </div>
            ) : (
              <>
                <div className="hidden md:grid grid-cols-5 gap-2 px-5 py-2.5 text-xs font-medium text-muted-foreground border-b border-border">
                  <span>{t("colTitle")}</span>
                  <span>{t("colTarget")}</span>
                  <span className="text-right">{t("colRecipients")}</span>
                  <span className="text-right">{t("colDate")}</span>
                  <span className="text-right">{t("colMessage")}</span>
                </div>
                <div className="divide-y divide-border">
                  {history.map((h) => (
                    <div
                      key={h.id}
                      className="grid grid-cols-2 md:grid-cols-5 gap-2 px-5 py-3 text-sm items-center"
                    >
                      <span className="font-medium truncate">{h.title}</span>
                      <span className="hidden md:block">
                        <Badge className="rounded-full" variant="secondary">
                          {TARGET_LABEL[h.target] ?? h.target}
                        </Badge>
                      </span>
                      <span className="text-right hidden md:block font-tabular">
                        {h.recipient_count.toLocaleString()}
                      </span>
                      <span className="text-right hidden md:block text-xs text-muted-foreground">
                        {formatDate(h.created_at)}
                      </span>
                      <span className="text-right hidden md:block text-xs text-muted-foreground truncate">
                        {h.message.slice(0, 50)}
                        {h.message.length > 50 ? "..." : ""}
                      </span>
                    </div>
                  ))}
                </div>
                {historyPages > 1 && (
                  <div className="flex items-center justify-center gap-4 py-3 border-t border-border">
                    <Button
                      variant="outline"
                      size="sm"
                      className="rounded-full"
                      disabled={historySkip === 0}
                      onClick={() =>
                        setHistorySkip((s) => Math.max(0, s - historyLimit))
                      }
                    >
                      {t("buttonPrev")}
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      {Math.floor(historySkip / historyLimit) + 1} /{" "}
                      {historyPages}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="rounded-full"
                      disabled={historySkip + historyLimit >= historyTotal}
                      onClick={() => setHistorySkip((s) => s + historyLimit)}
                    >
                      {t("buttonNext")}
                    </Button>
                  </div>
                )}
              </>
            )}
          </motion.div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
