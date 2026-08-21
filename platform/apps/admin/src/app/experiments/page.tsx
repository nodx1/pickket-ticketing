"use client";

import { useCallback, useEffect, useState } from "react";
import { motion } from "motion/react";
import { toast } from "sonner";
import {
  FlaskConical,
  Pause,
  Play,
  Plus,
  Square,
  TrendingUp,
} from "lucide-react";
import { Badge, Button } from "@pickket/ui";
import {
  getABTests,
  createABTest,
  updateABTest,
  isApiCanceled,
  type ABTestItem,
  type ABTestStatus,
  type CreateABTestData,
} from "@pickket/lib/api";
import { useTranslations } from "next-intl";

import ExperimentDetail from "./_components/ExperimentDetail";
import CreateExperimentDialog from "./_components/CreateExperimentDialog";

const STATUS_COLORS: Record<ABTestStatus, string> = {
  DRAFT: "secondary",
  RUNNING: "default",
  PAUSED: "outline",
  COMPLETED: "destructive",
};

export default function ExperimentsPage() {
  const t = useTranslations("experiments");
  const [experiments, setExperiments] = useState<ABTestItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<ABTestStatus | "ALL">("ALL");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const STATUS_LABELS: Record<ABTestStatus, { label: string; color: string }> = {
    DRAFT: { label: t("status.draft"), color: STATUS_COLORS.DRAFT },
    RUNNING: { label: t("status.running"), color: STATUS_COLORS.RUNNING },
    PAUSED: { label: t("status.paused"), color: STATUS_COLORS.PAUSED },
    COMPLETED: { label: t("status.completed"), color: STATUS_COLORS.COMPLETED },
  };

  const loadExperiments = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, unknown> = {};
      if (statusFilter !== "ALL") params.status = statusFilter;
      const data = await getABTests(params as Parameters<typeof getABTests>[0]);
      setExperiments(data.items);
    } catch (err) {
      if (isApiCanceled(err)) return;
      toast.error(t("toast.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [statusFilter, t]);

  useEffect(() => {
    loadExperiments();
  }, [loadExperiments]);

  const handleCreate = async (data: CreateABTestData) => {
    try {
      await createABTest(data);
      toast.success(t("toast.createSuccess"));
      setShowCreate(false);
      loadExperiments();
    } catch {
      toast.error(t("toast.createFailed"));
    }
  };

  const handleStatusChange = async (id: string, newStatus: ABTestStatus) => {
    try {
      await updateABTest(id, { status: newStatus });
      toast.success(
        t("toast.statusChanged", { label: STATUS_LABELS[newStatus].label ?? "" }),
      );
      loadExperiments();
    } catch {
      toast.error(t("toast.statusChangeFailed"));
    }
  };

  if (selectedId) {
    return (
      <ExperimentDetail
        experimentId={selectedId}
        onBack={() => {
          setSelectedId(null);
          loadExperiments();
        }}
      />
    );
  }

  return (
    <div className="space-y-5 p-4 md:p-6">
      <h1 className="sr-only">{t("title")}</h1>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <FlaskConical className="h-5 w-5 text-primary" />
          <span className="text-lg font-semibold text-foreground">
            {t("title")}
          </span>
        </div>
        <Button
          onClick={() => setShowCreate(true)}
          size="sm"
          className="rounded-full"
        >
          <Plus className="h-4 w-4 mr-1" />{t("newExperiment")}
        </Button>
      </div>

      {/* Status filter */}
      <div className="flex gap-2 flex-wrap">
        {(["ALL", "DRAFT", "RUNNING", "PAUSED", "COMPLETED"] as const).map(
          (s) => (
            <Button
              key={s}
              variant={statusFilter === s ? "default" : "outline"}
              size="sm"
              className="rounded-full"
              onClick={() => setStatusFilter(s)}
            >
              {s === "ALL" ? t("filter.all") : STATUS_LABELS[s].label}
            </Button>
          ),
        )}
      </div>

      {/* List */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-20 rounded-lg bg-muted animate-pulse" />
          ))}
        </div>
      ) : experiments.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground">
          <FlaskConical className="h-12 w-12 mx-auto mb-3 opacity-30" />
          <p>{t("empty.noExperiments")}</p>
          <p className="text-sm mt-1">{t("empty.startNew")}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {experiments.map((exp, idx) => {
            const statusInfo = STATUS_LABELS[exp.status];
            return (
              <motion.div
                key={exp.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: idx * 0.04 }}
                className="flex items-center justify-between p-4 border rounded-xl bg-card hover:border-primary/30 transition-colors cursor-pointer"
                onClick={() => setSelectedId(exp.id)}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium truncate">{exp.name}</span>
                    <Badge
                      variant={
                        statusInfo.color as
                          | "default"
                          | "secondary"
                          | "outline"
                          | "destructive"
                      }
                      className="text-xs shrink-0"
                    >
                      {statusInfo.label}
                    </Badge>
                  </div>
                  {exp.description && (
                    <p className="text-sm text-muted-foreground truncate">
                      {exp.description}
                    </p>
                  )}
                  <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                    <span>{t("variantCount", { count: exp.variants.length ?? 0 })}</span>
                    {exp.metric_key && <span>{exp.metric_key}</span>}
                    <span>
                      {new Date(exp.created_at).toLocaleDateString("ko-KR")}
                    </span>
                  </div>
                </div>

                <div
                  className="flex items-center gap-1 ml-4 shrink-0"
                  onClick={(e) => e.stopPropagation()}
                >
                  {exp.status === "DRAFT" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleStatusChange(exp.id, "RUNNING")}
                      title={t("action.run")}
                    >
                      <Play className="h-4 w-4 text-green-500" />
                    </Button>
                  )}
                  {exp.status === "RUNNING" && (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleStatusChange(exp.id, "PAUSED")}
                        title={t("action.pause")}
                      >
                        <Pause className="h-4 w-4 text-amber-500" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleStatusChange(exp.id, "COMPLETED")}
                        title={t("action.complete")}
                      >
                        <Square className="h-4 w-4 text-red-500" />
                      </Button>
                    </>
                  )}
                  {exp.status === "PAUSED" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleStatusChange(exp.id, "RUNNING")}
                      title={t("action.resume")}
                    >
                      <Play className="h-4 w-4 text-green-500" />
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" title={t("action.viewResults")}>
                    <TrendingUp className="h-4 w-4" />
                  </Button>
                </div>
              </motion.div>
            );
          })}
        </div>
      )}

      {showCreate && (
        <CreateExperimentDialog
          open={showCreate}
          onClose={() => setShowCreate(false)}
          onSubmit={handleCreate}
        />
      )}
    </div>
  );
}
