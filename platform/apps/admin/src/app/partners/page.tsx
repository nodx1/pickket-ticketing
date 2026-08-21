"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { motion } from "motion/react";
import { toast } from "sonner";
import { Loader2, Plus, Copy, Check, KeyRound, Building2 } from "lucide-react";
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
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@pickket/ui";
import {
  getAdminPartners,
  registerPartner,
  isApiCanceled,
  type PartnerInfo,
} from "@pickket/lib/api";
import { formatDate } from "@pickket/lib";

function maskApiKey(key: string) {
  return key.length > 8 ? key.slice(0, 8) + "***" : key;
}

export default function AdminPartnersPage() {
  const t = useTranslations("partners");
  const [partners, setPartners] = useState<PartnerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [formName, setFormName] = useState("");
  const [formEmail, setFormEmail] = useState("");
  const [selected, setSelected] = useState<PartnerInfo | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getAdminPartners();
      setPartners(data);
    } catch (err) {
      if (isApiCanceled(err)) return;
      toast.error(t("loadError"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleRegister = async () => {
    if (!formName.trim() || !formEmail.trim()) {
      toast.error(t("registerValidationError"));
      return;
    }
    setRegistering(true);
    try {
      await registerPartner({
        name: formName.trim(),
        contact_email: formEmail.trim(),
      });
      toast.success(t("registerSuccess"));
      setRegisterOpen(false);
      setFormName("");
      setFormEmail("");
      load();
    } catch {
      toast.error(t("registerError"));
    } finally {
      setRegistering(false);
    }
  };

  const handleCopyKey = async (key: string) => {
    await navigator.clipboard.writeText(key);
    setCopied(true);
    toast.success(t("apiKeyCopied"));
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-5 p-4 md:p-6">
      <h1 className="sr-only">{t("pageTitle")}</h1>

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <p className="text-muted-foreground text-sm">
            {t("pageDescription")}
          </p>
        </div>
        <Button
          className="rounded-full gap-1.5"
          onClick={() => setRegisterOpen(true)}
        >
          <Plus className="h-4 w-4" />
          {t("registerButton")}
        </Button>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border bg-card">
        {loading ? (
          <div className="space-y-4 p-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-12 rounded-md bg-muted animate-pulse" />
            ))}
          </div>
        ) : partners.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
            <Building2 className="h-8 w-8" />
            <span>{t("emptyState")}</span>
          </div>
        ) : (
          <>
            <div className="hidden md:grid grid-cols-6 gap-2 px-5 py-3 text-xs font-medium text-muted-foreground border-b border-border">
              <span>{t("colName")}</span>
              <span>{t("colApiKey")}</span>
              <span className="text-center">{t("colTier")}</span>
              <span className="text-center">{t("colRateLimit")}</span>
              <span className="text-center">{t("colStatus")}</span>
              <span className="text-right">{t("colCreatedAt")}</span>
            </div>
            <div className="divide-y divide-border">
              {partners.map((p, idx) => (
                <motion.div
                  key={p.id}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: idx * 0.02 }}
                  className="grid grid-cols-2 md:grid-cols-6 gap-2 px-5 py-3.5 text-sm items-center hover:bg-muted/50 transition-colors cursor-pointer"
                  onClick={() => setSelected(p)}
                >
                  <span className="font-medium truncate">{p.name}</span>
                  <span className="text-muted-foreground font-mono text-xs truncate hidden md:block">
                    <KeyRound className="inline h-3 w-3 mr-1 -mt-0.5" />
                    {maskApiKey(p.api_key)}
                  </span>
                  <span className="text-center hidden md:flex justify-center">
                    <Badge variant="secondary" className="rounded-full">
                      {p.tier}
                    </Badge>
                  </span>
                  <span className="text-center hidden md:block text-muted-foreground">
                    {p.rate_limit.toLocaleString()}/min
                  </span>
                  <span className="text-center hidden md:flex justify-center">
                    <Badge
                      variant="secondary"
                      className={`rounded-full ${
                        p.is_active
                          ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300"
                          : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300"
                      }`}
                    >
                      {p.is_active ? t("statusActive") : t("statusInactive")}
                    </Badge>
                  </span>
                  <span className="text-right text-muted-foreground text-xs hidden md:block">
                    {formatDate(p.created_at)}
                  </span>
                </motion.div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Register Dialog */}
      <AlertDialog open={registerOpen} onOpenChange={setRegisterOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("registerButton")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("registerDialogDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-3 py-2">
            <Input
              placeholder={t("placeholderName")}
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
            />
            <Input
              placeholder={t("placeholderEmail")}
              type="email"
              value={formEmail}
              onChange={(e) => setFormEmail(e.target.value)}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancelButton")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleRegister} disabled={registering}>
              {registering && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              {t("submitButton")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Detail Sheet */}
      <Sheet
        open={!!selected}
        onOpenChange={(open) => !open && setSelected(null)}
      >
        <SheetContent>
          <SheetHeader>
            <SheetTitle>{selected?.name}</SheetTitle>
            <SheetDescription>{t("detailTitle")}</SheetDescription>
          </SheetHeader>
          {selected && (
            <div className="mt-6 space-y-4 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">ID</span>
                <span className="font-mono text-xs">{selected.id}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">{t("colApiKey")}</span>
                <div className="flex items-center gap-2">
                  <code className="font-mono text-xs bg-muted px-2 py-1 rounded">
                    {selected.api_key}
                  </code>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => handleCopyKey(selected.api_key)}
                  >
                    {copied ? (
                      <Check className="h-3.5 w-3.5 text-green-500" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </div>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t("colTier")}</span>
                <Badge variant="secondary" className="rounded-full">
                  {selected.tier}
                </Badge>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t("colRateLimit")}</span>
                <span>{selected.rate_limit.toLocaleString()}/min</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t("colStatus")}</span>
                <Badge
                  variant="secondary"
                  className={`rounded-full ${
                    selected.is_active
                      ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300"
                      : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300"
                  }`}
                >
                  {selected.is_active ? t("statusActive") : t("statusInactive")}
                </Badge>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t("colCreatedAt")}</span>
                <span>{formatDate(selected.created_at)}</span>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
