/**
 * 티켓 관련 React Query 훅
 */
import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "@/hooks/useAuth";
import {
  getMyTickets,
  getTicket,
  getTicketQr,
  type Ticket,
} from "@/config/api";
import { queryKeys } from "@/config/queryKeys";

export function useMyTickets(skip = 0, limit = 50) {
  const isGuest = useAuthStore((s) => s.isGuest);
  return useQuery({
    queryKey: queryKeys.tickets.my(skip, limit),
    queryFn: () => getMyTickets(skip, limit),
    // AUDIT 2026-04-20 §5 P0: guests must not fetch user-scoped data
    enabled: !isGuest,
  });
}

export function useTicket(ticketId: string) {
  return useQuery({
    queryKey: queryKeys.tickets.detail(ticketId),
    queryFn: () => getTicket(ticketId),
    enabled: !!ticketId,
  });
}

export function useTicketQr(ticketId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.tickets.qr(ticketId),
    queryFn: () => getTicketQr(ticketId),
    enabled: !!ticketId && enabled,
    staleTime: 5_000,
    refetchInterval: false,
  });
}

/** 티켓을 "예정" / "지난" 으로 분류 */
export function groupTicketsByDate(tickets: Ticket[]) {
  const now = new Date();
  const upcoming: Ticket[] = [];
  const past: Ticket[] = [];

  for (const ticket of tickets) {
    const eventDate = ticket.event_date ? new Date(ticket.event_date) : null;
    if (eventDate && eventDate < now) {
      past.push(ticket);
    } else {
      upcoming.push(ticket);
    }
  }

  return { upcoming, past };
}
