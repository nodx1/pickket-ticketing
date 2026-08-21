"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { motion } from "motion/react";
import { toast } from "sonner";
import { Loader2, Save, X, Pencil } from "lucide-react";
import {
  Button,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Input,
} from "@pickket/ui";
import {
  getAdminDomainConfig,
  setAdminDomainConfig,
  isApiCanceled,
} from "@pickket/lib/api";

const DOMAIN_KEYS = [
  "concert",
  "sports",
  "festival",
  "exhibition",
  "classical",
  "musical",
  "esports",
] as const;

interface ConfigEntry {
  key: string;
  value: unknown;
}

export default function AdminSettingsPage() {
  const t = useTranslations("settings.domain");

  const DOMAINS = DOMAIN_KEYS.map((key) => ({
    key,
    label: t(`keys.${key}`),
  }));

  const [activeDomain, setActiveDomain] = useState(DOMAINS[0].key);
  const [config, setConfig] = useState<ConfigEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [saving, setSaving] = useState(false);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getAdminDomainConfig(activeDomain);
      // data could be an object with key-value pairs
      if (data && typeof data === "object") {
        const entries: ConfigEntry[] = Object.entries(data).map(
          ([key, value]) => ({
            key,
            value,
          }),
        );
        setConfig(entries);
      } else {
        setConfig([]);
      }
    } catch (err) {
      if (isApiCanceled(err)) return;
      toast.error(t("toast.loadFailed"));
      setConfig([]);
    } finally {
      setLoading(false);
    }
  }, [activeDomain]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const startEdit = (entry: ConfigEntry) => {
    setEditingKey(entry.key);
    setEditValue(
      typeof entry.value === "string"
        ? entry.value
        : JSON.stringify(entry.value),
    );
  };

  const cancelEdit = () => {
    setEditingKey(null);
    setEditValue("");
  };

  const saveEdit = async (key: string) => {
    setSaving(true);
    try {
      let parsedValue: unknown = editValue;
      // Try parsing as JSON for non-string values
      try {
        parsedValue = JSON.parse(editValue);
      } catch {
        // Keep as string if not valid JSON
        parsedValue = editValue;
      }
      await setAdminDomainConfig(activeDomain, key, parsedValue);
      toast.success(t("toast.saveSuccess", { key: key ?? "" }));
      setEditingKey(null);
      setEditValue("");
      loadConfig();
    } catch {
      toast.error(t("toast.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5 p-4 md:p-6">
      <h1 className="sr-only">{t("pageTitle")}</h1>

      <Tabs
        value={activeDomain}
        onValueChange={(v) => {
          setActiveDomain(v as (typeof DOMAIN_KEYS)[number]);
          setEditingKey(null);
        }}
      >
        <TabsList className="flex flex-wrap">
          {DOMAINS.map((d) => (
            <TabsTrigger key={d.key} value={d.key}>
              {d.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {DOMAINS.map((d) => (
          <TabsContent key={d.key} value={d.key}>
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-lg border border-border bg-card mt-4"
            >
              <div className="px-5 py-3 border-b border-border">
                <h3 className="text-sm font-semibold">{t("sectionTitle", { label: d.label ?? "" })}</h3>
              </div>
              {loading ? (
                <div className="flex items-center justify-center py-16">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                </div>
              ) : config.length === 0 ? (
                <div className="text-center py-16 text-muted-foreground text-sm">
                  {t("empty")}
                </div>
              ) : (
                <>
                  <div className="hidden md:grid grid-cols-3 gap-2 px-5 py-2.5 text-xs font-medium text-muted-foreground border-b border-border">
                    <span>{t("col.key")}</span>
                    <span>{t("col.value")}</span>
                    <span className="text-right">{t("col.action")}</span>
                  </div>
                  <div className="divide-y divide-border">
                    {config.map((entry) => (
                      <div
                        key={entry.key}
                        className="grid grid-cols-1 md:grid-cols-3 gap-2 px-5 py-3 text-sm items-center"
                      >
                        <span className="font-medium font-mono text-xs">
                          {entry.key}
                        </span>
                        {editingKey === entry.key ? (
                          <>
                            <div className="flex gap-2">
                              <Input
                                value={editValue}
                                onChange={(e) => setEditValue(e.target.value)}
                                className="rounded-lg text-xs"
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") saveEdit(entry.key);
                                  if (e.key === "Escape") cancelEdit();
                                }}
                                autoFocus
                              />
                            </div>
                            <div className="flex gap-1 justify-end">
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-8 w-8"
                                disabled={saving}
                                onClick={() => saveEdit(entry.key)}
                              >
                                {saving ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Save className="h-3.5 w-3.5 text-green-500" />
                                )}
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-8 w-8"
                                onClick={cancelEdit}
                              >
                                <X className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </>
                        ) : (
                          <>
                            <span className="text-muted-foreground text-xs truncate font-mono">
                              {typeof entry.value === "string"
                                ? entry.value
                                : JSON.stringify(entry.value)}
                            </span>
                            <span className="text-right">
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-8 w-8"
                                onClick={() => startEdit(entry)}
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                            </span>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </motion.div>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
