"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  Loader2,
  Send,
  AlertTriangle,
  ArrowLeft,
  MessageSquare,
} from "lucide-react";
import {
  Badge,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@pickket/ui";
import {
  getCSTicket,
  updateCSTicket,
  addCSTicketComment,
  escalateCSTicket,
  type CSTicketDetail as CSTicketDetailType,
  type CSTicketComment,
} from "@pickket/lib/api";
import { formatDate } from "@pickket/lib";
import Link from "next/link";

import SlaTimer from "./SlaTimer";
import { STATUS_COLOR, PRIORITY_COLOR } from "./TicketList";

interface TicketDetailProps {
  ticketId: string;
}

export default function TicketDetail({ ticketId }: TicketDetailProps) {
  const t = useTranslations("ticket.detail");

  const STATUS_LABEL: Record<string, string> = {
    open: t("status.open"),
    in_progress: t("status.inProgress"),
    waiting_customer: t("status.waitingCustomer"),
    resolved: t("status.resolved"),
    closed: t("status.closed"),
  };

  const PRIORITY_LABEL: Record<string, string> = {
    low: t("priority.low"),
    normal: t("priority.normal"),
    high: t("priority.high"),
    urgent: t("priority.urgent"),
  };

  const CATEGORY_LABEL: Record<string, string> = {
    refund: t("category.refund"),
    payment: t("category.payment"),
    account: t("category.account"),
    event: t("category.event"),
    technical: t("category.technical"),
    other: t("category.other"),
  };

  const [ticket, setTicket] = useState<CSTicketDetailType | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);

  // Comment form
  const [commentText, setCommentText] = useState("");
  const [isInternal, setIsInternal] = useState(false);
  const [sendingComment, setSendingComment] = useState(false);

  // Edit fields
  const [editStatus, setEditStatus] = useState("");
  const [editPriority, setEditPriority] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getCSTicket(ticketId);
      setTicket(data);
      setEditStatus(data.status);
      setEditPriority(data.priority);
    } catch {
      toast.error(t("loadError"));
    } finally {
      setLoading(false);
    }
  }, [ticketId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleStatusChange = async (newStatus: string) => {
    const prevStatus = editStatus;
    setEditStatus(newStatus);
    try {
      await updateCSTicket(ticketId, { status: newStatus });
      toast.success(t("statusChanged"));
      load();
    } catch {
      setEditStatus(prevStatus); // 롤백
      toast.error(t("statusChangeError"));
    }
  };

  const handlePriorityChange = async (newPriority: string) => {
    const prevPriority = editPriority;
    setEditPriority(newPriority);
    try {
      await updateCSTicket(ticketId, { priority: newPriority });
      toast.success(t("priorityChanged"));
      load();
    } catch {
      setEditPriority(prevPriority); // 롤백
      toast.error(t("priorityChangeError"));
    }
  };

  const handleEscalate = async () => {
    setActionLoading(true);
    try {
      await escalateCSTicket(ticketId);
      toast.success(t("escalateSuccess"));
      load();
    } catch {
      toast.error(t("escalateError"));
    } finally {
      setActionLoading(false);
    }
  };

  const handleAddComment = async () => {
    if (!commentText.trim()) return;
    setSendingComment(true);
    try {
      await addCSTicketComment(ticketId, {
        content: commentText.trim(),
        is_internal: isInternal,
      });
      setCommentText("");
      toast.success(t("commentAdded"));
      load();
    } catch {
      toast.error(t("commentAddError"));
    } finally {
      setSendingComment(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (!ticket) {
    return (
      <div className="text-center py-20 text-muted-foreground">
        {t("notFound")}
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4 md:p-6 max-w-4xl">
      {/* Back */}
      <Link
        href="/cs"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        {t("backToList")}
      </Link>

      {/* Header */}
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-semibold truncate">
              {ticket.escalated && (
                <span className="text-red-500 mr-1">[!]</span>
              )}
              {ticket.subject}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              {ticket.reporter_name || ticket.reporter_email} |{" "}
              {formatDate(ticket.created_at)}
            </p>
          </div>
          <SlaTimer
            deadline={ticket.sla_deadline ?? null}
            status={ticket.status}
          />
        </div>

        <div className="flex flex-wrap gap-2">
          <Badge
            className={`rounded-full ${STATUS_COLOR[ticket.status] || ""}`}
            variant="secondary"
          >
            {STATUS_LABEL[ticket.status] ?? ticket.status}
          </Badge>
          <Badge
            className={`rounded-full ${PRIORITY_COLOR[ticket.priority] || ""}`}
            variant="secondary"
          >
            {PRIORITY_LABEL[ticket.priority] ?? ticket.priority}
          </Badge>
          <Badge className="rounded-full" variant="outline">
            {CATEGORY_LABEL[ticket.category] ?? ticket.category}
          </Badge>
        </div>
      </div>

      {/* Info card */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-3 text-sm">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <span className="text-muted-foreground">{t("reporter")}</span>
            <p className="font-medium">
              {ticket.reporter_name ||
                ticket.reporter_email ||
                ticket.reporter_id}
            </p>
          </div>
          <div>
            <span className="text-muted-foreground">{t("assignee")}</span>
            <p className="font-medium">
              {ticket.assignee_name || ticket.assignee_email || t("unassigned")}
            </p>
          </div>
          {ticket.event_title && (
            <div>
              <span className="text-muted-foreground">{t("relatedEvent")}</span>
              <p className="font-medium">{ticket.event_title}</p>
            </div>
          )}
          {ticket.related_order_id && (
            <div>
              <span className="text-muted-foreground">{t("relatedOrder")}</span>
              <p className="font-mono text-xs">{ticket.related_order_id}</p>
            </div>
          )}
          {ticket.resolved_at && (
            <div>
              <span className="text-muted-foreground">{t("resolvedAt")}</span>
              <p>{formatDate(ticket.resolved_at)}</p>
            </div>
          )}
        </div>

        <div className="pt-3 border-t border-border">
          <span className="text-muted-foreground">{t("description")}</span>
          <p className="mt-1 whitespace-pre-wrap">{ticket.description}</p>
        </div>
      </div>

      {/* Actions */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-4">
        <h2 className="text-sm font-semibold">{t("manageTitle")}</h2>
        <div className="flex flex-wrap gap-3">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">{t("statusLabel")}</label>
            <Select value={editStatus} onValueChange={handleStatusChange}>
              <SelectTrigger className="w-[160px] rounded-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="open">{t("status.open")}</SelectItem>
                <SelectItem value="in_progress">{t("status.inProgress")}</SelectItem>
                <SelectItem value="waiting_customer">{t("status.waitingCustomer")}</SelectItem>
                <SelectItem value="resolved">{t("status.resolved")}</SelectItem>
                <SelectItem value="closed">{t("status.closed")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">{t("priorityLabel")}</label>
            <Select value={editPriority} onValueChange={handlePriorityChange}>
              <SelectTrigger className="w-[140px] rounded-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="low">{t("priority.low")}</SelectItem>
                <SelectItem value="normal">{t("priority.normal")}</SelectItem>
                <SelectItem value="high">{t("priority.high")}</SelectItem>
                <SelectItem value="urgent">{t("priority.urgent")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {!ticket.escalated && (
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">&nbsp;</label>
              <div>
                <Button
                  variant="destructive"
                  size="sm"
                  className="rounded-full"
                  disabled={actionLoading}
                  onClick={handleEscalate}
                >
                  {actionLoading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                  ) : (
                    <AlertTriangle className="h-3.5 w-3.5 mr-1" />
                  )}
                  {t("escalate")}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Comments */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-4">
        <h2 className="text-sm font-semibold flex items-center gap-1.5">
          <MessageSquare className="h-4 w-4" />
          {t("commentsTitle", { count: ticket.comments.length ?? 0 })}
        </h2>

        {ticket.comments.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noComments")}</p>
        ) : (
          <div className="space-y-3">
            {ticket.comments.map((comment: CSTicketComment) => (
              <div
                key={comment.id}
                className={`rounded-lg p-3 text-sm ${
                  comment.is_internal
                    ? "bg-yellow-50 border border-yellow-200 dark:bg-yellow-900/10 dark:border-yellow-800"
                    : "bg-muted/50 border border-border"
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-medium text-xs">
                    {comment.author_name ||
                      comment.author_email ||
                      comment.author_id}
                    {comment.is_internal && (
                      <span className="ml-1 text-yellow-600 dark:text-yellow-400">
                        {t("internalMemoTag")}
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatDate(comment.created_at)}
                  </span>
                </div>
                <p className="whitespace-pre-wrap">{comment.content}</p>
              </div>
            ))}
          </div>
        )}

        {/* Add comment */}
        <div className="pt-3 border-t border-border space-y-3">
          <Textarea
            placeholder={t("commentPlaceholder")}
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            className="min-h-[80px]"
          />
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={isInternal}
                onChange={(e) => setIsInternal(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-muted-foreground"
              />
              <span className="text-muted-foreground">{t("internalMemoLabel")}</span>
            </label>
            <Button
              size="sm"
              className="rounded-full"
              disabled={!commentText.trim() || sendingComment}
              onClick={handleAddComment}
            >
              {sendingComment ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
              ) : (
                <Send className="h-3.5 w-3.5 mr-1" />
              )}
              {t("addComment")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
