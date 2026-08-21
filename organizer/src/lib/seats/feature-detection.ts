/**
 * 좌석 시스템 기능 감지 — WebGL2/Pointer/BroadcastChannel 등
 */

export function supportsWebGL2(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const c = document.createElement("canvas");
    const ctx = c.getContext("webgl2");
    return ctx !== null;
  } catch {
    return false;
  }
}

export function supportsWebGL(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const c = document.createElement("canvas");
    const ctx = c.getContext("webgl") ?? c.getContext("experimental-webgl");
    return ctx !== null;
  } catch {
    return false;
  }
}

export function supportsPointerEvents(): boolean {
  if (typeof window === "undefined") return false;
  return "PointerEvent" in window;
}

export function supportsBroadcastChannel(): boolean {
  if (typeof window === "undefined") return false;
  return "BroadcastChannel" in window;
}

export function supportsVibration(): boolean {
  if (typeof navigator === "undefined") return false;
  return "vibrate" in navigator;
}
