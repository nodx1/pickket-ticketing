"use client";

import { Building2, Pencil, Plus, Trash2 } from "lucide-react";
import { useConfirmAction } from "@/lib/hooks/useConfirmAction";
import { useEffect, useMemo, useState } from "react";
import { OrganizerForm, type OrganizerFormValue } from "@/components/forms/organizer-form";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { EmptyState } from "@/components/shared/empty-state";
import { SearchInput } from "@/components/shared/search-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { showError, showSuccess } from "@/lib/hooks/useToast";
import { fetchWithRefresh } from "@/lib/fetchWithAuth";

interface OrganizerItem extends OrganizerFormValue {
  id: string;
  is_published?: boolean;
}

const emptyOrganizer: OrganizerFormValue = {
  name: "",
  description: "",
  email: "",
  phone: "",
  logoUrl: "",
  contactPublic: false,
};

export default function OrganizersPage() {
  const [items, setItems] = useState<OrganizerItem[]>([]);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<OrganizerItem | null>(null);
  const [deleting, setDeleting] = useState<OrganizerItem | null>(null);
  const [unlinkTarget, setUnlinkTarget] = useState<{ item: OrganizerItem; count: number } | null>(null);

  async function fetchOrganizers() {
    try {
      const response = await fetchWithRefresh("/api/organizers", { credentials: "include" });
      if (!response.ok) {
        showError("주최자 목록을 불러오지 못했습니다");
        return [];
      }
      const payload = (await response.json()) as { data?: OrganizerItem[] };
      return payload.data ?? [];
    } catch (err: unknown) {
      console.warn("주최자 목록 로드 오류:", err instanceof Error ? err.message : err);
      showError("주최자 목록을 불러오지 못했습니다");
      return [];
    }
  }

  useEffect(() => {
    let isMounted = true;

    async function loadOrganizers() {
      const nextItems = await fetchOrganizers();
      if (isMounted) {
        setItems(nextItems);
      }
    }

    void loadOrganizers();

    return () => {
      isMounted = false;
    };
  }, []);

  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) {
      return items;
    }
    return items.filter((item) =>
      [item.name, item.email, item.phone]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(keyword)),
    );
  }, [items, search]);

  async function handleSubmit(value: OrganizerFormValue) {
    const url = editing ? `/api/organizers/${editing.id}` : "/api/organizers";
    const method = editing ? "PATCH" : "POST";

    const response = await fetchWithRefresh(url, {
      method,
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });

    if (!response.ok) {
      const payload = (await response.json()) as { error?: string };
      throw new Error(payload.error ?? "주최자 저장에 실패했습니다");
    }

    setItems(await fetchOrganizers());
    setOpen(false);
    showSuccess(editing ? "주최자가 수정되었습니다" : "주최자가 생성되었습니다");
  }

  async function handleDelete() {
    if (!deleting) {
      return;
    }

    const target = deleting;
    const response = await fetchWithRefresh(`/api/organizers/${target.id}`, {
      method: "DELETE",
      credentials: "include",
    });
    const payload = (await response.json()) as {
      data?: { deleted?: boolean; needsUnlink?: boolean; linkedEventCount?: number };
      error?: string;
    };

    if (!response.ok) {
      showError(payload.error ?? "주최자 삭제에 실패했습니다");
      return;
    }

    // 이벤트에 연결됨 → 연결 해제 확인 다이얼로그로 전환.
    if (payload.data?.needsUnlink) {
      setDeleting(null);
      setUnlinkTarget({ item: target, count: payload.data.linkedEventCount ?? 0 });
      return;
    }

    setDeleting(null);
    setItems(await fetchOrganizers());
    showSuccess("주최자가 삭제되었습니다");
  }

  async function handleUnlinkDelete() {
    if (!unlinkTarget) {
      return;
    }
    const response = await fetchWithRefresh(`/api/organizers/${unlinkTarget.item.id}?unlink=true`, {
      method: "DELETE",
      credentials: "include",
    });
    setUnlinkTarget(null);
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      showError(payload.error ?? "주최자 삭제에 실패했습니다");
      return;
    }
    setItems(await fetchOrganizers());
    showSuccess("연결을 해제하고 주최자를 삭제했습니다");
  }

  // 확인 버튼 잠금 + 재진입 차단 + 실패 시 해제 (S3). `handleDelete` 이 창을 닫는다.
  const deleteAction = useConfirmAction(() => handleDelete());
  // 확인 버튼 잠금 + 재진입 차단 + 실패 시 해제 (S3). `handleUnlinkDelete` 이 창을 닫는다.
  const unlinkAction = useConfirmAction(() => handleUnlinkDelete());

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-sm text-muted-foreground">관리 메뉴</p>
          <h2 className="mt-2 text-3xl font-black tracking-[-0.04em] text-foreground">
            주최자 관리
          </h2>
        </div>
        <Button onClick={() => { setEditing(null); setOpen(true); }}>
          <Plus className="size-4" />
          주최자 만들기
        </Button>
      </div>

      <SearchInput onSearch={setSearch} placeholder="주최자명, 연락처 검색" />

      {filtered.length === 0 ? (
        <EmptyState
          title="등록된 주최자가 없습니다"
          description="새 주최자를 만들고 이벤트 운영 구조를 먼저 정리해보세요."
          actionLabel="주최자 만들기"
          icon={Building2}
          onAction={() => { setEditing(null); setOpen(true); }}
        />
      ) : (
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((item) => (
            <Card key={item.id}>
              <CardHeader className="flex-row items-start justify-between gap-3">
                <CardTitle>{item.name}</CardTitle>
                <Badge variant={item.contactPublic ? "success" : "secondary"}>
                  {item.contactPublic ? "연락처 공개" : "연락처 비공개"}
                </Badge>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm leading-7 text-muted-foreground">
                  {item.description || "설명이 아직 등록되지 않았습니다."}
                </p>
                <div className="space-y-1 text-sm text-muted-foreground">
                  <p>{item.email || "이메일 미등록"}</p>
                  <p>{item.phone || "전화번호 미등록"}</p>
                </div>
                <div className="flex gap-3">
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={() => {
                      setEditing(item);
                      setOpen(true);
                    }}
                  >
                    <Pencil className="size-4" />
                    수정
                  </Button>
                  <Button variant="outline" className="flex-1" onClick={() => setDeleting(item)}>
                    <Trash2 className="size-4" />
                    삭제
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <OrganizerForm
        open={open}
        value={editing ?? emptyOrganizer}
        title={editing ? "주최자 수정" : "주최자 생성"}
        onOpenChange={setOpen}
        onSubmit={handleSubmit}
      />

      <ConfirmDialog
        open={Boolean(deleting)}
        title="주최자 삭제"
        description="이 주최자를 삭제하면 복구할 수 없습니다."
        confirmText="삭제하기"
        pending={deleteAction.pending}
        onConfirm={deleteAction.run}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            setDeleting(null);
          }
        }}
      />

      <ConfirmDialog
        open={Boolean(unlinkTarget)}
        title="연결 해제 후 삭제"
        description={`이 주최자는 ${unlinkTarget?.count ?? 0}개 이벤트에 연결되어 있습니다. 연결을 해제하고 삭제하면 해당 이벤트의 주최자 표기가 비워집니다. 계속하시겠습니까?`}
        confirmText="연결 해제하고 삭제"
        pending={unlinkAction.pending}
        onConfirm={unlinkAction.run}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            setUnlinkTarget(null);
          }
        }}
      />
    </div>
  );
}
