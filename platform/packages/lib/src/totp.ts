/**
 * TOTP QR Code Generator (client-side)
 * SafeTix pattern: 15-second rotating QR codes
 */

const INTERVAL = 15; // seconds
const DIGITS = 8;

/**
 * Compute HMAC-SHA256 TOTP code
 */
async function computeTOTP(
  seed: Uint8Array,
  timestamp?: number,
): Promise<string> {
  const time = timestamp ?? Math.floor(Date.now() / 1000);
  const counter = Math.floor(time / INTERVAL);

  // Counter to 8-byte big-endian
  const counterBuffer = new ArrayBuffer(8);
  const view = new DataView(counterBuffer);
  view.setBigUint64(0, BigInt(counter));

  // HMAC-SHA256
  const key = await crypto.subtle.importKey(
    "raw",
    seed.buffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, counterBuffer);
  const hmacResult = new Uint8Array(signature);

  // Dynamic truncation
  const offset = hmacResult[hmacResult.length - 1]! & 0x0f;
  const code =
    (((hmacResult[offset]! & 0x7f) << 24) |
      ((hmacResult[offset + 1]! & 0xff) << 16) |
      ((hmacResult[offset + 2]! & 0xff) << 8) |
      (hmacResult[offset + 3]! & 0xff)) %
    10 ** DIGITS;

  return code.toString().padStart(DIGITS, "0");
}

/**
 * Generate QR payload for ticket
 */
export async function generateQRPayload(
  ticketId: string,
  seed: Uint8Array,
  deviceHash: string,
): Promise<string> {
  const totp = await computeTOTP(seed);
  return `${ticketId}|${totp}|${deviceHash}`;
}

/**
 * Compute device fingerprint hash
 */
export async function computeDeviceHash(): Promise<string> {
  const fingerprint = [
    navigator.userAgent,
    `${screen.width}x${screen.height}`,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ].join("|");

  const encoded = new TextEncoder().encode(fingerprint);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Get seconds remaining in current TOTP window
 */
export function getSecondsRemaining(): number {
  const now = Math.floor(Date.now() / 1000);
  return INTERVAL - (now % INTERVAL);
}

/**
 * Parse hex seed string to Uint8Array
 */
export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Start auto-refreshing QR code with countdown
 * Returns cleanup function
 */
export function startQRRefresh(
  ticketId: string,
  seed: Uint8Array,
  deviceHash: string,
  onUpdate: (payload: string, secondsRemaining: number) => void,
): () => void {
  let active = true;

  const refresh = async () => {
    if (!active) return;
    const payload = await generateQRPayload(ticketId, seed, deviceHash);
    onUpdate(payload, getSecondsRemaining());
  };

  // Tick every second for countdown + regenerate at window boundary
  const tick = async () => {
    if (!active) return;
    const remaining = getSecondsRemaining();
    if (remaining === INTERVAL || remaining <= 1) {
      // Window boundary — regenerate TOTP
      await refresh();
    } else {
      // Just update countdown
      onUpdate("", remaining); // empty payload = keep previous QR, just update countdown
    }
  };

  // Initial generation
  refresh();

  const interval = setInterval(tick, 1000);

  return () => {
    active = false;
    clearInterval(interval);
  };
}
