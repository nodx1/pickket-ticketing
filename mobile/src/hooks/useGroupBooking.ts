/**
 * useGroupBooking — 그룹 예매 (Phase C.3)
 *
 * 백엔드 미구현 시 createGroupOrder/getGroupOrder는 null 반환,
 * joinGroupOrder는 { ok: false } 반환 (graceful fallback).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createGroupOrder,
  getGroupOrder,
  joinGroupOrder,
  type CreateGroupOrderInput,
  type GroupOrder,
} from "@/config/api";

export function useCreateGroupOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateGroupOrderInput) => createGroupOrder(input),
    onSuccess: (data: GroupOrder | null) => {
      if (data?.id) qc.invalidateQueries({ queryKey: ["group-order", data.id] });
    },
  });
}

export function useJoinGroupOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (groupId: string) => joinGroupOrder(groupId),
    onSuccess: (_data, groupId) => {
      qc.invalidateQueries({ queryKey: ["group-order", groupId] });
    },
  });
}

export function useGroupOrder(groupId: string | undefined) {
  return useQuery({
    queryKey: ["group-order", groupId],
    queryFn: () => getGroupOrder(groupId!),
    enabled: !!groupId,
    staleTime: 30 * 1000,
  });
}
