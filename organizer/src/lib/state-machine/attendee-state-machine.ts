import type { PoolClient } from "pg";
import type { AttendeeStatus } from "@/lib/types";

const ATTENDEE_TRANSITIONS: Record<AttendeeStatus, AttendeeStatus[]> = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["checked_in", "cancelled"],
  checked_in: [],
  cancelled: [],
};

export function canTransitionAttendee(from: AttendeeStatus, to: AttendeeStatus) {
  return ATTENDEE_TRANSITIONS[from].includes(to);
}

export async function transitionAttendees(
  client: PoolClient,
  orderId: string,
  expectedFrom: AttendeeStatus,
  to: AttendeeStatus,
) {
  if (!canTransitionAttendee(expectedFrom, to)) {
    throw new Error(`참석자 상태를 ${expectedFrom}에서 ${to}로 변경할 수 없습니다`);
  }

  const result = await client.query(
    `
      UPDATE attendees
      SET status = $3, updated_at = NOW()
      WHERE order_id = $1 AND status = $2
    `,
    [orderId, expectedFrom, to],
  );

  return result.rowCount ?? 0;
}
