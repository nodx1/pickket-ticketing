import { redirect } from "next/navigation";

export default async function MyTicketRedirectPage({
  params,
}: {
  params: Promise<{ ticketNumber: string }>;
}) {
  const { ticketNumber } = await params;
  redirect(`/tickets/${ticketNumber}`);
}
