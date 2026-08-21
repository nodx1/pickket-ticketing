import { successResponse } from "@/lib/apiResponse";
import { withAuth } from "@/lib/auth/withAuth";

export const GET = withAuth(async (_request, { session }) => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { passwordHash, ...safeSession } = session;
  return successResponse(safeSession);
});
