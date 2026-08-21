"use client";

import { useEffect, useId, useState } from "react";
import { BusinessVerificationCard } from "./business-verification-card";
import { NotificationPrefsCard } from "./notification-prefs-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { showError, showSuccess } from "@/lib/hooks/useToast";
import { canSaveEditor } from "@/lib/forms/save-guard";
import { fetchWithRefresh } from "@/lib/fetchWithAuth";

export function AccountSettingsClient() {
  const [profile, setProfile] = useState({
    name: "",
    email: "",
    phone: "",
    companyName: "",
    businessNumber: "",
    contactEmail: "",
    contactPhone: "",
  });
  const [passwords, setPasswords] = useState({ currentPassword: "", newPassword: "" });
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // 🔴 로드 실패를 표시하고 저장을 잠근다 (2026-07-29 감사).
  //    종전에는 try/catch 자체가 없었다. 네트워크 오류·비JSON 응답이면 프로필이
  //    **전부 빈 문자열**로 남고, 그 상태에서 이름 한 글자만 고쳐 저장하면
  //    PATCH 가 profile 전체를 보내 **사업자등록번호까지 지운다**(컴플라이언스 데이터).
  useEffect(() => {
    let isMounted = true;
    async function load() {
      try {
        const response = await fetchWithRefresh("/api/account", { credentials: "include" });
        if (!response.ok) throw new Error(String(response.status));
        const payload = (await response.json()) as {
          data?: {
            name?: string | null;
            email?: string | null;
            phone?: string | null;
            companyName?: string | null;
            businessNumber?: string | null;
            contactEmail?: string | null;
            contactPhone?: string | null;
          };
        };
        if (!payload.data) throw new Error("프로필을 불러오지 못했습니다");
        if (isMounted) {
          setProfile({
            name: payload.data.name ?? "",
            email: payload.data.email ?? "",
            phone: payload.data.phone ?? "",
            companyName: payload.data.companyName ?? "",
            businessNumber: payload.data.businessNumber ?? "",
            contactEmail: payload.data.contactEmail ?? "",
            contactPhone: payload.data.contactPhone ?? "",
          });
          setDirty(false);
        }
      } catch {
        if (isMounted) setLoadFailed(true);
      } finally {
        if (isMounted) setLoading(false);
      }
    }
    void load();
    return () => {
      isMounted = false;
    };
  }, []);

  function editProfile(patch: Partial<typeof profile>) {
    setProfile((prev) => ({ ...prev, ...patch }));
    setDirty(true);
  }

  async function saveProfile() {
    setSaving(true);
    try {
      const response = await fetchWithRefresh("/api/account", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profile),
      });
      if (response.ok) {
        setDirty(false);
        showSuccess("프로필이 저장되었습니다");
      } else {
        showError("프로필 저장에 실패했습니다");
      }
    } finally {
      setSaving(false);
    }
  }

  async function savePassword() {
    if (!passwords.currentPassword || !passwords.newPassword) {
      showError("비밀번호를 입력해주세요");
      return;
    }
    const response = await fetchWithRefresh("/api/account/password", {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(passwords),
    });
    if (response.ok) {
      showSuccess("비밀번호가 변경되었습니다");
      setPasswords({ currentPassword: "", newPassword: "" });
    } else {
      showError("비밀번호 변경에 실패했습니다");
    }
  }

  return (
    <div className="space-y-6">
      <h2 className="text-3xl font-black tracking-[-0.04em] text-foreground">계정 설정</h2>
      <Tabs defaultValue="profile">
        <TabsList>
          <TabsTrigger value="profile">프로필</TabsTrigger>
          <TabsTrigger value="password">비밀번호</TabsTrigger>
          <TabsTrigger value="business">사업자 인증</TabsTrigger>
          <TabsTrigger value="notifications">알림</TabsTrigger>
        </TabsList>
        <TabsContent value="profile" className="space-y-4">
          <Field label="이름" value={profile.name} onChange={(value) => editProfile({ name: value })} />
          <Field label="이메일" value={profile.email} onChange={() => undefined} disabled spellCheck={false} />
          <Field label="전화번호" value={profile.phone} onChange={(value) => editProfile({ phone: value })} />
          <Field label="회사명" value={profile.companyName} onChange={(value) => editProfile({ companyName: value })} />
          <Field label="사업자등록번호" value={profile.businessNumber} onChange={(value) => editProfile({ businessNumber: value })} />
          {loadFailed ? (
            <div className="rounded-lg border border-error/30 bg-error/5 p-4 text-sm text-error">
              프로필을 불러오지 못했습니다. 이 상태로 저장하면 <strong>사업자등록번호를 포함한 기존 정보가
              지워질 수 있어</strong> 저장을 잠갔습니다. 새로고침해 주세요.
            </div>
          ) : null}
          <Button onClick={() => void saveProfile()} disabled={!canSaveEditor({ loading, loadFailed, dirty, saving })}>
            {saving ? "저장 중..." : "저장"}
          </Button>
        </TabsContent>
        <TabsContent value="password" className="space-y-4">
          <Field label="현재 비밀번호" value={passwords.currentPassword} onChange={(value) => setPasswords((prev) => ({ ...prev, currentPassword: value }))} type="password" autoComplete="current-password" />
          <Field label="새 비밀번호" value={passwords.newPassword} onChange={(value) => setPasswords((prev) => ({ ...prev, newPassword: value }))} type="password" autoComplete="new-password" />
          <Button onClick={() => void savePassword()}>비밀번호 변경</Button>
        </TabsContent>
        <TabsContent value="business">
          <BusinessVerificationCard />
        </TabsContent>
        <TabsContent value="notifications">
          <NotificationPrefsCard />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Field({ label, value, onChange, type = "text", disabled = false, autoComplete, spellCheck }: { label: string; value: string; onChange: (value: string) => void; type?: string; disabled?: boolean; autoComplete?: string; spellCheck?: boolean }) {
  const id = useId();
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type={type} value={value} disabled={disabled} autoComplete={autoComplete} spellCheck={spellCheck} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}
