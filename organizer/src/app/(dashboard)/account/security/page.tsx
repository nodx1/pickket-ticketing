"use client";

import { useEffect, useState } from "react";
import { Loader2, Shield, ShieldCheck, ShieldOff, Copy, Check } from "lucide-react";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fetchWithAuth } from "@/lib/fetchWithAuth";
import { showError, showSuccess } from "@/lib/hooks/useToast";

interface MfaStatus {
  enabled: boolean;
}

interface SetupData {
  qrDataUri: string;
  secret: string;
  backupCodes: string[];
}

export default function SecurityPage() {
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState<"idle" | "setup" | "verify" | "backup" | "disable">("idle");
  const [setupData, setSetupData] = useState<SetupData | null>(null);
  const [verifyCode, setVerifyCode] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    async function loadStatus() {
      try {
        const res = await fetchWithAuth<{ data: { mfaEnabled: boolean } }>("/api/auth/me");
        setStatus({ enabled: res.data?.mfaEnabled ?? false });
      } catch {
        setStatus({ enabled: false });
      } finally {
        setLoading(false);
      }
    }
    void loadStatus();
  }, []);

  async function handleSetup() {
    setSubmitting(true);
    try {
      const res = await fetchWithAuth<{ data: SetupData }>("/api/auth/mfa/setup", {
        method: "POST",
      });
      if (!res.data) throw new Error("셋업 실패");
      setSetupData(res.data);
      setStep("verify");
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "MFA 설정에 실패했습니다");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleVerify() {
    if (verifyCode.length !== 6) return;
    setSubmitting(true);
    try {
      await fetchWithAuth("/api/auth/mfa/verify", {
        method: "POST",
        body: JSON.stringify({ token: verifyCode }),
      });
      showSuccess("2차 인증이 활성화되었습니다");
      setStep("backup");
      setStatus({ enabled: true });
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "인증 코드가 올바르지 않습니다");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDisable() {
    if (disableCode.length !== 6) return;
    setSubmitting(true);
    try {
      await fetchWithAuth("/api/auth/mfa/disable", {
        method: "POST",
        body: JSON.stringify({ token: disableCode }),
      });
      showSuccess("2차 인증이 비활성화되었습니다");
      setStep("idle");
      setStatus({ enabled: false });
      setDisableCode("");
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "비활성화에 실패했습니다");
    } finally {
      setSubmitting(false);
    }
  }

  function copyBackupCodes() {
    if (!setupData) return;
    void navigator.clipboard.writeText(setupData.backupCodes.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted-foreground">계정 보안</p>
        <h2 className="mt-2 text-3xl font-black tracking-[-0.04em]">2차 인증 (TOTP)</h2>
      </div>

      {/* 현재 상태 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {status?.enabled ? (
              <>
                <ShieldCheck className="size-5 text-success" />
                2차 인증 활성화됨
              </>
            ) : (
              <>
                <Shield className="size-5 text-muted-foreground" />
                2차 인증 비활성화
              </>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {status?.enabled ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                로그인 시 인증 앱의 6자리 코드를 추가로 입력해야 합니다.
              </p>
              {step === "disable" ? (
                <div className="space-y-3">
                  <Label>현재 인증 코드를 입력하세요</Label>
                  <div className="flex gap-2">
                    <Input
                      value={disableCode}
                      onChange={(e) => setDisableCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                      placeholder="000000"
                      maxLength={6}
                      className="w-40 font-mono text-lg tracking-widest"
                    />
                    <Button onClick={() => void handleDisable()} disabled={submitting || disableCode.length !== 6}>
                      {submitting ? <Loader2 className="size-4 animate-spin" /> : "비활성화"}
                    </Button>
                    <Button variant="outline" onClick={() => { setStep("idle"); setDisableCode(""); }}>
                      취소
                    </Button>
                  </div>
                </div>
              ) : (
                <Button variant="outline" className="border-error/40 text-error" onClick={() => setStep("disable")}>
                  <ShieldOff className="mr-2 size-4" />
                  2차 인증 비활성화
                </Button>
              )}
            </div>
          ) : step === "idle" ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Google Authenticator, Microsoft Authenticator 등의 인증 앱으로 계정을 보호하세요.
              </p>
              <Button onClick={() => void handleSetup()} disabled={submitting}>
                {submitting ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Shield className="mr-2 size-4" />}
                2차 인증 설정하기
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* 셋업 — QR 코드 + 코드 입력 */}
      {step === "verify" && setupData && (
        <Card>
          <CardHeader>
            <CardTitle>인증 앱에 등록하세요</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
              <div className="shrink-0 rounded-lg border border-border bg-card p-2">
                <Image src={setupData.qrDataUri} alt="QR Code" width={200} height={200} unoptimized />
              </div>
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  1. 인증 앱 (Google Authenticator 등)을 열어주세요<br />
                  2. QR 코드를 스캔하거나 아래 키를 수동 입력하세요<br />
                  3. 앱에 표시된 6자리 코드를 입력하세요
                </p>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">수동 입력 키</Label>
                  <code className="block rounded bg-muted px-3 py-2 font-mono text-sm tracking-wider">
                    {setupData.secret}
                  </code>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label>인증 코드 입력</Label>
              <div className="flex gap-2">
                <Input
                  value={verifyCode}
                  onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="000000"
                  maxLength={6}
                  className="w-40 font-mono text-lg tracking-widest"
                  autoFocus
                  onKeyDown={(e) => { if (e.key === "Enter") void handleVerify(); }}
                />
                <Button onClick={() => void handleVerify()} disabled={submitting || verifyCode.length !== 6}>
                  {submitting ? <Loader2 className="size-4 animate-spin" /> : "확인"}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 백업 코드 표시 (최초 1회) */}
      {step === "backup" && setupData && (
        <Card className="border-warning/30 bg-warning/5">
          <CardHeader>
            <CardTitle className="text-warning">백업 코드를 안전한 곳에 저장하세요</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              인증 앱에 접근할 수 없을 때 아래 코드로 로그인할 수 있습니다.
              <strong> 이 코드는 다시 표시되지 않습니다.</strong>
            </p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {setupData.backupCodes.map((code) => (
                <code key={code} className="rounded bg-card px-3 py-2 text-center font-mono text-sm tracking-wider">
                  {code}
                </code>
              ))}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={copyBackupCodes}>
                {copied ? <Check className="mr-2 size-4" /> : <Copy className="mr-2 size-4" />}
                {copied ? "복사됨" : "코드 복사"}
              </Button>
              <Button onClick={() => setStep("idle")}>확인, 저장했습니다</Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
