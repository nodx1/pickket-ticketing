"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Button } from "@pickket/ui";
import { Input } from "@pickket/ui";
import { Label } from "@pickket/ui";
import api from "@pickket/lib/api";

export default function ChangePasswordPage() {
  const t = useTranslations("mypage.changePassword");
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (newPassword.length < 8) {
      toast.error(t("errorMinLength"));
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error(t("errorMismatch"));
      return;
    }

    setLoading(true);
    try {
      await api.post("/users/me/change-password", {
        current_password: currentPassword,
        new_password: newPassword,
      });
      toast.success(t("successChanged"));
      router.push("/mypage");
    } catch (err: unknown) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail || t("errorFailed");
      toast.error(detail);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto px-8 pt-24 pb-10">
        <div className="flex items-center gap-3 mb-8">
          <Link href="/mypage">
            <button
              type="button"
              className="rounded-full p-2 hover:bg-muted transition-colors"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
          </Link>
          <div>
            <h1 className="text-xl font-bold text-foreground">{t("title")}</h1>
            <p className="text-sm text-muted-foreground">
              {t("subtitle")}
            </p>
          </div>
        </div>

        <div className="max-w-md mx-auto rounded-2xl border border-border/50 bg-background shadow-sm p-8">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label htmlFor="current">{t("labelCurrent")}</Label>
              <Input
                id="current"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
              />
            </div>
            <div>
              <Label htmlFor="new">{t("labelNew")}</Label>
              <Input
                id="new"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder={t("placeholderMinLength")}
                required
              />
            </div>
            <div>
              <Label htmlFor="confirm">{t("labelConfirm")}</Label>
              <Input
                id="confirm"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
              />
            </div>
            <Button
              type="submit"
              disabled={loading}
              className="w-full rounded-xl"
            >
              {loading ? t("buttonLoading") : t("buttonSubmit")}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
