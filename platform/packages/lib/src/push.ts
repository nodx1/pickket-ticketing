/**
 * Web Push Registration & Management (P1-6)
 *
 * Usage:
 *   import { registerPush, unregisterPush } from "@pickket/lib/push";
 *
 *   // Register after user login
 *   const result = await registerPush();
 *   if (result.ok) console.log("Push registered");
 *
 *   // Unregister on logout
 *   await unregisterPush();
 */

import api from "./api";

// ── Types ───────────────────────────────────────────────────────────────────

interface PushResult {
  ok: boolean;
  error?: string;
}

export interface PushPreferences {
  allocation_result: boolean;
  payment_reminder: boolean;
  event_update: boolean;
  price_alert: boolean;
  marketing: boolean;
  push_enabled: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function arrayBufferToBase64(buffer: ArrayBuffer | null): string {
  if (!buffer) return "";
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function getVapidPublicKey(): Promise<string | null> {
  try {
    const res = await api.post<{ public_key: string }>("/push/vapid-key");
    return res.data.public_key;
  } catch {
    return null;
  }
}

// ── Service Worker Registration ─────────────────────────────────────────────

async function ensureServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;

  try {
    const registration = await navigator.serviceWorker.register("/sw-push.js", {
      scope: "/",
    });
    // Wait for the service worker to be ready
    await navigator.serviceWorker.ready;
    return registration;
  } catch (err) {
    console.error("[Push] Service worker registration failed:", err);
    return null;
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Register for Web Push notifications.
 *
 * 1. Requests notification permission from the browser
 * 2. Registers the push service worker
 * 3. Subscribes to push via the Push API
 * 4. Sends the subscription to the backend
 */
export async function registerPush(): Promise<PushResult> {
  // Check browser support
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    return { ok: false, error: "Push notifications not supported" };
  }

  // Request permission
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return { ok: false, error: "Notification permission denied" };
  }

  // Get VAPID key from backend
  const vapidKey = await getVapidPublicKey();
  if (!vapidKey) {
    return { ok: false, error: "Failed to get VAPID key" };
  }

  // Register service worker
  const registration = await ensureServiceWorker();
  if (!registration) {
    return { ok: false, error: "Service worker registration failed" };
  }

  try {
    // Check for existing subscription
    let subscription = await registration.pushManager.getSubscription();

    // Subscribe if not already subscribed
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });
    }

    // Extract keys
    const p256dh = arrayBufferToBase64(subscription.getKey("p256dh"));
    const auth = arrayBufferToBase64(subscription.getKey("auth"));

    // Send to backend
    await api.post("/push/subscribe", {
      endpoint: subscription.endpoint,
      p256dh,
      auth,
    });

    return { ok: true };
  } catch (err) {
    console.error("[Push] Registration failed:", err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

/**
 * Unregister from Web Push notifications.
 * Unsubscribes from the Push API and notifies the backend.
 */
export async function unregisterPush(): Promise<PushResult> {
  if (!("serviceWorker" in navigator)) {
    return { ok: false, error: "Service worker not supported" };
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();

    if (subscription) {
      // Notify backend first
      try {
        await api.delete("/push/subscribe", {
          data: { endpoint: subscription.endpoint },
        });
      } catch {
        // Backend failure is non-critical
      }

      // Unsubscribe from Push API
      await subscription.unsubscribe();
    }

    return { ok: true };
  } catch (err) {
    console.error("[Push] Unregister failed:", err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

/**
 * Get push notification preferences from the backend.
 */
export async function getPushPreferences(): Promise<PushPreferences | null> {
  try {
    const res = await api.get<PushPreferences>("/push/preferences");
    return res.data;
  } catch {
    return null;
  }
}

/**
 * Update push notification preferences.
 *
 * @param updates Partial preference updates (only include changed values)
 */
export async function updatePushPreferences(
  updates: Partial<PushPreferences>,
): Promise<PushPreferences | null> {
  try {
    const res = await api.patch<PushPreferences>("/push/preferences", updates);
    return res.data;
  } catch {
    return null;
  }
}

/**
 * Check if push notifications are currently supported and permitted.
 */
export function isPushSupported(): boolean {
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/**
 * Check current notification permission state.
 */
export function getPushPermission(): NotificationPermission | "unsupported" {
  if (!("Notification" in window)) return "unsupported";
  return Notification.permission;
}
