/**
 * Retired Level2 lottery endpoint.
 *
 * Lottery applications, results, winner orders and waitlist promotion are
 * owned by v2. Keeping the former go bids table writable would recreate a
 * second lottery SoT, so both reads and writes fail explicitly instead of
 * returning stale go-local state.
 */
import { NextResponse, type NextRequest } from "next/server";

function retired(request: NextRequest) {
  const origin = request.headers.get("origin");
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Behavior-Token, X-Behavior-Session",
    Vary: "Origin",
  };
  if (origin) headers["Access-Control-Allow-Origin"] = origin;
  return NextResponse.json(
    {
      error:
        "이 추첨 API는 종료되었습니다. v2 /api/v1/events/{eventId}/tiers/{tierId}/lottery 경로를 이용해주세요.",
    },
    { status: 410, headers },
  );
}

export async function OPTIONS(request: NextRequest) {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, X-Behavior-Token, X-Behavior-Session",
      Vary: "Origin",
      ...(request.headers.get("origin")
        ? { "Access-Control-Allow-Origin": request.headers.get("origin")! }
        : {}),
    },
  });
}

export async function GET(request: NextRequest) {
  return retired(request);
}

export async function POST(request: NextRequest) {
  return retired(request);
}
