"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { motion } from "motion/react";
import { toast } from "sonner";
import {
  ToggleLeft,
  ToggleRight,
  Settings2,
  AlertTriangle,
} from "lucide-react";
import { Button, Badge } from "@pickket/ui";
import {
  getAdminFeatureFlags,
  updateFeatureFlag,
  type FeatureFlag,
} from "@pickket/lib/api";

const FLAG_DANGER: Record<string, boolean> = {
  portone_mock_mode: true,
};

export default function FeatureFlagsPage() {
  const t = useTranslations("featureFlags");
  const [flags, setFlags] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState<string | null>(null);

  const getFlagInfo = (key: string): { label: string; description: string; danger?: boolean } => {
    const knownKeys = ["resale_enabled", "queue_enabled", "portone_mock_mode"] as const;
    if ((knownKeys as readonly string[]).includes(key)) {
      return {
        label: t(`flags.${key}.label`),
        description: t(`flags.${key}.description`),
        danger: FLAG_DANGER[key],
      };
    }
    return { label: key, description: key };
  };

  useEffect(() => {
    getAdminFeatureFlags()
      .then((data) => {
        // Handle both array and object response shapes
        if (Array.isArray(data)) {
          const map: Record<string, boolean> = {};
          (data as FeatureFlag[]).forEach((f) => {
            map[f.key] = f.enabled;
          });
          setFlags(map);
        } else {
          setFlags(data as unknown as Record<string, boolean>);
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const toggleFlag = async (key: string) => {
    setToggling(key);
    try {
      const newValue = !flags[key];
      await updateFeatureFlag(key, newValue);
      setFlags((prev) => ({ ...prev, [key]: newValue }));
      toast.success(
        `${getFlagInfo(key).label} ${newValue ? t("activated") : t("deactivated")}`,
      );
    } catch {
      toast.error(t("updateFailed"));
    } finally {
      setToggling(null);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4 p-4 md:p-6">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-16 rounded-lg bg-muted animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-5 p-4 md:p-6">
      <h1 className="sr-only">{t("title")}</h1>
      <div className="flex items-center gap-3">
        <Settings2 className="h-5 w-5 text-primary" />
        <span className="text-lg font-semibold text-foreground">
          {t("title")}
        </span>
      </div>

      <div className="space-y-3">
        {Object.entries(flags).map(([key, value], idx) => {
          const info = getFlagInfo(key);
          return (
            <motion.div
              key={key}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: idx * 0.05 }}
              className="flex items-center justify-between p-4 border rounded-xl bg-card"
            >
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-medium">{info?.label || key}</span>
                  <Badge
                    variant={value ? "default" : "secondary"}
                    className="text-xs"
                  >
                    {value ? "ON" : "OFF"}
                  </Badge>
                  {info?.danger && (
                    <span className="flex items-center gap-1 text-xs text-amber-500">
                      <AlertTriangle className="h-3 w-3" />
                      {t("danger")}
                    </span>
                  )}
                </div>
                <p className="text-sm text-muted-foreground mt-0.5">
                  {info?.description || key}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => toggleFlag(key)}
                disabled={toggling === key}
              >
                {value ? (
                  <ToggleRight className="h-6 w-6 text-primary" />
                ) : (
                  <ToggleLeft className="h-6 w-6 text-muted-foreground" />
                )}
              </Button>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
