/**
 * RISE Engine HTTP Client — 서킷 브레이커 포함
 */

const RISE_URL = process.env.RISE_ENGINE_URL ?? "http://localhost:8100";
const TIMEOUT = 10_000;

type CircuitState = "closed" | "open" | "half-open";
let circuitState: CircuitState = "closed";
let failureCount = 0;
let lastFailureTime = 0;
const FAILURE_THRESHOLD = 5;
const RECOVERY_TIME = 60_000; // 60초

function checkCircuit(): boolean {
  if (circuitState === "closed") return true;
  if (circuitState === "open") {
    if (Date.now() - lastFailureTime > RECOVERY_TIME) {
      circuitState = "half-open";
      return true;
    }
    return false;
  }
  return true; // half-open → 1회 시도
}

function onSuccess() {
  failureCount = 0;
  circuitState = "closed";
}

function onFailure() {
  failureCount++;
  lastFailureTime = Date.now();
  if (failureCount >= FAILURE_THRESHOLD) {
    circuitState = "open";
  }
}

async function riseRequest<T>(path: string, body: unknown): Promise<T> {
  if (!checkCircuit()) {
    throw new Error("RISE 엔진 서킷 브레이커 열림 — 잠시 후 재시도하세요");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);

  try {
    const res = await fetch(`${RISE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: "알 수 없는 오류" }));
      throw new Error((err as { detail?: string }).detail ?? `HTTP ${res.status}`);
    }

    const data = (await res.json()) as T;
    onSuccess();
    return data;
  } catch (err) {
    onFailure();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Public API ───
// DOMAIN_MODEL_STANDARD: VCG 경매는 금지어. point_lottery 만 지원.
// (riseAllocate 는 VCG 전용이라 제거됨)

export interface FanWeightResult {
  effective_weight: number;
  scores: Record<string, number>;
}

export interface LotteryResult {
  winners: string[];
  waitlist: string[];
  total_applicants: number;
  total_seats: number;
  seed_used: number;
  commitment_hash: string;
}

export async function riseFanWeight(scores: {
  loyalty: number;
  history: number;
  fanclub: number;
  behavior: number;
  freshness: number;
}): Promise<FanWeightResult> {
  return riseRequest<FanWeightResult>("/fan-weight", scores);
}

export async function riseLottery(params: {
  entries: { user_id: string; group_id?: string; group_size?: number }[];
  total_seats: number;
  seed?: number;
}): Promise<LotteryResult> {
  return riseRequest<LotteryResult>("/lottery", params);
}

export async function riseHealth(): Promise<{ status: string }> {
  const res = await fetch(`${RISE_URL}/health`, { signal: AbortSignal.timeout(3000) });
  return res.json() as Promise<{ status: string }>;
}

export function getCircuitState(): CircuitState {
  return circuitState;
}
