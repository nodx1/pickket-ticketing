import { Queue } from "bullmq";
import { getRedis } from "@/lib/redis";

/**
 * BullMQ namespace prefix.
 * v2 Celery와 완전 분리됨 (Celery는 자체 키 체계 사용, BullMQ와 겹치지 않음).
 * 그래도 멀티 테넌트/향후 분리 대비해서 prefix 박아둠.
 */
const BULLMQ_PREFIX = "go";

export function createQueue(name: string) {
  return new Queue(name, {
    connection: getRedis(),
    prefix: BULLMQ_PREFIX,
  });
}

export function createWorker<T = unknown>(
  name: string,
  processor: (job: { id?: string; name: string; data: T }) => Promise<void>,
  opts?: { concurrency?: number },
) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Worker } = require("bullmq") as { Worker: new (...args: unknown[]) => unknown };
  return new Worker(name, processor as never, {
    connection: getRedis(),
    prefix: BULLMQ_PREFIX,
    ...opts,
  });
}
