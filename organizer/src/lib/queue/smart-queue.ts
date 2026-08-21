import crypto from "node:crypto";
import {
  consumeQueueAdmissionV2,
  getQueueStatusV2,
  joinQueueV2,
  leaveQueueV2,
} from "@/lib/v2/commerce-client";

export interface QueuePosition {
  position: number;
  status: "active" | "waiting" | "expired";
  estimatedWait: number;
  totalWaiting: number;
  accessToken: string | null;
}

const SESSION_TOKEN_PATTERN =
  /^q_([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})_([0-9a-f-]{36})_([a-f0-9]{32})$/i;

function queueTokenSecret(): string {
  const secret =
    process.env.GO_WEBHOOK_SECRET ?? process.env.V2_EVENT_SYNC_SECRET;
  if (!secret) {
    throw new Error("Queue session token secret is not configured");
  }
  return secret;
}

function signQueueScope(
  goEventId: string,
  v2EventId: string,
  nonce: string,
): string {
  return crypto
    .createHmac("sha256", queueTokenSecret())
    .update(`${goEventId}.${v2EventId}.${nonce}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Carries the canonical v2 event anchor through browser polling without a go
 * DB lookup on every status request. The nonce preserves 122 bits of entropy;
 * an HMAC binds both event IDs so a public caller cannot forge arbitrary v2
 * Redis namespaces.
 */
export function createQueueSessionToken(
  goEventId: string,
  v2EventId: string,
): string {
  const nonce = crypto.randomUUID();
  const signature = signQueueScope(goEventId, v2EventId, nonce);
  return `q_${v2EventId}_${nonce}_${signature}`;
}

export function resolveQueueEventFromSessionToken(
  sessionToken: string,
  goEventId: string,
): string | null {
  const match = SESSION_TOKEN_PATTERN.exec(sessionToken);
  if (!match) {
    return null;
  }
  const [, v2EventId, nonce, signature] = match;
  if (!v2EventId || !nonce || !signature) {
    return null;
  }
  const expected = signQueueScope(goEventId, v2EventId, nonce);
  const actualBytes = Buffer.from(signature, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  if (
    actualBytes.length !== expectedBytes.length ||
    !crypto.timingSafeEqual(actualBytes, expectedBytes)
  ) {
    return null;
  }
  return v2EventId;
}

/**
 * Compatibility facade for organizer queue callers.
 *
 * Level2 B2-2 removes all go Redis and queue_sessions writes. ``eventId`` is
 * the canonical v2 event ID resolved by the public route, while the
 * cryptographically random session token remains anonymous.
 */
export async function joinQueue(
  eventId: string,
  maxConcurrent: number,
  sessionToken: string = crypto.randomUUID(),
): Promise<QueuePosition & { sessionToken: string }> {
  const result = await joinQueueV2(eventId, sessionToken, maxConcurrent, {
    idempotencyKey: `queue-join:${eventId}:${sessionToken}`,
  });
  return {
    sessionToken,
    position: result.position,
    status: result.is_active ? "active" : "waiting",
    estimatedWait: result.estimated_wait_seconds,
    totalWaiting: result.total_waiting,
    accessToken: result.token,
  };
}

export async function getQueuePosition(
  eventId: string,
  sessionToken: string,
): Promise<QueuePosition> {
  const result = await getQueueStatusV2(eventId, sessionToken);
  return {
    position: result.position,
    status: result.is_active
      ? "active"
      : result.position < 0
        ? "expired"
        : "waiting",
    estimatedWait: result.estimated_wait_seconds,
    totalWaiting: result.total_waiting,
    accessToken: result.token,
  };
}

export async function isSessionActive(
  eventId: string,
  sessionToken: string,
): Promise<boolean> {
  return (await getQueueStatusV2(eventId, sessionToken)).is_active;
}

export async function releaseSession(
  eventId: string,
  sessionToken: string,
): Promise<void> {
  await leaveQueueV2(eventId, sessionToken, {
    idempotencyKey: `queue-leave:${eventId}:${sessionToken}`,
  });
}

export async function consumeQueueAdmission(
  goEventId: string,
  sessionToken: string,
  accessToken: string,
  purchaseKey: string,
): Promise<{ accepted: boolean; replayed: boolean }> {
  const v2EventId = resolveQueueEventFromSessionToken(sessionToken, goEventId);
  if (!v2EventId) {
    throw new Error("Invalid queue session token");
  }
  return consumeQueueAdmissionV2(
    v2EventId,
    {
      session_token: sessionToken,
      access_token: accessToken,
      purchase_key: purchaseKey,
    },
    { idempotencyKey: `queue-consume:${v2EventId}:${purchaseKey}` },
  );
}
