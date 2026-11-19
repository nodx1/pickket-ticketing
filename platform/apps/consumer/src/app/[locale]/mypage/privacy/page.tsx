"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { toast } from "sonner";
import {
  ArrowLeft,
  Shield,
  Download,
  Trash2,
  ToggleLeft,
  ToggleRight,
  AlertTriangle,
  Loader2,
} from "lucide-react";
import Link from "next/link";
import { Button } from "@pickket/ui";
import { Input } from "@pickket/ui";
import { Label } from "@pickket/ui";
import { useAuthStore } from "@pickket/store";
import {
  getConsents,
  updateConsent,
  exportMyData,
  deleteAccount,
  type ConsentItem,
} from "@pickket/lib/api";
import { useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";

const PURPOSE_LABELS: Record<string, { label: string; description: string }> = {
  marketing: {
    label: "마케팅 동의",
    description: "이벤트, 프로모션, 신규 공연 정보를 받습니다.",
  },
  analytics: {
    label: "분석 동의",
    description: "서비스 이용 패턴을 분석하여 사용자 경험을 개선합니다.",
  },
  third_party: {
    label: "제3자 제공 동의",
    description: "파트너사에 공연 관련 정보를 제공합니다.",
  },
};

export default function PrivacyPage() {
  const _t = useTranslations();
  const router = useRouter();
  const { user, logout } = useAuthStore();
  const queryClient = useQueryClient();

  const [consents, setConsents] = useState<ConsentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [togglingPurpose, setTogglingPurpose] = useState<string | null>(null);

  const fetchConsents = useCallback(async () => {
    try {
      const res = await getConsents();
      setConsents(res.data);
    } catch {
      toast.error("동의 정보를 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConsents();
  }, [fetchConsents]);

  const handleToggleConsent = async (
    purpose: string,
    currentValue: boolean,
  ) => {
    setTogglingPurpose(purpose);
    try {
      await updateConsent(purpose, !currentValue);
      setConsents((prev) =>
        prev.map((c) =>
          c.purpose === purpose ? { ...c, consented: !currentValue } : c,
        ),
      );
      toast.success(
        !currentValue ? "동의되었습니다." : "동의가 철회되었습니다.",
      );
    } catch {
      toast.error("동의 상태 변경에 실패했습니다.");
    } finally {
      setTogglingPurpose(null);
    }
  };

  const handleExportData = async () => {
    setExporting(true);
    try {
      const res = await exportMyData();
      const blob = new Blob([JSON.stringify(res.data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `pickket_data_${user?.id || "export"}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("데이터 내보내기가 완료되었습니다.");
    } catch {
      toast.error("데이터 내보내기에 실패했습니다.");
    } finally {
      setExporting(false);
    }
  };

  const handleDeleteAccount = async () => {
    if (deleteConfirm !== "삭제") return;
    setDeleting(true);
    try {
      await deleteAccount();
      toast.success("계정 삭제가 요청되었습니다. 30일 후 완전히 삭제됩니다.");
      logout();
      queryClient.clear();
      router.push("/");
    } catch {
      toast.error("계정 삭제 요청에 실패했습니다.");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-7xl px-4 sm:px-8 pt-24 pb-10">
        {/* 헤더 */}
        <div className="flex items-center gap-3 mb-8">
          <Link href="/mypage">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-5 w-5" />
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold">개인정보 관리</h1>
            <p className="text-sm text-muted-foreground">
              동의 관리, 데이터 내보내기, 계정 삭제
            </p>
          </div>
        </div>

        {/* 동의 관리 */}
        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8"
        >
          <div className="flex items-center gap-2 mb-4">
            <Shield className="h-5 w-5 text-primary/70" />
            <h2 className="text-lg font-semibold">동의 관리</h2>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="space-y-3">
              {consents.map((consent) => {
                const meta = PURPOSE_LABELS[consent.purpose] || {
                  label: consent.purpose,
                  description: "",
                };
                const isToggling = togglingPurpose === consent.purpose;

                return (
                  <div
                    key={consent.purpose}
                    className="flex items-center justify-between rounded-xl border p-4 hover:bg-white/5 transition-colors"
                  >
                    <div className="flex-1 mr-4">
                      <p className="font-medium text-sm">{meta.label}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {meta.description}
                      </p>
                      {consent.consented_at && (
                        <p className="text-xs text-muted-foreground mt-1">
                          동의일:{" "}
                          {new Date(consent.consented_at).toLocaleDateString(
                            "ko-KR",
                          )}
                        </p>
                      )}
                    </div>
                    <button
                      onClick={() =>
                        handleToggleConsent(consent.purpose, consent.consented)
                      }
                      disabled={isToggling}
                      className="shrink-0 transition-opacity disabled:opacity-50"
                    >
                      {isToggling ? (
                        <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
                      ) : consent.consented ? (
                        <ToggleRight className="h-8 w-8 text-primary/70" />
                      ) : (
                        <ToggleLeft className="h-8 w-8 text-muted-foreground" />
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </motion.section>

        {/* 데이터 내보내기 */}
        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="mb-8"
        >
          <div className="flex items-center gap-2 mb-4">
            <Download className="h-5 w-5 text-blue-500" />
            <h2 className="text-lg font-semibold">내 데이터 내보내기</h2>
          </div>
          <div className="rounded-xl border p-4">
            <p className="text-sm text-muted-foreground mb-3">
              Pickket에 저장된 개인 데이터(프로필, 주문, 티켓, 응모 기록 등)를
              JSON 파일로 다운로드할 수 있습니다.
            </p>
            <Button
              onClick={handleExportData}
              disabled={exporting}
              variant="outline"
            >
              {exporting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  내보내는 중...
                </>
              ) : (
                <>
                  <Download className="h-4 w-4 mr-2" />
                  데이터 다운로드 (JSON)
                </>
              )}
            </Button>
          </div>
        </motion.section>

        {/* 계정 삭제 */}
        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
        >
          <div className="flex items-center gap-2 mb-4">
            <Trash2 className="h-5 w-5 text-destructive" />
            <h2 className="text-lg font-semibold text-destructive">
              계정 삭제
            </h2>
          </div>

          <div className="rounded-xl border border-destructive/20 p-4">
            <div className="flex items-start gap-3 mb-4">
              <AlertTriangle className="h-5 w-5 text-destructive mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-medium text-destructive">
                  이 작업은 되돌릴 수 없습니다.
                </p>
                <p className="text-sm text-muted-foreground mt-1">
                  계정 삭제를 요청하면 30일의 유예 기간 후 모든 개인정보가
                  익명화됩니다. 유예 기간 중에는 로그인하여 삭제를 취소할 수
                  있습니다.
                </p>
              </div>
            </div>

            {!showDeleteDialog ? (
              <Button
                variant="destructive"
                onClick={() => setShowDeleteDialog(true)}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                계정 삭제 요청
              </Button>
            ) : (
              <div className="space-y-3">
                <div>
                  <Label className="text-sm">
                    확인을 위해 <strong>삭제</strong>를 입력하세요
                  </Label>
                  <Input
                    value={deleteConfirm}
                    onChange={(e) => setDeleteConfirm(e.target.value)}
                    placeholder="삭제"
                    className="mt-1"
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="destructive"
                    onClick={handleDeleteAccount}
                    disabled={deleteConfirm !== "삭제" || deleting}
                  >
                    {deleting ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        처리 중...
                      </>
                    ) : (
                      "삭제 확인"
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setShowDeleteDialog(false);
                      setDeleteConfirm("");
                    }}
                  >
                    취소
                  </Button>
                </div>
              </div>
            )}
          </div>
        </motion.section>
      </div>
    </div>
  );
}
