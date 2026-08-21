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
}

const ROLES: OrganizerRole[] = ["host", "coordinator", "sponsor"];

export function OrganizerRoleSelector({ organizers, value, onChange }: OrganizerRoleSelectorProps) {
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

  return (
    <div className="space-y-4">
      <Label>주최자 관리</Label>
      {ROLES.map((role) => {
        const entries = entriesByRole[role];
        const available = getAvailableOrganizers(role);
        const isRequired = role === "host";

        return (
          <div key={role} className="rounded-xl border border-border bg-bg-muted p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-foreground">
                {ORGANIZER_ROLE_LABELS[role]}
                {isRequired && <span className="ml-1 text-xs text-destructive">*필수</span>}
              </span>
              {available.length > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setAddingRole(addingRole === role ? null : role)}
                >
                  <Plus className="size-3" />
                  추가
                </Button>
              )}
            </div>

            {entries.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-2">
                {entries.map((entry) => (
                  <Badge
                    key={`${entry.role}-${entry.organizerId}`}
                    variant="secondary"
                    className="gap-1.5 py-1 pl-3 pr-1.5"
                  >
                    {nameMap.get(entry.organizerId) ?? "알 수 없음"}
                    <button
                      type="button"
                      onClick={() => handleRemove(entry.role, entry.organizerId)}
                      className="rounded-full p-0.5 hover:bg-bg-subtle"
                    >
                      <X className="size-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}

            {entries.length === 0 && addingRole !== role && (
              <p className="text-xs text-muted-foreground/60">
                {isRequired ? "주최자를 추가해주세요" : "없음"}
              </p>
            )}

            {addingRole === role && available.length > 0 && (
              <Select onValueChange={(id) => handleAdd(role, id)}>
                <SelectTrigger className="h-8 text-xs">
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
        );
      })}
    </div>
  );
}
