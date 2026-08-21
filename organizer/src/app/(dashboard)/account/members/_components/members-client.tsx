"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useConfirmAction } from "@/lib/hooks/useConfirmAction";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { ErrorState } from "@/components/shared/error-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { showError, showSuccess } from "@/lib/hooks/useToast";
import { useAuthStore } from "@/lib/stores/authStore";
import { USER_ROLE_LABELS } from "@/lib/constants";
import { fetchWithRefresh } from "@/lib/fetchWithAuth";
import { formatDateShortKst, formatDateTimeSecKst } from "@/lib/format";

// 초대 상태 한글 라벨 — 매핑 없으면 원문 노출(크래시 아님).
const INVITATION_STATUS_LABELS: Record<string, string> = {
  pending: "대기중",
  accepted: "수락됨",
  expired: "만료됨",
  cancelled: "취소됨",
};

interface MemberRow {
  id: string;
  name: string;
  email: string;
  role: string;
  isActive: boolean;
  lastLoginAt: string | null;
}

interface InvitationRow {
  id: string;
  name: string | null;
  email: string;
  role: string;
  status: string;
  expiresAt: string;
  createdAt: string;
}

export function MembersClient() {
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [invitations, setInvitations] = useState<InvitationRow[]>([]);
  const [form, setForm] = useState({ name: "", email: "", role: "staff" });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const currentUser = useAuthStore((s) => s.user);
  const isOwner = currentUser?.role === "owner";

  const roleOptions = useMemo(() => {
    const base = [
      { value: "admin", label: USER_ROLE_LABELS.admin },
      { value: "organizer", label: USER_ROLE_LABELS.organizer },
      { value: "staff", label: USER_ROLE_LABELS.staff },
      { value: "check_in", label: USER_ROLE_LABELS.check_in },
    ];
    if (isOwner) {
      return [{ value: "owner", label: USER_ROLE_LABELS.owner }, ...base];
    }
    return base;
  }, [isOwner]);

  const load = useCallback(async () => {
    setError(false);
    try {
      const response = await fetchWithRefresh("/api/account/members", { credentials: "include" });
      if (!response.ok) {
        throw new Error(`members load failed: ${response.status}`);
      }
      const payload = (await response.json()) as {
        data?: { members?: MemberRow[]; invitations?: InvitationRow[] };
      };
      setMembers(payload.data?.members ?? []);
      setInvitations(payload.data?.invitations ?? []);
    } catch {
      // 실패를 빈 목록으로 위장하지 않고 명시적 에러로 노출(S2).
      setError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 🔴 메일이 안 나가도 **링크로 전달할 수 있어야 한다** (2026-07-31).
   *
   * `pickket.kr` 발신 메일이 아직 설정되지 않아 `mailSent:false` 가 정상 상태다.
   * 종전엔 경고만 띄우고 끝나서, 주최자는 초대장을 만들고도 **전달할 방법이 없었다**
   * (실제로 아무도 못 받는 주소로 초대장 1건이 떠 있었다).
   * ⟹ 서버가 준 수락 링크를 화면에 남겨 직접 전달하게 한다.
   */
  const [inviteLink, setInviteLink] = useState<string | null>(null);

  function reportInviteResult(
    payload: { data?: { mailSent?: boolean; acceptUrl?: string } },
    verb: string,
  ) {
    const url = payload.data?.acceptUrl ?? null;
    if (payload.data?.mailSent === false) {
      setInviteLink(url);
      showError(
        `${verb}는 생성됐지만 이메일이 발송되지 않았습니다. 아래 링크를 직접 전달해주세요.`,
      );
    } else {
      setInviteLink(url);
      showSuccess(`${verb}했습니다`);
    }
  }

  async function copyInviteLink() {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      showSuccess("초대 링크를 복사했습니다");
    } catch {
      // 클립보드 권한이 없으면 사용자가 직접 선택해 복사한다 — 링크는 화면에 보인다.
      showError("복사에 실패했습니다. 링크를 직접 선택해 복사해주세요.");
    }
  }

  async function invite() {
    if (!form.name.trim() || !form.email.trim()) {
      showError("이름과 이메일을 입력해주세요");
      return;
    }
    setBusyId("invite");
    try {
      const response = await fetchWithRefresh("/api/account/members", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        data?: { mailSent?: boolean };
        error?: string;
      };
      if (!response.ok) {
        showError(payload.error ?? "팀 멤버를 초대하지 못했습니다");
        return;
      }
      setForm({ name: "", email: "", role: "staff" });
      await load();
      reportInviteResult(payload, "초대");
    } catch {
      showError("초대 중 오류가 발생했습니다");
    } finally {
      setBusyId(null);
    }
  }

  async function changeRole(userId: string, role: string) {
    setBusyId(userId);
    try {
      const response = await fetchWithRefresh(`/api/account/members/${userId}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        showError(payload.error ?? "멤버 역할을 변경하지 못했습니다");
        await load();
        return;
      }
      await load();
      showSuccess("역할을 변경했습니다");
    } catch {
      showError("역할 변경 중 오류가 발생했습니다");
    } finally {
      setBusyId(null);
    }
  }

  async function removeMember(userId: string) {
    setBusyId(userId);
    try {
      const response = await fetchWithRefresh(`/api/account/members/${userId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        showError(payload.error ?? "멤버를 제거하지 못했습니다");
        return;
      }
      await load();
      showSuccess("멤버를 제거했습니다");
    } catch {
      showError("멤버 제거 중 오류가 발생했습니다");
    } finally {
      setBusyId(null);
    }
  }

  async function resendInvitation(invitation: InvitationRow) {
    setBusyId(invitation.id);
    try {
      const response = await fetchWithRefresh("/api/account/members", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          invitationId: invitation.id,
          name: invitation.name ?? "팀 멤버",
          email: invitation.email,
          role: invitation.role,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        data?: { mailSent?: boolean };
        error?: string;
      };
      if (!response.ok) {
        showError(payload.error ?? "초대 재발송에 실패했습니다");
        return;
      }
      await load();
      reportInviteResult(payload, "초대 재발송");
    } catch {
      showError("초대 재발송 중 오류가 발생했습니다");
    } finally {
      setBusyId(null);
    }
  }

  // 확인 버튼 잠금 + 재진입 차단 + 실패 시 해제 (S3).
  // 종전엔 `void fn(); setTarget(null)` 라 **요청이 끝나기 전에 창이 닫혔다** —
  // 그 상태로 pending 을 넘겨봐야 보이지도 않는다. 끝난 뒤 닫도록 바꿨다.
  const removeAction = useConfirmAction(async () => {
    if (!removingId) return;
    await removeMember(removingId);
    setRemovingId(null);
  });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-black tracking-[-0.04em] text-foreground">팀 멤버</h2>
        <p className="mt-2 text-sm text-muted-foreground">역할별 운영 권한을 부여하고 초대를 관리합니다.</p>
      </div>

      <div className="grid gap-3 rounded-lg border border-border bg-card/95 p-5 lg:grid-cols-4">
        <Input placeholder="이름" value={form.name} onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))} />
        <Input type="email" inputMode="email" spellCheck={false} autoComplete="email" placeholder="이메일" value={form.email} onChange={(event) => setForm((prev) => ({ ...prev, email: event.target.value }))} />
        <Select value={form.role} onValueChange={(value) => setForm((prev) => ({ ...prev, role: value }))}>
          <SelectTrigger aria-label="초대할 역할"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="admin">{USER_ROLE_LABELS.admin}</SelectItem>
            <SelectItem value="organizer">{USER_ROLE_LABELS.organizer}</SelectItem>
            <SelectItem value="staff">{USER_ROLE_LABELS.staff}</SelectItem>
            <SelectItem value="check_in">{USER_ROLE_LABELS.check_in}</SelectItem>
          </SelectContent>
        </Select>
        <Button onClick={() => void invite()} disabled={busyId === "invite"}>
          {busyId === "invite" ? "초대 중..." : "초대하기"}
        </Button>
      </div>

      {/*
        🔴 초대 링크 — 메일이 안 나가도 전달할 수 있어야 한다.
           링크는 **수락 자격 그 자체**이므로 화면에만 두고 다른 곳으로 흘리지 않는다.
      */}
      {inviteLink ? (
        <div className="rounded-lg border border-primary/20 bg-primary/10 p-4">
          <p className="text-sm font-semibold text-foreground">초대 링크</p>
          <p className="mt-1 text-xs text-content-muted">
            이 링크를 받는 분에게 직접 전달해주세요. 7일 후 만료되며 한 번만 사용할 수 있습니다.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <input
              readOnly
              value={inviteLink}
              aria-label="초대 링크"
              className="flex-1 rounded-md border border-border bg-card px-3 py-2 text-xs text-foreground"
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button size="sm" variant="outline" onClick={() => void copyInviteLink()}>
              복사
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setInviteLink(null)}>
              닫기
            </Button>
          </div>
        </div>
      ) : null}

      {error ? (
        <ErrorState description="팀 멤버 목록을 불러오지 못했습니다." onRetry={() => void load()} />
      ) : (
      <>
      <div className="overflow-hidden rounded-lg border border-border bg-card/95">
        <div className="grid grid-cols-[1.2fr_1.4fr_1.4fr_1.3fr_1fr] gap-3 border-b border-border px-5 py-4 text-sm font-semibold text-foreground">
          <span>이름</span>
          <span>이메일</span>
          <span>역할</span>
          <span>마지막 로그인</span>
          <span>관리</span>
        </div>
        <div className="divide-y divide-border">
          {members.map((member) => (
            <div key={member.id} className="grid grid-cols-[1.2fr_1.4fr_1.4fr_1.3fr_1fr] gap-3 px-5 py-4 text-sm text-muted-foreground">
              <div>
                <p className="font-medium text-foreground">{member.name}</p>
                <p className="mt-1 text-xs">{member.isActive ? "활성" : "비활성"}</p>
              </div>
              <span>{member.email}</span>
              <div className="flex items-center gap-3">
                <Badge variant={member.role === "owner" ? "gold" : "secondary"}>{USER_ROLE_LABELS[member.role as keyof typeof USER_ROLE_LABELS] ?? member.role}</Badge>
                {/* 역할 변경은 소유자(owner) 전용 — 비-owner 에겐 조회용 배지만 노출(권한 인지 UI). */}
                {isOwner && member.role !== "owner" ? (
                  <Select value={member.role} onValueChange={(value) => void changeRole(member.id, value)}>
                    <SelectTrigger className="h-9 w-[128px]" aria-label="역할 변경"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {roleOptions.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}
              </div>
              <span>{member.lastLoginAt ? formatDateTimeSecKst(member.lastLoginAt) : "로그인 기록 없음"}</span>
              <div className="flex justify-end">
                <Button size="sm" variant="outline" disabled={busyId === member.id || member.role === "owner"} onClick={() => setRemovingId(member.id)}>
                  제거
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <h3 className="text-xl font-bold text-foreground">초대 목록</h3>
        <div className="space-y-3">
          {invitations.map((invitation) => (
            <div key={invitation.id} className="flex flex-wrap items-center justify-between gap-4 rounded-[24px] border border-border bg-card/95 px-5 py-4 text-sm text-muted-foreground">
              <div>
                <p className="font-medium text-foreground">{invitation.name ?? "이름 미입력"}</p>
                <p className="mt-1">{invitation.email}</p>
              </div>
              <div className="flex items-center gap-3">
                <Badge variant={invitation.status === "accepted" ? "success" : invitation.status === "expired" ? "warning" : "secondary"}>
                  {INVITATION_STATUS_LABELS[invitation.status] ?? invitation.status}
                </Badge>
                <span>{USER_ROLE_LABELS[invitation.role as keyof typeof USER_ROLE_LABELS] ?? invitation.role}</span>
                <span>만료 {formatDateShortKst(invitation.expiresAt)}</span>
                <Button size="sm" variant="outline" disabled={busyId === invitation.id} onClick={() => void resendInvitation(invitation)}>
                  재발송
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>
      </>
      )}

      <ConfirmDialog
        open={removingId !== null}
        title="멤버 제거"
        description="이 멤버를 팀에서 제거하시겠습니까? 이 작업은 되돌릴 수 없습니다."
        confirmText="제거"
        pending={removeAction.pending}
        onConfirm={removeAction.run}
        onOpenChange={(open) => { if (!open) setRemovingId(null); }}
      />
    </div>
  );
}
