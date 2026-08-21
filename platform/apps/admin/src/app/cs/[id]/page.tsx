"use client";

import { use } from "react";
import TicketDetail from "../_components/TicketDetail";

export default function CSTicketDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return <TicketDetail ticketId={id} />;
}
