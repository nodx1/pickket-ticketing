/**
 * Circuit Breaker — 외부 서비스 장애 cascading failure 방지
 *
 * 5회 연속 실패 → OPEN (30초간 즉시 실패)
 * 30초 후 → HALF_OPEN (1건만 시도)
 * 성공 → CLOSED (정상)
 * 실패 → OPEN 다시
 */
import { logger } from "@/lib/logger";

type State = "CLOSED" | "OPEN" | "HALF_OPEN";

export class CircuitBreaker {
  private failures = 0;
  private state: State = "CLOSED";
  private openedAt = 0;
  private readonly threshold: number;
  private readonly resetTimeMs: number;
  private readonly name: string;

  constructor(opts: { name: string; threshold?: number; resetTimeMs?: number }) {
    this.name = opts.name;
    this.threshold = opts.threshold ?? 5;
    this.resetTimeMs = opts.resetTimeMs ?? 30_000;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "OPEN") {
      if (Date.now() - this.openedAt > this.resetTimeMs) {
        this.state = "HALF_OPEN";
        logger.info("Circuit breaker HALF_OPEN", { name: this.name });
      } else {
        throw new Error(`Circuit breaker OPEN: ${this.name}`);
      }
    }

    try {
      const result = await fn();
      if (this.state === "HALF_OPEN") {
        logger.info("Circuit breaker CLOSED (복구)", { name: this.name });
      }
      this.failures = 0;
      this.state = "CLOSED";
      return result;
    } catch (err) {
      this.failures++;
      if (this.failures >= this.threshold) {
        this.state = "OPEN";
        this.openedAt = Date.now();
        logger.warn("Circuit breaker OPEN", {
          name: this.name,
          failures: this.failures,
          resetInMs: this.resetTimeMs,
        });
      }
      throw err;
    }
  }

  getState(): State {
    return this.state;
  }
}
