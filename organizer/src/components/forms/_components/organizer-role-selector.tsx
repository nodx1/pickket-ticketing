"use client";

import { Plus, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type OrganizerRole, ORGANIZER_ROLE_LABELS } from "@/lib/types";

export interface OrganizerOption {
  id: string;
  name: string;
}

export interface OrganizerEntry {
  organizerId: string;
  role: OrganizerRole;
  displayOrder: number;
}

interface OrganizerRoleSelectorProps {
  organizers: OrganizerOption[];
  value: OrganizerEntry[];
  onChange: (value: OrganizerEntry[]) => void;
  /** 보여 줄 역할. 기본은 주최·주관·후원 전부. 과업 증빙 간단 모드는 주최만. */
  roles?: OrganizerRole[];
}

const ROLES: OrganizerRole[] = ["host", "coordinator", "sponsor"];

export function OrganizerRoleSelector({ organizers, value, onChange, roles = ROLES }: OrganizerRoleSelectorProps) {
  const [addingRole, setAddingRole] = useState<OrganizerRole | null>(null);

  const entriesByRole = useMemo(() => {
    const map: Record<OrganizerRole, OrganizerEntry[]> = {
      host: [],
      coordinator: [],
      sponsor: [],
    };
    for (const entry of value) {
      map[entry.role]?.push(entry);
    }
    return map;
  }, [value]);

  const nameMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of organizers) m.set(o.id, o.name);
    return m;
  }, [organizers]);

  function handleAdd(role: OrganizerRole, organizerId: string) {
    const exists = value.some((e) => e.organizerId === organizerId && e.role === role);
    if (exists) return;
    const roleEntries = entriesByRole[role];
    const nextOrder = roleEntries.length > 0 ? Math.max(...roleEntries.map((e) => e.displayOrder)) + 1 : 0;
    onChange([...value, { organizerId, role, displayOrder: nextOrder }]);
    setAddingRole(null);
  }

  function handleRemove(role: OrganizerRole, organizerId: string) {
    onChange(value.filter((e) => !(e.organizerId === organizerId && e.role === role)));
  }

  function getAvailableOrganizers(role: OrganizerRole) {
    const used = new Set(entriesByRole[role].map((e) => e.organizerId));
    return organizers.filter((o) => !used.has(o.id));
  }

  // 주최·주관·후원을 칸 하나씩 크게 그리면 화면을 길게 차지한다 — 한 상자 안에 한 줄씩(이름 · 선택값 · 추가).
  return (
    <div className="space-y-2">
      <Label>주최자</Label>
      <div className="divide-y divide-border rounded-lg border border-border">
        {roles.map((role) => {
          const entries = entriesByRole[role];
          const available = getAvailableOrganizers(role);
          const isRequired = role === "host";

          return (
            <div key={role} className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
              <span className="w-14 shrink-0 text-sm font-medium text-foreground">
                {ORGANIZER_ROLE_LABELS[role]}
                {isRequired && <span className="ml-0.5 text-destructive" aria-label="필수">*</span>}
              </span>

              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                {entries.map((entry) => (
                  <Badge
                    key={`${entry.role}-${entry.organizerId}`}
                    variant="secondary"
                    className="gap-1.5 py-1 pl-3 pr-1.5"
                  >
                    {nameMap.get(entry.organizerId) ?? "알 수 없음"}
                    <button
                      type="button"
                      aria-label={`${nameMap.get(entry.organizerId) ?? "주최자"} 빼기`}
                      onClick={() => handleRemove(entry.role, entry.organizerId)}
                      className="rounded-full p-0.5 hover:bg-bg-subtle"
                    >
                      <X className="size-3" />
                    </button>
                  </Badge>
                ))}

                {entries.length === 0 && addingRole !== role && (
                  <span className={isRequired ? "text-xs text-destructive" : "text-xs text-muted-foreground/70"}>
                    {isRequired ? "주최자를 추가해주세요" : "없음"}
                  </span>
                )}

                {addingRole === role && available.length > 0 && (
                  <Select onValueChange={(id) => handleAdd(role, id)}>
                    <SelectTrigger className="h-8 w-56 text-xs">
                      <SelectValue placeholder="주최자를 선택해주세요" />
                    </SelectTrigger>
                    <SelectContent>
                      {available.map((org) => (
                        <SelectItem key={org.id} value={org.id}>
                          {org.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>

              {available.length > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setAddingRole(addingRole === role ? null : role)}
                >
                  {addingRole === role ? <X className="size-3" /> : <Plus className="size-3" />}
                  {addingRole === role ? "닫기" : "추가"}
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
