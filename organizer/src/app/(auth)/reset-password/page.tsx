import { ResetPasswordForm } from "@/app/(auth)/reset-password/reset-password-form";

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const resolvedSearchParams = await searchParams;
  return <ResetPasswordForm token={resolvedSearchParams.token ?? ""} />;
}
